#!/usr/bin/env node
// fmv — the Fusion Manage live viewer CLI (spec 0002). A thin client over the local server.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { CliError, call, isRunning, serverInfo } from '../src/client.js';
import { configDir } from '../src/config.js';
import { openInBrowser } from '../src/open.js';
import { apsChecklist, checkReport, runSetup } from '../src/setup.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_MAIN = path.resolve(here, '..', 'src', 'serverMain.js');
const BOOLEAN_FLAGS = new Set(['json', 'check', 'no-open', 'unsafe-eval', 'no-wait', 'force', 'all', 'off', 'on', 'flip', 'no-focus', 'legend', 'help', 'dry-run', 'show', 'undo', 'no-revisions']);

// ------------------------------------------------------------------------------------------------
// Argument parsing
// ------------------------------------------------------------------------------------------------
export function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      let key = a.slice(2);
      let value;
      const eq = key.indexOf('=');
      if (eq >= 0) {
        value = key.slice(eq + 1);
        key = key.slice(0, eq);
      } else if (BOOLEAN_FLAGS.has(key)) value = true;
      else if (i + 1 < argv.length) value = argv[++i];
      else throw new CliError('INVALID_ARGUMENT', `--${key} needs a value.`);
      if (flags[key] !== undefined) flags[key] = [].concat(flags[key], value);
      else flags[key] = value;
    } else positionals.push(a);
  }
  return { positionals, flags };
}

/** --data '{"a":1}' or --data @file.json */
function readData(value, name = '--data') {
  if (value === undefined) return undefined;
  const text = String(value).startsWith('@') ? fs.readFileSync(String(value).slice(1), 'utf8') : String(value);
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError('INVALID_ARGUMENT', `${name} must be JSON (or @file.json).`);
  }
}

/**
 * Normalise an FM path typed on the command line. Git Bash on Windows (the shell Claude Code uses
 * there) rewrites arguments starting with "/" into Windows paths, so "/api/v3/workspaces" arrives as
 * "C:/Program Files/Git/api/v3/workspaces". Undo that, and accept the path without its leading slash.
 * The server still enforces the real guard.
 */
