// The local server (spec 0002): serves the viewer UI, owns sign-in and the FM client, relays typed
// commands to the browser over Server-Sent Events and collects results and events back.
// Binds to 127.0.0.1 only.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Auth, AuthError } from './auth.js';
import { CommandError, validatePanel, validateViewCommand } from './commands.js';
import { configDir, loadConfig } from './config.js';
import { FmClient, FmError, requireId } from './fm.js';
import { FmOps, OPS } from './fmOps.js';
import { ensurePrivateDir } from './privateFiles.js';
import { PAGE_COOKIE, contentSecurityPolicy, hostAllowed, loadOrCreateSecret, parseCookies, redact, safeEqual, sameOrigin } from './security.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const UI_DIR = path.resolve(here, '..', 'ui');
export const VERSION = JSON.parse(fs.readFileSync(path.resolve(here, '..', 'package.json'), 'utf8')).version;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

const API_BODY_LIMIT = 20 * 1024 * 1024;
const UI_BODY_LIMIT = 40 * 1024 * 1024; // screenshots come back as data URLs
const ACTIVITY_MAX = 300;
const EVENTS_MAX = 500;

export class ApiError extends Error {
  constructor(code, message, hint, status = 400, extra = {}) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.status = status;
    Object.assign(this, extra);
  }
}

class ConfigError extends Error {
  constructor(errors, file) {
    super(`Config problems in ${file}: ${errors.map((e) => `${e.key}: ${e.message}`).join(' ')}`);
    this.code = 'CONFIG_INVALID';
    this.errors = errors;
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new ApiError('PAYLOAD_TOO_LARGE', 'Request body is too large.', undefined, 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req, limit) {
  const text = await readBody(req, limit);
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new ApiError('INVALID_JSON', 'Request body must be a JSON object.');
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function toErrorPayload(e) {
  if (e instanceof ApiError || e instanceof FmError || e instanceof AuthError || e instanceof CommandError) {
    const error = { code: e.code || 'ERROR', message: e.message, hint: e.hint };
    if (e.detail) error.detail = e.detail;
    if (e.attachments) error.attachments = e.attachments;
    if (e.missing) error.missing = e.missing;
    if (e.problems) error.problems = e.problems;
    let status;
    if (e.code === 'AUTH_REQUIRED' || e.code === 'FM_CLIENT_NOT_ALLOWED' || e.code?.startsWith('AUTH_')) status = 401;
    else if (e instanceof FmError) {
      if (e.status) error.fmStatus = e.status;
      status = e.code?.startsWith('FM_') || e.code === 'NOT_FOUND' || e.code === 'TIMEOUT' ? 502 : 400;
    } else status = e.status && e.status >= 400 && e.status < 600 ? e.status : 400;
    return { status, error };
  }
  return { status: 500, error: { code: 'INTERNAL', message: redact(e?.message || String(e)), hint: 'See the server log in the config directory.' } };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function messagePage(title, body, ok) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f5f5f5;color:#3c3c3c}
main{background:#fff;border:1px solid #d9d9d9;border-radius:4px;padding:32px 40px;max-width:520px}
h1{font-size:20px;font-weight:600;margin:0 0 8px;color:${ok ? '#2c7a3a' : '#b3261e'}}a{color:#006eaf}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p><p><a href="/">Open the viewer</a></p></main></body></html>`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Build the server. Call `.listen()` on the result to start it.
 * @param {{ env?: NodeJS.ProcessEnv, logger?: (line: string) => void }} [opts]
 */
export function createFmvServer({ env = process.env, logger = () => {} } = {}) {
  const dir = configDir(env);
  ensurePrivateDir(dir);
  const loaded = loadConfig(env);
  if (loaded.errors.length) throw new ConfigError(loaded.errors, loaded.file);
  const config = loaded.config;
  const secret = loadOrCreateSecret(dir);
  const pageToken = crypto.randomBytes(24).toString('hex');
  const unsafeEval = env.FMV_UNSAFE_EVAL === 'true';

  const activity = [];
  const events = [];
  let eventSeq = 0;
  const eventWaiters = new Set();
  const clients = new Map(); // clientId -> res
  let activeClient = null;
  const pending = new Map(); // commandId -> { resolve, reject, timer }
  let commandSeq = 0;
  let model = null;
  let shuttingDown = false;

  function broadcast(msg) {
    const line = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of clients.values()) res.write(line);
  }

  function log(entry) {
    const e = { ...entry, at: new Date().toISOString() };
    if (e.message) e.message = redact(e.message);
    activity.push(e);
    if (activity.length > ACTIVITY_MAX) activity.shift();
    broadcast({ type: 'log', entry: e });
    logger(redact(JSON.stringify(e)));
  }

  const auth = new Auth(config, dir, log);
  const fm = new FmClient(config, auth, log);
  const ops = new FmOps(fm, config, log);

  function pushEvent(type, data) {
    const e = { id: ++eventSeq, type, data, at: new Date().toISOString() };
    events.push(e);
    if (events.length > EVENTS_MAX) events.shift();
    for (const w of eventWaiters) w();
    return e;
  }

  function sendCommand(command, args, timeoutMs = 15_000) {
    const res = activeClient && clients.get(activeClient);
    if (!res) {
      return Promise.reject(
        new ApiError('VIEWER_NOT_CONNECTED', 'The viewer is not open in a browser.', `Open ${config.origin}/ (or run \`fmv open\`), then retry.`, 409),
      );
    }
    const id = ++commandSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new ApiError('TIMEOUT', `The viewer did not finish "${command}" within ${Math.round(timeoutMs / 1000)} s.`, 'Check the browser tab, then retry.', 504));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer, command });
      res.write(`data: ${JSON.stringify({ type: 'command', id, command, args })}\n\n`);
    });
  }

