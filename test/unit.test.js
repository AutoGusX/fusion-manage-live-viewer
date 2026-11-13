import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mask, parseEnv, resolveConfig, serializeEnv } from '../src/config.js';
import { createPkcePair, base64url } from '../src/auth.js';
import { resolveFmUrl, normaliseAttachments, FmError } from '../src/fm.js';
import { validateViewCommand, validatePanel, CommandError } from '../src/commands.js';
import { hostAllowed, sameOrigin, redact, safeEqual, contentSecurityPolicy } from '../src/security.js';
import { parseMarkdown, parseInline, safeHref } from '../ui/markdown.js';
import { parseArgs, targetsFromFlags, viewArgs, normaliseFmPath } from '../bin/fmv.js';

test('FM paths survive Git Bash path conversion on Windows', () => {
  assert.equal(normaliseFmPath('C:/Program Files/Git/api/v3/workspaces'), '/api/v3/workspaces');
  assert.equal(normaliseFmPath('C:\\Program Files\\Git\\api\\v3\\workspaces\\57\\items'), '/api/v3/workspaces/57/items');
  assert.equal(normaliseFmPath('api/v3/workspaces'), '/api/v3/workspaces');
  assert.equal(normaliseFmPath('/api/v3/workspaces'), '/api/v3/workspaces');
  assert.equal(normaliseFmPath('C:/Windows/system32'), 'C:/Windows/system32', 'non-API paths are left for the server to refuse');
});

const CID = 'TESTclientIDforUnitTests0000abcd';

test('parseEnv handles quotes, comments and blank lines', () => {
  const v = parseEnv('# c\nA=1\nB="two # not comment"\nC=three # trailing\n\n D = four \nbad line\n');
  assert.deepEqual(v, { A: '1', B: 'two # not comment', C: 'three', D: 'four' });
});

test('serializeEnv round-trips known keys only', () => {
  const text = serializeEnv({ APS_CLIENT_ID: CID, FM_TENANT: 'demo', OTHER: 'x' });
  assert.deepEqual(parseEnv(text), { APS_CLIENT_ID: CID, FM_TENANT: 'demo' });
});

test('resolveConfig derives defaults', () => {
  const { config, errors } = resolveConfig({ APS_CLIENT_ID: CID, FM_TENANT: 'Demo' });
  assert.equal(errors.length, 0);
  assert.equal(config.tenant, 'demo');
  assert.equal(config.fmBaseUrl, 'https://demo.autodeskplm360.net');
  assert.equal(config.port, 4710);
  assert.equal(config.callbackUrl, 'http://localhost:4710/callback');
  assert.equal(config.apsBase, 'https://developer.api.autodesk.com');
});

test('resolveConfig reports problems without echoing values', () => {
  const { errors } = resolveConfig({ APS_CLIENT_ID: 'short', FM_TENANT: 'https://x.autodeskplm360.net', FMV_PORT: '80' });
  const keys = errors.map((e) => e.key).sort();
  assert.deepEqual(keys, ['APS_CLIENT_ID', 'FMV_PORT', 'FM_TENANT']);
  for (const e of errors) assert.ok(!e.message.includes('short'));
});

test('resolveConfig rejects a callback on another port or host', () => {
  assert.ok(resolveConfig({ APS_CLIENT_ID: CID, FM_TENANT: 'd', APS_CALLBACK_URL: 'http://localhost:9999/callback' }).errors.some((e) => e.key === 'APS_CALLBACK_URL'));
  assert.ok(resolveConfig({ APS_CLIENT_ID: CID, FM_TENANT: 'd', APS_CALLBACK_URL: 'https://evil.example/callback' }).errors.some((e) => e.key === 'APS_CALLBACK_URL'));
});