export function normaliseFmPath(p) {
  let s = String(p);
  const mangled = /^[A-Za-z]:[\\/](?:.*[\\/])?(api[\\/]v[23][\\/].*)$/.exec(s);
  if (mangled) s = '/' + mangled[1].replace(/\\/g, '/');
  else if (/^api\/v[23]\//.test(s)) s = '/' + s;
  return s;
}

function last(v) {
  return Array.isArray(v) ? v[v.length - 1] : v;
}

/** Build a targets object from --dbid / --name / --prop / --all / --targets. */
export function targetsFromFlags(flags) {
  if (flags.targets !== undefined) return readData(last(flags.targets), '--targets');
  if (flags.all) return { all: true };
  if (flags.dbid !== undefined) return { dbids: [].concat(flags.dbid).flatMap((s) => String(s).split(',')).filter(Boolean).map(Number) };
  if (flags.name !== undefined) return { name: String(last(flags.name)) };
  if (flags.prop !== undefined) {
    const s = String(last(flags.prop));
    const eq = s.indexOf('=');
    if (eq < 1) throw new CliError('INVALID_ARGUMENT', '--prop must look like "Property Name=value" (comma-separate several values).');
    return { prop: { name: s.slice(0, eq).trim(), values: s.slice(eq + 1).split(',').map((x) => x.trim()).filter(Boolean) } };
  }
  return undefined;
}

const VIEW_ALIASES = {
  'clear-color': 'clearColor',
  selection: 'getSelection',
  state: 'getState',
  props: 'getProperties',
  properties: 'getProperties',
  'property-names': 'propertyNames',
};

export function viewArgs(command, positionals, flags) {
  const base = flags.data !== undefined ? readData(last(flags.data)) : {};
  const args = { ...base };
  const t = targetsFromFlags(flags);
  if (t) args.targets = t;
  switch (command) {
    case 'load':
      if (flags.urn) args.urn = String(last(flags.urn));
      if (flags.ws) args.ws = String(last(flags.ws));
      if (flags.item) args.item = String(last(flags.item));
      if (flags.attachment) args.attachment = String(last(flags.attachment));
      if (flags.label) args.label = String(last(flags.label));
      if (!args.urn && !(args.ws && args.item)) throw new CliError('INVALID_ARGUMENT', 'load needs --ws and --item (and optionally --attachment), or --urn.');
      break;
    case 'color':
      if (flags.color) args.color = String(last(flags.color));
      if (flags.label) args.label = String(last(flags.label));
      if (flags.legend) args.legend = true;
      break;
    case 'ghost':
      args.on = !flags.off;
      break;
    case 'section':
      if (flags.off || positionals[0] === 'off') args.off = true;
      else {
        args.plane = flags.plane ?? positionals[0];
        if (flags.offset !== undefined) args.offset = last(flags.offset);
        if (flags.flip) args.flip = true;
      }
      break;
    case 'explode':
      args.scale = flags.scale ?? positionals[0];
      break;
    case 'camera':
      if (flags.eye || flags.target) {
        args.eye = last(flags.eye);
        args.target = last(flags.target);
      } else args.view = positionals.join(' ') || flags.view;
      break;
    case 'screenshot':
      if (flags.width) args.width = last(flags.width);
      if (flags.height) args.height = last(flags.height);
      break;
    case 'getProperties':
      if (flags.properties) args.properties = String(last(flags.properties)).split(',').map((s) => s.trim());
      if (flags.limit) args.limit = last(flags.limit);
      break;
    case 'eval':
      args.code = flags.code !== undefined ? String(last(flags.code)) : positionals.join(' ');
      break;
  }
  return args;
}

// ------------------------------------------------------------------------------------------------
// Output
// ------------------------------------------------------------------------------------------------
let JSON_OUT = false;

function out(value) {
  if (typeof value === 'string' && !JSON_OUT) process.stdout.write(value.endsWith('\n') ? value : value + '\n');
  else process.stdout.write(JSON.stringify(value, null, JSON_OUT ? 0 : 2) + '\n');
}

function fail(e) {
  const error = { code: e.code || 'ERROR', message: e.message, hint: e.hint };
  if (e.detail) error.detail = e.detail;
  if (e.attachments) error.attachments = e.attachments;
  if (e.fmStatus) error.fmStatus = e.fmStatus;
  if (e.missing) error.missing = e.missing;
  if (e.problems) error.problems = e.problems;
  if (JSON_OUT) process.stdout.write(JSON.stringify({ ok: false, error }) + '\n');
  else {
    process.stderr.write(`Error [${error.code}]: ${error.message}\n`);
    if (error.hint) process.stderr.write(`Hint: ${error.hint}\n`);
    if (error.detail) process.stderr.write(`Detail: ${error.detail}\n`);
    if (error.attachments) process.stderr.write(`Attachments: ${JSON.stringify(error.attachments, null, 2)}\n`);
  }
  process.exitCode = 1;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function safeOutPath(name, flags) {
  const target = path.resolve(process.cwd(), name);
  if (fs.existsSync(target) && !flags.force) throw new CliError('FILE_EXISTS', `${target} already exists.`, 'Pass --force to overwrite, or choose another name.');
  return target;
}

// ------------------------------------------------------------------------------------------------
// Commands
// ------------------------------------------------------------------------------------------------
/** Start the background server if needed. Returns { status, alreadyRunning }. Prints nothing. */
async function startServer({ unsafeEval = false } = {}) {
  const info = serverInfo();
  if (info.errors.length) {
    throw new CliError('CONFIG_INVALID', `Config is incomplete (${info.errors.map((e) => e.key).join(', ')}).`, 'Run `fmv setup` in your own terminal (in Claude Code: `! fmv setup`).');
  }
  if (await isRunning()) return { status: await call('GET', '/api/status'), alreadyRunning: true };
  const env = { ...process.env };
  if (unsafeEval) env.FMV_UNSAFE_EVAL = 'true';
  else delete env.FMV_UNSAFE_EVAL;
  const child = spawn(process.execPath, [SERVER_MAIN], { detached: true, stdio: 'ignore', windowsHide: true, env });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (await isRunning()) return { status: await call('GET', '/api/status'), alreadyRunning: false };
  }
  const log = path.join(configDir(), 'server.log');
  const tail = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').slice(-3).join('\n') : '';
  throw new CliError('START_FAILED', 'The viewer server did not start.', tail ? `Last log lines:\n${tail}` : `See ${log}.`);
}

async function cmdStart(flags) {
  const { status: s, alreadyRunning } = await startServer({ unsafeEval: Boolean(flags['unsafe-eval']) });
  if (!flags['no-open'] && !s.viewerConnected) openInBrowser(s.viewerUrl);
  if (JSON_OUT) return out({ ...s, alreadyRunning });
  out(`${alreadyRunning ? 'Already running' : 'Viewer running'} at ${s.viewerUrl}\n${s.signedIn ? 'Signed in.' : 'Not signed in yet — run: fmv login'}`);
}

async function ensureRunning() {
  if (!(await isRunning())) await startServer();
}

async function cmdLogin(flags) {
  await ensureRunning();
  const { url } = await call('POST', '/api/login');
  const opened = openInBrowser(url);
  if (!JSON_OUT) process.stdout.write(opened ? 'Opened your browser to sign in with Autodesk…\n' : `Open this link to sign in:\n${url}\n`);
  if (flags['no-wait']) return out(JSON_OUT ? { url, waiting: false } : 'Finish signing in in the browser, then run: fmv status');
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    await sleep(1500);
    const s = await call('GET', '/api/status');
    if (s.signedIn) return out(JSON_OUT ? { signedIn: true } : `Signed in to ${s.tenant}.`);
  }
  throw new CliError('AUTH_TIMEOUT', 'Sign-in was not completed within 5 minutes.', 'Run `fmv login` again.');
}

