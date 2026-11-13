// Integration: the real server against a stub APS + FM, with a simulated browser tab.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createFmvServer } from '../src/server.js';

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

let stub;
let stubPort;
let app;
let port;
let dir;
let secret;
const seen = { tokenRequests: [], fmAuth: [] };

before(async () => {
  stubPort = await freePort();
  port = await freePort();
  stub = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${stubPort}`);
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = (status, v) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(v));
      };
      if (url.pathname === '/authentication/v2/token') {
        const p = new URLSearchParams(body);
        seen.tokenRequests.push(Object.fromEntries(p));
        const n = seen.tokenRequests.length;
        return json(200, { access_token: `at-${n}`, refresh_token: `rt-${n}`, expires_in: 3600 });
      }
      if (url.pathname.startsWith('/api/v3/')) seen.fmAuth.push(req.headers.authorization);
      if (url.pathname === '/api/v3/workspaces') return json(200, { items: [{ title: 'Items' }] });
      if (url.pathname === '/api/v3/workspaces/57/items/1/attachments') {
        assert.equal(req.headers.accept, 'application/vnd.autodesk.plm.attachments.bulk+json');
        return json(200, { attachments: [{ id: 3, name: 'spec.pdf' }, { id: 9, name: 'Gear.ipt' }] });
      }
      if (url.pathname === '/api/v3/workspaces/57/items/1/attachments/9') {
        if (req.headers.accept === 'application/vnd.autodesk.plm.attachment.viewable+json') return json(200, { fileUrn: 'dXJuOnRlc3Q', status: 'DONE', viewerName: 'LMV', fileName: 'Gear.ipt' });
        return json(200, { fileUrl: `http://127.0.0.1:${stubPort}/s3/gear` });
      }
      if (url.pathname === '/s3/gear') {
        assert.equal(req.headers.authorization, undefined);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        return res.end('GEARBYTES');
      }
      json(404, { error: 'nope' });
    });
  });
  await new Promise((r) => stub.listen(stubPort, '127.0.0.1', r));

  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmv-test-'));
  const env = {
    FMV_CONFIG_DIR: dir,
    APS_CLIENT_ID: 'testclient1234567890abcd',
    FM_TENANT: 'demo',
    FMV_PORT: String(port),
    FM_BASE_URL: `http://127.0.0.1:${stubPort}`,
    FMV_APS_BASE: `http://127.0.0.1:${stubPort}`,
  };
  app = createFmvServer({ env });
  await app.listen();
  secret = fs.readFileSync(path.join(dir, 'secret'), 'utf8').trim();
});

after(() => {
  app?.close();
  stub?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const base = () => `http://127.0.0.1:${port}`;
async function api(method, p, body, headers = {}) {
  const r = await fetch(base() + p, {
    method,
    headers: { 'X-FMV-Secret': secret, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json() };
}

test('API requires the secret and a loopback host', async () => {
  const r = await fetch(base() + '/api/status');
  assert.equal(r.status, 401);
  const wrongHost = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/api/status', headers: { Host: `evil.example:${port}`, 'X-FMV-Secret': secret } }, (res) => resolve(res.statusCode));
  });
  assert.equal(wrongHost, 421);
  const browser = await api('POST', '/api/logout', {}, { Origin: 'https://evil.example' });
  assert.equal(browser.status, 403);
});

test('FM calls need a sign-in first', async () => {
  const s = await api('GET', '/api/status');
  assert.equal(s.data.result.signedIn, false);
  const r = await api('POST', '/api/fm', { method: 'GET', path: '/api/v3/workspaces' });
  assert.equal(r.status, 401);
  assert.equal(r.data.error.code, 'AUTH_REQUIRED');
});

test('PKCE sign-in through /callback, then FM calls carry the token', async () => {
  const { data } = await api('POST', '/api/login');
  const authorize = new URL(data.result.url);
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorize.searchParams.get('redirect_uri'), `http://localhost:${port}/callback`);
  const state = authorize.searchParams.get('state');

  const bad = await fetch(`${base()}/callback?code=x&state=wrong`);
  assert.equal(bad.status, 400);

  const cb = await fetch(`${base()}/callback?code=the-code&state=${state}`);
  assert.equal(cb.status, 200);
  const exchange = seen.tokenRequests.at(-1);
  assert.equal(exchange.grant_type, 'authorization_code');
  assert.equal(exchange.code, 'the-code');
  assert.ok(exchange.code_verifier.length >= 43);
  assert.equal(exchange.client_secret, undefined);

  const replay = await fetch(`${base()}/callback?code=the-code&state=${state}`);
  assert.equal(replay.status, 400, 'state is single use');

  const session = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
  assert.equal(session.refreshToken, 'rt-1');

  const fm = await api('POST', '/api/fm', { method: 'GET', path: '/api/v3/workspaces' });
  assert.equal(fm.status, 200);
  assert.equal(fm.data.result.status, 200);
  assert.deepEqual(fm.data.result.body, { items: [{ title: 'Items' }] });
  assert.equal(seen.fmAuth.at(-1), 'Bearer at-1');
  assert.ok(!JSON.stringify(fm.data).includes('at-1'), 'token never returned');
});

test('FM proxy refuses paths off the tenant API', async () => {
  for (const p of ['https://evil.example/api/v3/x', '/plm/admin', '/api/v3/../../x']) {
    const r = await api('POST', '/api/fm', { method: 'GET', path: p });
    assert.equal(r.status, 400, p);
    assert.equal(r.data.error.code, 'INVALID_PATH');
  }
});

test('token export is off by default', async () => {
  const r = await api('GET', '/api/token');
  assert.equal(r.status, 403);
});

test('viewer commands need an open tab and valid arguments', async () => {
  const none = await api('POST', '/api/view', { command: 'fit', args: {} });
  assert.equal(none.status, 409);
  assert.equal(none.data.error.code, 'VIEWER_NOT_CONNECTED');
  const bad = await api('POST', '/api/view', { command: 'explode', args: { scale: 9 } });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error.code, 'INVALID_COMMAND');
  const evalOff = await api('POST', '/api/view', { command: 'eval', args: { code: '1' } });
  assert.equal(evalOff.status, 403);
});