test('FMV_APS_BASE is honoured only for loopback', () => {
  assert.equal(resolveConfig({ APS_CLIENT_ID: CID, FM_TENANT: 'd', FMV_APS_BASE: 'https://evil.example' }).config.apsBase, 'https://developer.api.autodesk.com');
  assert.equal(resolveConfig({ APS_CLIENT_ID: CID, FM_TENANT: 'd', FMV_APS_BASE: 'http://127.0.0.1:5000' }).config.apsBase, 'http://127.0.0.1:5000');
});

test('FM_BASE_URL must be https unless loopback', () => {
  assert.ok(resolveConfig({ APS_CLIENT_ID: CID, FM_TENANT: 'd', FM_BASE_URL: 'http://d.autodeskplm360.net' }).errors.some((e) => e.key === 'FM_BASE_URL'));
});

test('mask never shows the whole value', () => {
  assert.equal(mask(CID), 'TEST…cd');
  assert.equal(mask(''), '(not set)');
});

test('PKCE challenge is S256 of the verifier', () => {
  const { verifier, challenge } = createPkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(challenge, base64url(crypto.createHash('sha256').update(verifier).digest()));
});

test('resolveFmUrl keeps calls on the tenant API', () => {
  const base = 'https://demo.autodeskplm360.net';
  assert.equal(resolveFmUrl(base, '/api/v3/workspaces').toString(), 'https://demo.autodeskplm360.net/api/v3/workspaces');
  assert.equal(resolveFmUrl(base, '/api/v3/search', { q: 'a b', limit: 5 }).search, '?q=a+b&limit=5');
  for (const bad of ['https://evil.example/api/v3/x', '//evil.example/api/v3/x', '/api/v3/../../plm/admin', '/plm/admin', 'api/v3/x', '/api\\v3/x', '/api/v4/x']) {
    assert.throws(() => resolveFmUrl(base, bad), FmError, bad);
  }
});

test('normaliseAttachments reads the three shapes', () => {
  assert.deepEqual(normaliseAttachments({ url: 'https://s3' }), []);
  assert.deepEqual(normaliseAttachments(null), []);
  const list = normaliseAttachments({ attachments: [{ id: 7, name: 'Gear.IPT', version: 3 }, { selfLink: '/x/attachments/8', resourceName: 'spec.pdf' }] });
  assert.equal(list[0].id, '7');
  assert.equal(list[0].extension, 'ipt');
  assert.equal(list[0].isCad, true);
  assert.equal(list[1].id, '8');
  assert.equal(list[1].isCad, false);
});

test('view commands are validated', () => {
  assert.deepEqual(validateViewCommand('isolate', { targets: { prop: { name: 'Part Number', values: ['A', 'B'] } } }), { targets: { prop: { name: 'Part Number', values: ['A', 'B'] } } });
  assert.throws(() => validateViewCommand('isolate', {}), CommandError);
  assert.throws(() => validateViewCommand('isolate', { targets: { name: 'a', dbids: [1] } }), CommandError);
  assert.throws(() => validateViewCommand('nope', {}), CommandError);
  assert.throws(() => validateViewCommand('__proto__', {}), CommandError);
  assert.throws(() => validateViewCommand('color', { color: 'red', targets: { all: true } }), CommandError);
  assert.equal(validateViewCommand('color', { color: 'FF6600', targets: { all: true } }).groups[0].color, '#ff6600');
  assert.deepEqual(validateViewCommand('section', { plane: 'Y', offset: '0.25' }), { plane: 'y', offset: 0.25, flip: false });
  assert.throws(() => validateViewCommand('section', { plane: 'y', offset: 2 }), CommandError);
  assert.deepEqual(validateViewCommand('section', { off: true }), { off: true });
  assert.throws(() => validateViewCommand('explode', { scale: 1.5 }), CommandError);
  assert.deepEqual(validateViewCommand('camera', { view: 'ISO' }), { view: 'iso' });
  assert.deepEqual(validateViewCommand('camera', { eye: '1,2,3', target: [0, 0, 0] }), { eye: [1, 2, 3], target: [0, 0, 0] });
});