  async function runView(command, args, timeoutMs) {
    const started = Date.now();
    try {
      const result = await sendCommand(command, args, timeoutMs);
      log({ kind: 'view', command, ok: true, ms: Date.now() - started, message: result?.summary });
      return result;
    } catch (e) {
      log({ kind: 'view', command, ok: false, ms: Date.now() - started, message: e.message });
      throw e;
    }
  }

  /** Resolve an FM attachment to FM's own derivative, polling while FM translates it. */
  async function loadFromFm({ ws, item, att, timeoutMs = 180_000 }) {
    requireId(ws, 'workspace');
    requireId(item, 'item');
    let attachment = null;
    if (!att) {
      const list = await fm.listAttachments(ws, item);
      attachment = list.find((a) => a.isCad) || null;
      if (!attachment) {
        throw new ApiError('NOT_FOUND', 'This item has no CAD attachment to view.', 'Pass --attachment with an ID from the list, or attach a model in Fusion Manage.', 404, {
          attachments: list.map(({ id, name, extension }) => ({ id, name, extension })),
        });
      }
      att = attachment.id;
    }
    requireId(att, 'attachment');
    const deadline = Date.now() + timeoutMs;
    let v = await fm.getViewable(ws, item, att);
    let announced = false;
    while (v.status !== 'DONE') {
      if (!announced) {
        log({ kind: 'info', message: `Fusion Manage is preparing ${v.fileName || 'the file'} for viewing (status ${v.status || 'unknown'})…` });
        broadcast({ type: 'progress', message: `Fusion Manage is preparing ${v.fileName || 'the model'} for viewing…` });
        announced = true;
      }
      if (Date.now() > deadline) {
        throw new ApiError('NOT_TRANSLATED_YET', `Fusion Manage is still preparing this file (status ${v.status || 'unknown'}).`, 'Large models can take a few minutes. Run the same load command again shortly.', 409);
      }
      await sleep(5000);
      v = await fm.getViewable(ws, item, att);
    }
    if (!v.urn) throw new ApiError('NOT_VIEWABLE', 'Fusion Manage returned no viewable for this attachment.', 'Only CAD and drawing files can be shown in the 3D viewer.', 422);
    if (v.viewerName && v.viewerName !== 'LMV') {
      throw new ApiError('NOT_VIEWABLE', `This file opens in Fusion Manage's document viewer (${v.viewerName}), not the 3D viewer.`, 'Pick a CAD or drawing attachment.', 422);
    }
    return { urn: v.urn, label: v.fileName || attachment?.name || `Attachment ${att}`, source: { ws: String(ws), item: String(item), attachment: String(att), fileName: v.fileName || attachment?.name || '' } };
  }