test('browser endpoints need the page cookie and our origin', async () => {
  const noCookie = await fetch(base() + '/ui/token');
  assert.equal(noCookie.status, 403);
  const page = await fetch(base() + '/');
  const cookie = page.headers.get('set-cookie').split(';')[0];
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const crossSite = await fetch(base() + '/ui/event', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{"type":"selection"}' });
  assert.equal(crossSite.status, 403);
  const token = await fetch(base() + '/ui/token', { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(token.status, 200);
  assert.equal((await token.json()).result.access_token, 'at-1');
});

test('load from FM relays a typed command to the tab and returns its result', async () => {
  const page = await fetch(base() + '/');
  const cookie = page.headers.get('set-cookie').split(';')[0];
  const origin = `http://localhost:${port}`;
  const ac = new AbortController();
  const stream = await fetch(base() + '/ui/stream', { headers: { Cookie: cookie }, signal: ac.signal });
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  async function nextMessage(type) {
    for (;;) {
      const idx = buffer.indexOf('\n\n');
      if (idx >= 0) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const line = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (line) {
          const msg = JSON.parse(line.slice(6));
          if (msg.type === type) return msg;
        }
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('stream ended');
      buffer += decoder.decode(value, { stream: true });
    }
  }
  const hello = await nextMessage('hello');
  assert.equal(hello.tenant, 'demo');
  assert.equal(hello.signedIn, true);

  const pending = api('POST', '/api/view', { command: 'load', args: { ws: '57', item: '1' } });
  const cmd = await nextMessage('command');
  assert.equal(cmd.command, 'load');
  assert.deepEqual(cmd.args, { urn: 'dXJuOnRlc3Q', label: 'Gear.ipt' }, 'picked the CAD attachment, not the PDF');
  const post = await fetch(base() + '/ui/result', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: cmd.id, ok: true, result: { parts: 12, is2d: false, summary: '12 parts' } }),
  });
  assert.equal(post.status, 200);
  const r = await pending;
  assert.equal(r.status, 200);
  assert.equal(r.data.result.parts, 12);
  assert.deepEqual(r.data.result.source, { ws: '57', item: '1', attachment: '9', fileName: 'Gear.ipt' });

  // Viewer-side errors come back as typed errors.
  const failing = api('POST', '/api/view', { command: 'isolate', args: { targets: { name: 'Bolt*' } } });
  const cmd2 = await nextMessage('command');
  await fetch(base() + '/ui/result', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: cmd2.id, ok: false, error: { code: 'MODEL_NOT_LOADED', message: 'No model', hint: 'load first' } }),
  });
  const f = await failing;
  assert.equal(f.status, 422);
  assert.equal(f.data.error.code, 'MODEL_NOT_LOADED');

  // Panels go through the same channel.
  const panel = api('POST', '/api/panel', { panel: 'markdown', data: { text: '# Done' }, title: 'Summary' });
  const cmd3 = await nextMessage('command');
  assert.equal(cmd3.command, 'panel');
  assert.equal(cmd3.args.data.text, '# Done');
  await fetch(base() + '/ui/result', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: cmd3.id, ok: true, result: {} }) });
  assert.equal((await panel).status, 200);

  // Events from the tab reach the long-poll queue.
  await fetch(base() + '/ui/event', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'selection', data: { ids: [5] } }) });
  const ev = await api('GET', '/api/events?since=0');
  assert.ok(ev.data.result.events.some((e) => e.type === 'selection' && e.data.ids[0] === 5));

  const status = await api('GET', '/api/status');
  assert.equal(status.data.result.model.item, '1');
  ac.abort();
});

test('attachment download streams the bytes without auth on S3', async () => {
  const r = await fetch(base() + '/api/fm/download', { method: 'POST', headers: { 'X-FMV-Secret': secret, 'Content-Type': 'application/json' }, body: JSON.stringify({ ws: 57, item: 1, attachment: 9 }) });
  assert.equal(r.status, 200);
  assert.equal(decodeURIComponent(r.headers.get('x-fmv-file-name')), 'Gear.ipt');
  assert.equal(await r.text(), 'GEARBYTES');
});

test('static files cannot escape the UI folder', async () => {
  for (const p of ['/ui/../package.json', '/ui/%2e%2e/package.json', '/ui/..%5cpackage.json']) {
    const r = await fetch(base() + p);
    assert.equal(r.status, 404, p);
  }
  const ok = await fetch(base() + '/ui/app.js');
  assert.equal(ok.status, 200);
});