async function cmdStatus() {
  const info = serverInfo();
  if (!(await isRunning())) {
    if (JSON_OUT) return out({ running: false, configOk: info.errors.length === 0, configFile: info.file });
    return out(`Not running. Config: ${info.errors.length ? 'incomplete — run fmv setup' : 'ok'} (${info.file})\nStart with: fmv start`);
  }
  const s = await call('GET', '/api/status');
  if (JSON_OUT) return out({ running: true, ...s });
  return out(
    [
      `Running      ${s.viewerUrl}  (v${s.version})`,
      `Tenant       ${s.tenant}  (${s.fmBaseUrl})`,
      `Signed in    ${s.signedIn ? 'yes' : 'no — run fmv login'}`,
      `Viewer tab   ${s.viewerConnected ? 'connected' : 'not open — run fmv open'}`,
      `Model        ${s.model ? `${s.model.label}${s.model.item ? ` (ws ${s.model.ws}, item ${s.model.item}, attachment ${s.model.attachment})` : ''}` : 'none'}`,
      ...(s.unsafeEval ? ['WARNING      unsafe eval is enabled'] : []),
    ].join('\n'),
  );
}


/** High-level FM operations (spec 0004): one verified command instead of hand-built requests. */
async function fmOp(sub, p, flags) {
  const op = (name, args, timeoutMs) => call('POST', '/api/fm/op', { op: name, args }, { timeoutMs });
  const need = (v, usage) => {
    if (v === undefined || v === '') throw new CliError('INVALID_ARGUMENT', `Usage: fmv fm ${usage}`);
    return v;
  };
  const dryRun = Boolean(flags['dry-run']);
  const fields = () => {
    const f = readData(last(flags.fields), '--fields');
    if (f === undefined) throw new CliError('INVALID_ARGUMENT', '--fields is required: a JSON object of field → value (or @file.json).');
    return f;
  };
  switch (sub) {
    case 'find':
      return op('find', { text: need(p.join(' '), 'find "<text>" [--ws <workspace>] [--limit n]'), ws: last(flags.ws), limit: last(flags.limit) });
    case 'workspaces':
      return op('workspaces', { filter: p.join(' ') });
    case 'describe':
      return op('describe', { ws: need(p[0], 'describe <workspace>') });
    case 'options':
      return op('options', { ws: need(p[0], 'options <workspace> <field> [--filter text]'), field: need(p[1], 'options <workspace> <field> [--filter text]'), filter: last(flags.filter) });
    case 'item':
      return op('item', { ws: need(p[0], 'item <workspace> <item>'), item: need(p[1], 'item <workspace> <item>') });
    case 'bom': {
      const r = await op('bom', { ws: need(p[0], 'bom <workspace> <item> [--depth n] [--show]'), item: need(p[1], 'bom <workspace> <item> [--depth n] [--show]'), depth: last(flags.depth) });
      if (flags.show) {
        await call('POST', '/api/panel', { panel: 'bom', data: r.panel, title: flags.title ? String(last(flags.title)) : `BOM — ${r.rows[0].number} ${r.rows[0].title}`, focus: true });
        r.shown = true;
      }
      delete r.panel;
      return r;
    }
    case 'related': {
      const scan = [].concat(flags.scan || []).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);
      return op('related', { ws: need(p[0], 'related <workspace> <item> [--scan <ws,ws>] [--depth n]'), item: need(p[1], 'related <workspace> <item> [--scan <ws,ws>]'), depth: last(flags.depth), scan, revisions: !flags['no-revisions'] }, 900_000);
    }
    case 'create':
      return op('create', { ws: need(p[0], 'create <workspace> --fields <json|@file> [--dry-run]'), fields: fields(), dryRun });
    case 'update':
      return op('update', { ws: need(p[0], 'update <workspace> <item> --fields <json|@file> [--dry-run]'), item: need(p[1], 'update <workspace> <item> --fields <json|@file>'), fields: fields(), dryRun });
    case 'archive':
      return op('archive', { ws: need(p[0], 'archive <workspace> <item> [--undo]'), item: need(p[1], 'archive <workspace> <item> [--undo]'), undo: Boolean(flags.undo) });
    case 'transitions':
      return op('transitions', { ws: need(p[0], 'transitions <workspace> <item>'), item: need(p[1], 'transitions <workspace> <item>') });
    case 'transition':
      return op('transition', { ws: need(p[0], 'transition <workspace> <item> "<name>" [--comment text] [--dry-run]'), item: need(p[1], 'transition <workspace> <item> "<name>"'), transition: need(p.slice(2).join(' '), 'transition <workspace> <item> "<name>"'), comment: flags.comment ? String(last(flags.comment)) : undefined, dryRun });
    case 'affected': {
      const [action, ws, item, ...rest] = p;
      const usage = 'affected list|add|remove|transitions|set <workspace> <record> [<itemWs>:<item> …] [--transition name]';
      need(ws, usage);
      need(item, usage);
      if (action === 'list') return op('affected-list', { ws, item });
      if (action === 'add') return op('affected-add', { ws, item, items: rest, dryRun });
      if (action === 'remove') return op('affected-remove', { ws, item, items: rest });
      if (action === 'transitions') return op('affected-transitions', { ws, item, affected: need(rest[0], usage) });
      if (action === 'set') return op('affected-set', { ws, item, affected: need(rest[0], usage), transition: need(last(flags.transition), usage), dryRun });
      throw new CliError('INVALID_ARGUMENT', `Usage: fmv fm ${usage}`);
    }
    default:
      return undefined;
  }
}