test('panels are validated and links must be http(s)', () => {
  const t = validatePanel('table', { columns: ['a', 'b'], rows: [[1, null], { a: 'x', b: 2 }] });
  assert.deepEqual(t.data.rows, [['1', ''], ['x', '2']]);
  assert.throws(() => validatePanel('card', { title: 't', link: 'javascript:alert(1)' }), CommandError);
  assert.throws(() => validatePanel('html', {}), CommandError);
  assert.equal(validatePanel('markdown', '# hi').data.text, '# hi');
  assert.equal(validatePanel('bom', { rows: [{ number: 'A', level: 1 }] }).data.rows[0].level, 1);
});

test('host, origin and secret checks', () => {
  assert.ok(hostAllowed('localhost:4710', 4710));
  assert.ok(hostAllowed('127.0.0.1:4710', 4710));
  assert.ok(!hostAllowed('evil.example:4710', 4710));
  assert.ok(!hostAllowed('localhost:4711', 4710));
  assert.ok(sameOrigin({ headers: { origin: 'http://localhost:4710' } }, 4710));
  assert.ok(!sameOrigin({ headers: { origin: 'https://evil.example' } }, 4710));
  assert.ok(!sameOrigin({ headers: { 'sec-fetch-site': 'cross-site' } }, 4710));
  assert.ok(!sameOrigin({ headers: {} }, 4710));
  assert.ok(safeEqual('abc', 'abc'));
  assert.ok(!safeEqual('abc', 'abd'));
  assert.ok(!safeEqual('abc', 'ab'));
});

test('redact removes tokens and codes', () => {
  const s = redact('Authorization: Bearer abc.def-123 ?code=XYZ&state=1 {"access_token":"t1","refresh_token":"r1"}');
  for (const secret of ['abc.def-123', 'XYZ', 't1', 'r1']) assert.ok(!s.includes(secret), s);
});

test('CSP only allows eval when asked', () => {
  assert.ok(!contentSecurityPolicy().includes('unsafe-eval'));
  assert.ok(contentSecurityPolicy({ unsafeEval: true }).includes("'unsafe-eval'"));
});

test('markdown parser: blocks, inline and unsafe links', () => {
  const b = parseMarkdown('# Title\n\nSome **bold** and `code`.\n\n- [x] done\n- todo\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```\nraw <b>\n```');
  assert.deepEqual(
    b.map((x) => x.type),
    ['heading', 'paragraph', 'list', 'table', 'code'],
  );
  assert.equal(b[2].items[0].checked, true);
  assert.equal(b[4].text, 'raw <b>');
  assert.deepEqual(parseInline('[x](javascript:alert(1))'), [{ type: 'text', text: 'x' }, { type: 'text', text: ')' }]);
  assert.equal(safeHref('jav\tascript:alert(1)'), null);
  assert.equal(safeHref('https://a.example/x'), 'https://a.example/x');
});

test('CLI argument parsing and part targeting', () => {
  const { positionals, flags } = parseArgs(['view', 'isolate', '--prop', 'Part Number=A, B', '--json']);
  assert.deepEqual(positionals, ['view', 'isolate']);
  assert.equal(flags.json, true);
  assert.deepEqual(targetsFromFlags(flags), { prop: { name: 'Part Number', values: ['A', 'B'] } });
  assert.deepEqual(targetsFromFlags(parseArgs(['--dbid', '1,2', '--dbid', '3']).flags), { dbids: [1, 2, 3] });
  assert.deepEqual(viewArgs('section', ['x'], parseArgs(['--offset', '0.5']).flags), { plane: 'x', offset: '0.5' });
  assert.deepEqual(viewArgs('camera', ['front', 'top', 'right'], {}), { view: 'front top right' });
  assert.throws(() => viewArgs('load', [], {}));
});