  // ---------------------------------------------------------------------------------------------
  // API routes (CLI / curl, require X-FMV-Secret)
  // ---------------------------------------------------------------------------------------------
  const api = {
    'GET /api/status': async () => ({
      version: VERSION,
      tenant: config.tenant,
      fmBaseUrl: config.fmBaseUrl,
      viewerUrl: `${config.origin}/`,
      signedIn: auth.signedIn,
      viewerConnected: clients.size > 0,
      model,
      unsafeEval,
    }),
    'POST /api/login': async () => ({ url: auth.beginLogin() }),
    'POST /api/logout': async () => {
      await auth.logout();
      broadcast({ type: 'auth', signedIn: false });
      return { signedIn: false };
    },
    'GET /api/token': async () => {
      if (!config.allowTokenExport) {
        throw new ApiError('TOKEN_EXPORT_DISABLED', 'Token export is off.', 'Use `fmv fm …` instead. To allow raw tokens, set FMV_ALLOW_TOKEN_EXPORT=true in your .env.', 403);
      }
      const t = await auth.getAccessToken();
      return { access_token: t.token, expires_in: Math.round((t.expiresAt - Date.now()) / 1000) };
    },
    'POST /api/fm': async (body) => fm.request({ method: body.method, path: body.path, query: body.query, body: body.body, accept: body.accept, contentType: body.contentType }),
    'POST /api/fm/op': async (body) => {
      const def = Object.hasOwn(OPS, String(body.op)) ? OPS[String(body.op)] : null;
      if (!def) throw new ApiError('INVALID_ARGUMENT', `Unknown operation "${body.op}".`, `Operations: ${Object.keys(OPS).join(', ')}.`);
      const args = body.args && typeof body.args === 'object' ? body.args : {};
      const result = await ops[def.fn](args);
      if (def.write && !args.dryRun) log({ kind: 'write', message: `${body.op} ${args.ws ?? ''}${args.item ? '/' + args.item : ''}`.trim() });
      // Keys starting with _ are internal (API links used between steps).
      return Object.fromEntries(Object.entries(result).filter(([k]) => !k.startsWith('_')));
    },
    'POST /api/fm/attachments': async (body) => ({ attachments: await fm.listAttachments(body.ws, body.item) }),
    'POST /api/view': async (body) => {
      const command = String(body.command || '');
      const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 0, 0), 600_000) || undefined;
      let args = body.args || {};
      if (command === 'load' && !args.urn) {
        const resolved = await loadFromFm({ ws: args.ws, item: args.item, att: args.attachment, timeoutMs: timeoutMs ?? 180_000 });
        args = { urn: resolved.urn, label: resolved.label };
        const clean = validateViewCommand('load', args);
        const result = await runView('load', clean, 180_000);
        model = { ...resolved.source, label: resolved.label, urn: resolved.urn, loadedAt: new Date().toISOString() };
        return { ...result, source: resolved.source };
      }
      if (command === 'eval') {
        if (!unsafeEval) throw new ApiError('INVALID_COMMAND', 'eval is disabled.', 'Start the server with `fmv start --unsafe-eval` to allow it.', 403);
        if (typeof args.code !== 'string' || args.code.length > 100_000) throw new ApiError('INVALID_COMMAND', 'eval needs code as text.');
        return runView('eval', { code: args.code }, timeoutMs ?? 30_000);
      }
      const clean = validateViewCommand(command, args);
      const result = await runView(command, clean, timeoutMs ?? (command === 'load' ? 180_000 : 30_000));
      if (command === 'load') model = { urn: clean.urn, label: clean.label || '', loadedAt: new Date().toISOString() };
      return result;
    },
    'POST /api/panel': async (body) => {
      const payload = validatePanel(String(body.panel || ''), body.data, { title: body.title, focus: body.focus });
      const result = await sendCommand('panel', payload, 15_000);
      log({ kind: 'panel', panel: payload.panel, message: payload.title || payload.panel });
      return result;
    },
    'POST /api/panel/clear': async (body) => sendCommand('clearPanels', { panel: body.panel ? String(body.panel) : undefined }, 15_000),
    'POST /api/log': async (body) => {
      const message = String(body.message || '').slice(0, 2000);
      if (!message) throw new ApiError('INVALID_ARGUMENT', 'message is required.');
      log({ kind: 'note', message });
      return { logged: true };
    },
    'POST /api/screenshot': async (body) => {
      const clean = validateViewCommand('screenshot', body || {});
      const r = await runView('screenshot', clean, 30_000);
      const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(r?.dataUrl || '');
      if (!m) throw new ApiError('SCREENSHOT_FAILED', 'The viewer returned no image.', 'Make sure a model is loaded and the tab is visible.', 500);
      return { png: m[1], width: r.width, height: r.height };
    },
    'POST /api/shutdown': async () => {
      setTimeout(() => close(), 50);
      return { stopping: true };
    },
  };

  async function handleEvents(url) {
    const since = Number(url.searchParams.get('since') || 0);
    const wait = Math.min(Math.max(Number(url.searchParams.get('wait') || 0), 0), 120);
    const pick = () => events.filter((e) => e.id > since);
    let found = pick();
    if (found.length === 0 && wait > 0) {
      await new Promise((resolve) => {
        const done = () => {
          clearTimeout(t);
          eventWaiters.delete(done);
          resolve();
        };
        const t = setTimeout(done, wait * 1000);
        eventWaiters.add(done);
      });
      found = pick();
    }
    return { events: found, last: eventSeq };
  }

  async function handleDownload(req, res) {
    const body = await readJson(req, API_BODY_LIMIT);
    const ws = requireId(body.ws, 'workspace');
    const item = requireId(body.item, 'item');
    const att = requireId(body.attachment, 'attachment');
    let fileName = '';
    try {
      const list = await fm.listAttachments(ws, item);
      fileName = list.find((a) => a.id === att)?.name || '';
    } catch {}
    const fileUrl = await fm.getDownloadUrl(ws, item, att);
    // Pre-signed S3 URL: no Authorization, no custom Accept, never rebuilt.
    const started = Date.now();
    const s3 = await fetch(fileUrl, { redirect: 'follow' });
    if (!s3.ok || !s3.body) throw new ApiError('DOWNLOAD_FAILED', `The file download failed (HTTP ${s3.status}).`, 'Retry; the download link may have expired.', 502);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-FMV-File-Name': encodeURIComponent(fileName || `attachment-${att}`),
      ...(s3.headers.get('content-length') ? { 'Content-Length': s3.headers.get('content-length') } : {}),
    });
    await new Promise((resolve, reject) => {
      Readable.fromWeb(s3.body).on('error', reject).pipe(res).on('finish', resolve).on('error', reject);
    });
    log({ kind: 'fm', method: 'GET', path: `download ${fileName || att}`, status: 200, ms: Date.now() - started });
  }

  // ---------------------------------------------------------------------------------------------
  // Browser routes (cookie-bound to the page we served)
  // ---------------------------------------------------------------------------------------------
  function pageAuthorized(req) {
    return safeEqual(parseCookies(req.headers.cookie)[PAGE_COOKIE] || '', pageToken);
  }

  function serveIndex(res) {
    const html = fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8');
    res.writeHead(200, {
      'Content-Type': MIME['.html'],
      'Cache-Control': 'no-store',
      'Content-Security-Policy': contentSecurityPolicy({ unsafeEval }),
      'Set-Cookie': `${PAGE_COOKIE}=${pageToken}; HttpOnly; SameSite=Strict; Path=/`,
    });
    res.end(html);
  }

  function serveStatic(res, pathname) {
    const rel = decodeURIComponent(pathname.slice('/ui/'.length));
    const file = path.resolve(UI_DIR, rel);
    if (!file.startsWith(UI_DIR + path.sep) || !MIME[path.extname(file)] || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)], 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }

  function openStream(req, res) {
    const id = crypto.randomUUID();
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`retry: 2000\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'hello', tenant: config.tenant, fmBaseUrl: config.fmBaseUrl, signedIn: auth.signedIn, version: VERSION, unsafeEval, activity })}\n\n`);
    clients.set(id, res);
    activeClient = id;
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(id);
      if (activeClient === id) activeClient = [...clients.keys()].pop() || null;
    });
  }

  async function handleUi(req, res, url) {
    if (!pageAuthorized(req)) return sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'Reload the viewer page.' } });
    if (req.method !== 'GET' && !sameOrigin(req, config.port)) return sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'Cross-origin request refused.' } });
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /ui/stream') return openStream(req, res);
    if (route === 'GET /ui/token') {
      if (!sameOrigin(req, config.port)) return sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'Cross-origin request refused.' } });
      try {
        const t = await auth.getAccessToken();
        return sendJson(res, 200, { ok: true, result: { access_token: t.token, expires_in: Math.round((t.expiresAt - Date.now()) / 1000) } });
      } catch (e) {
        const { status, error } = toErrorPayload(e);
        return sendJson(res, status, { ok: false, error });
      }
    }
    if (route === 'POST /ui/result') {
      const body = await readJson(req, UI_BODY_LIMIT);
      const p = pending.get(Number(body.id));
      if (p) {
        pending.delete(Number(body.id));
        clearTimeout(p.timer);
        if (body.ok) p.resolve(body.result ?? null);
        else {
          const err = body.error || {};
          p.reject(new ApiError(String(err.code || 'VIEWER_ERROR').slice(0, 60), String(err.message || 'The viewer reported an error.').slice(0, 1000), err.hint ? String(err.hint).slice(0, 1000) : undefined, 422));
        }
      }
      return sendJson(res, 200, { ok: true });
    }
    if (route === 'POST /ui/event') {
      const body = await readJson(req, 2 * 1024 * 1024);
      const type = String(body.type || '').slice(0, 40);
      if (!/^[a-zA-Z]+$/.test(type)) return sendJson(res, 400, { ok: false, error: { code: 'INVALID_EVENT', message: 'Bad event type.' } });
      const e = pushEvent(type, body.data ?? null);
      if (type === 'modelLoaded' && model) model.parts = body.data?.parts;
      return sendJson(res, 200, { ok: true, result: { id: e.id } });
    }
    if (route === 'POST /ui/login') return sendJson(res, 200, { ok: true, result: { url: auth.beginLogin() } });
    res.writeHead(404);
    res.end();
  }

  async function handleCallback(res, url) {
    try {
      await auth.completeLogin({
        code: url.searchParams.get('code'),
        state: url.searchParams.get('state'),
        error: url.searchParams.get('error'),
        errorDescription: url.searchParams.get('error_description'),
      });
      broadcast({ type: 'auth', signedIn: true });
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
      res.end(messagePage('Signed in', `You're signed in to ${config.tenant}. You can close this tab and go back to Claude Code.`, true));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
      res.end(messagePage('Sign-in failed', `${e.message} ${e.hint || ''}`, false));
    }
  }

  async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    if (!hostAllowed(req.headers.host, config.port)) {
      res.writeHead(421, { 'Content-Type': 'text/plain' });
      res.end('Wrong host');
      return;
    }
    const url = new URL(req.url, config.origin);
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return serveIndex(res);
      if (req.method === 'GET' && url.pathname === '/favicon.ico') {
        res.writeHead(204);
        return res.end();
      }
      if (req.method === 'GET' && url.pathname === '/callback') return await handleCallback(res, url);
      if (url.pathname.startsWith('/ui/') && ['stream', 'token', 'result', 'event', 'login'].includes(url.pathname.slice(4))) return await handleUi(req, res, url);
      if (req.method === 'GET' && url.pathname.startsWith('/ui/')) return serveStatic(res, url.pathname);

      if (url.pathname.startsWith('/api/')) {
        // A custom header can't be sent cross-origin without a CORS preflight, which we never answer.
        if (!safeEqual(String(req.headers['x-fmv-secret'] || ''), secret)) {
          return sendJson(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Missing or wrong X-FMV-Secret.', hint: 'Use the fmv CLI, which sends it for you.' } });
        }
        if (req.method === 'POST' && req.headers.origin) {
          return sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'Browser requests to /api are refused.' } });
        }
        if (req.method === 'POST' && url.pathname === '/api/fm/download') return await handleDownload(req, res);
        if (req.method === 'GET' && url.pathname === '/api/events') return sendJson(res, 200, { ok: true, result: await handleEvents(url) });
        const fn = api[`${req.method} ${url.pathname}`];
        if (!fn) return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `No route ${req.method} ${url.pathname}.` } });
        const body = req.method === 'POST' ? await readJson(req, API_BODY_LIMIT) : {};
        const result = await fn(body);
        return sendJson(res, 200, { ok: true, result });
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    } catch (e) {
      const { status, error } = toErrorPayload(e);
      if (status >= 500 && error.code === 'INTERNAL') logger(`error: ${redact(e?.stack || e)}`);
      if (!res.headersSent) sendJson(res, status, { ok: false, error });
      else res.destroy();
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res);
  });

  function close() {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new ApiError('SHUTTING_DOWN', 'The server is stopping.'));
    }
    for (const res of clients.values()) res.end();
    server.close();
    server.closeAllConnections?.();
  }

  function listen() {
    return new Promise((resolve, reject) => {
      server.once('error', (e) => {
        if (e.code === 'EADDRINUSE') {
          reject(new ApiError('PORT_IN_USE', `Port ${config.port} is already in use.`, `Stop whatever uses it, or set FMV_PORT in your .env and add http://localhost:<port>/callback to your APS app.`));
        } else reject(e);
      });
      server.listen(config.port, '127.0.0.1', () => resolve(server.address()));
    });
  }

  return { server, listen, close, config, dir };
}