async function cmdFm(positionals, flags) {
  const sub = positionals[0];
  if (!sub) throw new CliError('INVALID_ARGUMENT', 'Usage: fmv fm <METHOD> <path> | fmv fm attachments <ws> <item> | fmv fm download <ws> <item> <attachment> [outfile]');
  await ensureRunning(flags);
  const FM_OPS = ['find', 'workspaces', 'describe', 'options', 'item', 'bom', 'related', 'create', 'update', 'archive', 'transitions', 'transition', 'affected'];
  if (FM_OPS.includes(sub)) return out(await fmOp(sub, positionals.slice(1), flags));
  if (sub === 'attachments') {
    const [, ws, item] = positionals;
    return out(await call('POST', '/api/fm/attachments', { ws, item }));
  }
  if (sub === 'download') {
    const [, ws, item, attachment, outName] = positionals;
    if (!ws || !item || !attachment) throw new CliError('INVALID_ARGUMENT', 'Usage: fmv fm download <ws> <item> <attachment> [outfile] [--force]');
    const resp = await call('POST', '/api/fm/download', { ws, item, attachment }, { raw: true });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      const e = data.error || {};
      throw new CliError(e.code || 'DOWNLOAD_FAILED', e.message || `Download failed (HTTP ${resp.status}).`, e.hint);
    }
    const suggested = path.basename(decodeURIComponent(resp.headers.get('x-fmv-file-name') || `attachment-${attachment}`)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    const target = safeOutPath(outName || suggested, flags);
    await pipeline(Readable.fromWeb(resp.body), fs.createWriteStream(target));
    return out(JSON_OUT ? { file: target, bytes: fs.statSync(target).size } : `Saved ${target} (${fs.statSync(target).size} bytes)`);
  }
  const method = sub.toUpperCase();
  const p = positionals[1];
  if (!p) throw new CliError('INVALID_ARGUMENT', 'Usage: fmv fm <METHOD> <path> [--data json|@file] [--accept type] [--query key=value]');
  const query = {};
  for (const q of [].concat(flags.query || [])) {
    const eq = String(q).indexOf('=');
    if (eq < 1) throw new CliError('INVALID_ARGUMENT', '--query must look like key=value.');
    const k = String(q).slice(0, eq);
    const v = String(q).slice(eq + 1);
    query[k] = query[k] === undefined ? v : [].concat(query[k], v);
  }
  const r = await call('POST', '/api/fm', {
    method,
    path: normaliseFmPath(p),
    query: Object.keys(query).length ? query : undefined,
    body: readData(last(flags.data)),
    accept: flags.accept ? String(last(flags.accept)) : undefined,
    contentType: flags['content-type'] ? String(last(flags['content-type'])) : undefined,
  });
  out(r);
  if (r.status >= 400) process.exitCode = 2;
}

async function cmdView(positionals, flags) {
  const raw = positionals[0];
  if (!raw) throw new CliError('INVALID_ARGUMENT', 'Usage: fmv view <command> [options]. Try: fmv help');
  const command = VIEW_ALIASES[raw] || raw;
  if (command === 'screenshot') return cmdScreenshot(flags);
  const args = viewArgs(command, positionals.slice(1), flags);
  await ensureRunning(flags);
  const timeoutMs = flags.timeout ? Number(last(flags.timeout)) * 1000 : undefined;
  out(await call('POST', '/api/view', { command, args, timeoutMs }));
}

async function cmdScreenshot(flags) {
  await ensureRunning(flags);
  const body = {};
  if (flags.width) body.width = Number(last(flags.width));
  if (flags.height) body.height = Number(last(flags.height));
  const r = await call('POST', '/api/screenshot', body);
  const target = safeOutPath(flags.out ? String(last(flags.out)) : `fmv-screenshot-${timestamp()}.png`, flags);
  fs.writeFileSync(target, Buffer.from(r.png, 'base64'));
  out(JSON_OUT ? { file: target, width: r.width, height: r.height } : `Saved ${target} (${r.width}×${r.height})`);
}

async function cmdPanel(positionals, flags) {
  const panel = positionals[0];
  if (!panel) throw new CliError('INVALID_ARGUMENT', 'Usage: fmv panel bom|table|markdown|card --data json|@file [--title t] | fmv panel clear [panel]');
  await ensureRunning(flags);
  if (panel === 'clear') return out(await call('POST', '/api/panel/clear', { panel: positionals[1] }));
  let data = readData(last(flags.data));
  if (panel === 'markdown' && data === undefined) {
    const text = flags.text !== undefined ? String(last(flags.text)) : flags.file ? fs.readFileSync(String(last(flags.file)), 'utf8') : positionals.slice(1).join(' ');
    data = { text };
  }
  if (data === undefined) throw new CliError('INVALID_ARGUMENT', `fmv panel ${panel} needs --data json or --data @file.json.`);
  out(await call('POST', '/api/panel', { panel, data, title: flags.title ? String(last(flags.title)) : undefined, focus: !flags['no-focus'] }));
}

async function cmdEvents(flags) {
  await ensureRunning(flags);
  const since = Number(last(flags.since) || 0);
  const wait = Number(last(flags.wait) || 0);
  out(await call('GET', `/api/events?since=${since}&wait=${wait}`, undefined, { timeoutMs: (wait + 15) * 1000 }));
}

const HELP = `fmv — Fusion Manage live viewer

Setup and server
  fmv setup [--check]              Write or check ~/.fusion-manage-live-viewer/.env
  fmv start [--no-open]            Start the local server and open the viewer
  fmv stop | status | open
  fmv login [--no-wait] | logout   Sign in with Autodesk (PKCE)

Fusion Manage (add --dry-run to any write to preview it)
  fmv fm find "<text>" [--ws id]   Find a record by name or number
  fmv fm workspaces ["filter"]     Workspace IDs and names
  fmv fm item <ws> <item>          A record's state, fields and link
  fmv fm bom <ws> <item> [--depth n] [--show]
  fmv fm related <ws> <item> [--scan ws,ws]   Changes and records tied to an item and its BOM
  fmv fm describe <ws>             Required and writable fields, options, transitions
  fmv fm options <ws> <field> [--filter text]
  fmv fm create <ws> --fields json|@file
  fmv fm update <ws> <item> --fields json|@file
  fmv fm transitions <ws> <item>
  fmv fm transition <ws> <item> "<name>" [--comment text]
  fmv fm affected list|add|remove|transitions|set <ws> <record> [<ws>:<item> …] [--transition name]
  fmv fm archive <ws> <item> [--undo]
  fmv fm attachments <ws> <item>
  fmv fm download <ws> <item> <attachment> [outfile] [--force]
  fmv fm GET|POST|PATCH|DELETE /api/v3/…  [--data json|@file] [--accept type] [--query k=v]

Viewer (parts: --dbid 1,2 | --name "Bolt*" | --prop "Part Number=A,B" | --all)
  fmv view load --ws 57 --item 17364 [--attachment 831]   (or --urn <urn>)
  fmv view isolate|hide|show|select|fit <parts>
  fmv view color --color #e8a33d <parts> [--label text]   (or --data @groups.json)
  fmv view clear-color | reset | ghost [--off]
  fmv view section x|y|z [--offset -1..1] [--flip] | section off
  fmv view explode 0..1
  fmv view camera home|front|back|left|right|top|bottom|iso | --eye x,y,z --target x,y,z
  fmv view state | selection | props <parts> [--properties a,b] | property-names
  fmv screenshot [--out file.png]

Panels and feedback
  fmv panel bom|table|card --data @file.json [--title t] [--no-focus]
  fmv panel markdown --text "## Done" | --file notes.md
  fmv panel clear [panel]
  fmv note "message"               Add a line to the activity log
  fmv events [--since id] [--wait seconds]

Add --json for compact machine-readable output.`;

export async function main(argv) {
  const { positionals, flags } = parseArgs(argv);
  JSON_OUT = Boolean(flags.json);
  const [cmd, ...rest] = positionals;
  try {
    switch (cmd) {
      case undefined:
      case 'help':
        return out(HELP);
      case 'setup': {
        const r = flags.check ? checkReport() : await runSetup(flags);
        out(JSON_OUT ? { ok: r.ok, text: r.text } : r.text);
        if (!r.ok) process.exitCode = 1;
        return;
      }
      case 'checklist': {
        const info = serverInfo();
        return out(apsChecklist(info.config));
      }
      case 'start':
        return await cmdStart(flags);
      case 'stop':
        if (!(await isRunning())) return out(JSON_OUT ? { running: false } : 'Not running.');
        await call('POST', '/api/shutdown');
        return out(JSON_OUT ? { stopped: true } : 'Stopped.');
      case 'status':
        return await cmdStatus();
      case 'open': {
        await ensureRunning(flags);
        const s = await call('GET', '/api/status');
        openInBrowser(s.viewerUrl);
        return out(JSON_OUT ? { url: s.viewerUrl } : `Opened ${s.viewerUrl}`);
      }
      case 'login':
        return await cmdLogin(flags);
      case 'logout':
        await call('POST', '/api/logout');
        return out(JSON_OUT ? { signedIn: false } : 'Signed out.');
      case 'token':
        return out(await call('GET', '/api/token'));
      case 'fm':
        return await cmdFm(rest, flags);
      case 'view':
        return await cmdView(rest, flags);
      case 'screenshot':
        return await cmdScreenshot(flags);
      case 'panel':
        return await cmdPanel(rest, flags);
      case 'note':
        await ensureRunning(flags);
        return out(await call('POST', '/api/log', { message: rest.join(' ') || String(last(flags.text) || '') }));
      case 'events':
        return await cmdEvents(flags);
      default:
        throw new CliError('INVALID_ARGUMENT', `Unknown command "${cmd}".`, 'Run `fmv help`.');
    }
  } catch (e) {
    fail(e);
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main(process.argv.slice(2));
