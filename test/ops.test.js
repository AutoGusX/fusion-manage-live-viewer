// FmOps against a fake FM client: the request shapes that were verified live must not drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FmOps, formatValidation, parseDescriptor, parseItemRef } from '../src/fmOps.js';
import { FmError } from '../src/fm.js';

const config = { tenant: 'demo', fmBaseUrl: 'https://demo.autodeskplm360.net' };
const json = (status, body, headers = {}) => ({ status, body, headers, contentType: 'application/json' });

/** Fake FM: routes is a list of [method, pathRegex, handler(req, match)]. Records every call. */
function fakeFm(routes) {
  const calls = [];
  return {
    calls,
    async request(req) {
      const method = req.method || 'GET';
      calls.push({ ...req, method });
      for (const [m, re, fn] of routes) {
        const match = m === method && re.exec(req.path);
        if (match) return fn(req, match);
      }
      return json(404, { statusCode: 404, errors: ['NOT_FOUND'], message: `no route ${method} ${req.path}` });
    },
  };
}

const field = (id, extra = {}) => ({
  __self__: `/api/v3/workspaces/84/views/1/fields/${id}`,
  name: id.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
  type: { title: 'Single Line Text' },
  editability: 'ALWAYS',
  visibility: 'ALWAYS',
  derived: false,
  picklist: null,
  fieldValidators: [],
  defaultValue: null,
  ...extra,
});

const WS_ROUTES = [
  ['GET', /^\/api\/v3\/workspaces\/84$/, () => json(200, { name: 'Change Orders', systemName: 'WS_CHANGE_ORDERS' })],
  [
    'GET',
    /^\/api\/v3\/workspaces\/84\/fields$/,
    () =>
      json(200, {
        fields: [
          field('TITLE', { fieldValidators: [{ validatorName: 'required' }] }),
          field('TEMPLATE', { type: { title: 'Single Selection' }, picklist: '/api/v3/lookups/TEMPLATES', fieldValidators: [{ validatorName: 'dropDownSelection' }] }),
          field('PRIORITY', { type: { title: 'Single Selection' }, picklist: '/api/v3/lookups/PRIORITIES' }),
          field('MANAGER', { type: { title: 'Single Selection' }, picklist: '/api/v3/lookups/USERS', editability: 'NEVER', derived: true, derivedFieldSource: { __self__: '/api/v3/workspaces/84/views/1/fields/TEMPLATE' } }),
          field('NUMBER', { editability: 'NEVER', formulaField: true }),
        ],
      }),
  ],
  ['GET', /^\/api\/v3\/workspaces\/84\/sections$/, () => json(200, [{ link: '/api/v3/workspaces/84/sections/1', title: 'Summary' }, { link: '/api/v3/workspaces/84/sections/2', title: 'Stakeholders' }])],
  ['GET', /^\/api\/v3\/workspaces\/84\/sections\/1$/, () => json(200, { fields: ['TITLE', 'TEMPLATE', 'PRIORITY', 'NUMBER'].map((f) => ({ link: `/api/v3/workspaces/84/views/1/fields/${f}`, type: 'FIELD' })) })],
  ['GET', /^\/api\/v3\/workspaces\/84\/sections\/2$/, () => json(200, { fields: [{ link: '/api/v3/workspaces/84/views/1/fields/MANAGER', type: 'FIELD' }] })],
  ['GET', /^\/api\/v3\/lookups\/TEMPLATES$/, () => json(200, { items: [{ link: '/api/v3/workspaces/81/items/1', title: 'Test - No Approvers' }, { link: '/api/v3/workspaces/81/items/2', title: 'Fast Track' }] })],
  ['GET', /^\/api\/v3\/lookups\/PRIORITIES$/, () => json(200, { items: [{ link: '/api/v3/lookups/PRIORITIES/options/1', title: '3 / Low' }, { link: '/api/v3/lookups/PRIORITIES/options/3', title: '2 / Medium' }] })],
];

const itemBody = (id, extra = {}) => ({ title: `CO-1 - Record ${id}`, currentState: { title: 'Preparation' }, deleted: false, sections: [{ fields: [{ __self__: `/api/v3/workspaces/84/items/${id}/views/1/fields/PRIORITY`, value: { title: '3 / Low' } }] }], ...extra });

test('parseDescriptor splits number, title and revision only when it is safe', () => {
  assert.deepEqual(parseDescriptor('TA-1038 - Turbine Fan-26.ipt [REV:w]'), { number: 'TA-1038', title: 'Turbine Fan-26.ipt', revision: 'w', descriptor: 'TA-1038 - Turbine Fan-26.ipt' });
  const bolt = parseDescriptor('Bolt GB/T 29.1 M4 x 8 - T 29 [REV:w]');
  assert.equal(bolt.number, 'Bolt GB/T 29.1 M4 x 8 - T 29', 'no made-up number when the first part has spaces');
  assert.equal(parseDescriptor('GB-100').number, 'GB-100');
});

test('parseItemRef accepts ws:item, ws/item and links', () => {
  assert.deepEqual(parseItemRef('57:1011'), { ws: '57', item: '1011' });
  assert.deepEqual(parseItemRef('/api/v3/workspaces/57/items/9'), { ws: '57', item: '9' });
  assert.deepEqual(parseItemRef('9', 57), { ws: '57', item: '9' });
  assert.throws(() => parseItemRef('gearbox'), FmError);
});

test('formatValidation fills message placeholders', () => {
  const p = formatValidation([{ message: 'You must select an option for {0}', code: 'error.selectanoption', arguments: ['Change Template'], field: { __self__: '/x/fields/CHANGE_TEMPLATE', title: 'Change Template' } }]);
  assert.equal(p[0].message, 'You must select an option for Change Template');
  assert.equal(p[0].field, 'CHANGE_TEMPLATE');
  assert.equal(formatValidation({ message: 'x' }), null);
});

test('create: reports missing required fields with options before sending anything', async () => {
  const fm = fakeFm(WS_ROUTES);
  const ops = new FmOps(fm, config);
  await assert.rejects(
    () => ops.create({ ws: '84', fields: { title: 'A' } }),
    (e) => e.code === 'MISSING_REQUIRED' && e.missing[0].id === 'TEMPLATE' && e.missing[0].options.includes('Fast Track'),
  );
  assert.ok(!fm.calls.some((c) => c.method === 'POST'), 'nothing was posted');
});

test('create: resolves picklist text, uses workspace-scoped links, fills derived fields FM asks for', async () => {
  let posts = 0;
  const fm = fakeFm([
    ...WS_ROUTES,
    [
      'POST',
      /^\/api\/v3\/workspaces\/84\/items$/,
      (req) => {
        posts++;
        const all = req.body.sections.flatMap((s) => s.fields);
        if (!all.some((f) => f.__self__.endsWith('/MANAGER'))) {
          return json(400, [{ message: 'Derived value {0} does not match the source field value.', code: 'error.derived.invalidDerivedFieldValue', arguments: ['74'], field: { __self__: '/api/v3/workspaces/84/views/1/fields/MANAGER', title: 'Manager' } }]);
        }
        return json(201, '', { location: 'https://demo.autodeskplm360.net/api/v3/workspaces/84/items/500' });
      },
    ],
    ['GET', /^\/api\/v3\/workspaces\/84\/items\/500$/, () => json(200, itemBody(500))],
  ]);
  const ops = new FmOps(fm, config);

  const dry = await ops.create({ ws: '84', fields: { Title: 'A', template: 'no approvers', priority: 'medium' }, dryRun: true });
  assert.equal(dry.wouldCreate.TEMPLATE, 'Test - No Approvers');
  assert.equal(dry.wouldCreate.PRIORITY, '2 / Medium');
  assert.equal(posts, 0, 'dry run sends nothing');

  const r = await ops.create({ ws: '84', fields: { Title: 'A', template: 'no approvers', priority: 'medium' } });
  assert.equal(r.item, '500');
  assert.deepEqual(r.derivedFilled, ['MANAGER']);
  assert.equal(posts, 2);
  const sent = fm.calls.filter((c) => c.method === 'POST').at(-1).body;
  const summary = sent.sections.find((s) => s.link === '/api/v3/workspaces/84/sections/1');
  assert.deepEqual(summary.fields.find((f) => f.__self__.endsWith('/TEMPLATE')), { __self__: '/api/v3/workspaces/84/views/1/fields/TEMPLATE', value: { link: '/api/v3/workspaces/81/items/1' } });
  const manager = sent.sections.find((s) => s.link === '/api/v3/workspaces/84/sections/2').fields[0];
  assert.deepEqual(manager.value, { link: '/api/v3/lookups/USERS/options/74' });
});

test('create: unknown options and fields come back with choices', async () => {
  const ops = new FmOps(fakeFm(WS_ROUTES), config);
  await assert.rejects(() => ops.create({ ws: '84', fields: { title: 'A', template: 'fast', priority: 'urgent' } }), (e) => e.code === 'INVALID_OPTION' && e.hint.includes('2 / Medium'));
  await assert.rejects(() => ops.create({ ws: '84', fields: { title: 'A', colour: 'red' } }), (e) => e.code === 'UNKNOWN_FIELD');
  await assert.rejects(() => ops.create({ ws: '84', fields: { title: 'A', number: 'CO-9' } }), (e) => e.code === 'FIELD_NOT_WRITABLE');
});

test('update: PATCH with item-scoped links, never PUT', async () => {
  const fm = fakeFm([...WS_ROUTES, ['GET', /^\/api\/v3\/workspaces\/84\/items\/7$/, () => json(200, itemBody(7))], ['PATCH', /^\/api\/v3\/workspaces\/84\/items\/7$/, () => json(204, null)]]);
  const ops = new FmOps(fm, config);
  await ops.update({ ws: '84', item: '7', fields: { priority: 'medium' } });
  const patch = fm.calls.find((c) => c.method === 'PATCH');
  assert.equal(patch.body.sections[0].link, '/api/v3/workspaces/84/items/7/views/1/sections/1');
  assert.equal(patch.body.sections[0].fields[0].__self__, '/api/v3/workspaces/84/items/7/views/1/fields/PRIORITY');
  assert.ok(!fm.calls.some((c) => c.method === 'PUT'));
});

test('transition: needs a comment when required, sends content-location, treats 303 as success, never retries a refusal', async () => {
  let state = 'Preparation';
  let attempts = 0;
  const fm = fakeFm([
    ['GET', /^\/api\/v3\/workspaces\/84\/items\/7$/, () => json(200, itemBody(7, { currentState: { title: state } }))],
    [
      'GET',
      /^\/api\/v3\/workspaces\/84\/items\/7\/workflows\/1\/transitions$/,
      () =>
        json(200, [
          { __self__: '/api/v3/workspaces/84/workflows/1/transitions/551', name: 'Cancel Change Order', toState: { title: 'Cancelled' }, comments: 'REQUIRED' },
          { __self__: '/api/v3/workspaces/84/workflows/1/transitions/562', name: 'Submit to CCB', toState: { title: 'Review' }, comments: 'OPTIONAL' },
        ]),
    ],
    [
      'POST',
      /^\/api\/v3\/workspaces\/84\/items\/7\/workflows\/1\/transitions$/,
      (req) => {
        attempts++;
        if (req.contentLocation.endsWith('/562')) return json(400, { message: 'Change tasks must be defined in Tasks Planning tab first' });
        state = 'Cancelled';
        return json(303, null);
      },
    ],
  ]);
  const ops = new FmOps(fm, config);
  await assert.rejects(() => ops.transition({ ws: '84', item: '7', transition: 'cancel' }), (e) => e.code === 'COMMENT_REQUIRED');
  await assert.rejects(() => ops.transition({ ws: '84', item: '7', transition: 'approve' }), (e) => e.code === 'INVALID_OPTION' && e.hint.includes('Submit to CCB'));
  await assert.rejects(() => ops.transition({ ws: '84', item: '7', transition: 'submit' }), (e) => e.code === 'TRANSITION_REFUSED' && e.message.includes('Tasks Planning'));
  assert.equal(attempts, 1, 'a refused transition is not retried');
  const r = await ops.transition({ ws: '84', item: '7', transition: 'cancel', comment: 'not needed' });
  assert.equal(r.to, 'Cancelled');
  const post = fm.calls.filter((c) => c.method === 'POST').at(-1);
  assert.equal(post.contentLocation, '/api/v3/workspaces/84/workflows/1/transitions/551');
  assert.deepEqual(post.body, { comment: 'not needed' });
});

test('affected add: absolute URLs, bulk Accept, per-row results, names the record holding an item', async () => {
  const fm = fakeFm([
    ['GET', /^\/api\/v3\/workspaces\/84\/items\/7$/, () => json(200, itemBody(7))],
    ['GET', /^\/api\/v3\/workspaces\/57\/items\/(1|2)$/, (req, m) => json(200, { title: `P-${m[1]} - Part`, deleted: false, sections: [] })],
    ['GET', /^\/api\/v3\/workspaces\/57\/items\/3$/, () => json(200, { title: 'P-3 - Old', deleted: true, sections: [] })],
    [
      'POST',
      /^\/api\/v3\/workspaces\/84\/items\/7\/affected-items$/,
      () =>
        json(200, [
          { path: '/api/v3/workspaces/57/items/1', result: 'SUCCESS' },
          { path: '/api/v3/workspaces/57/items/2', result: 'FAILED', errorMessage: 'Linkable item 2 has already been added to another item' },
        ]),
    ],
    ['GET', /^\/api\/v3\/workspaces\/57\/items\/2\/views\/2$/, () => json(200, [{ item: { link: '/api/v3/workspaces/84/items/9', title: 'CO-9 - Other', deleted: true }, 'workflow-state': { title: 'Cancelled' } }])],
  ]);
  const ops = new FmOps(fm, config);
  await assert.rejects(() => ops.affectedAdd({ ws: '84', item: '7', items: ['57:3'] }), (e) => e.message.includes('archived'));
  const r = await ops.affectedAdd({ ws: '84', item: '7', items: ['57:1', '57:2'] });
  const post = fm.calls.find((c) => c.method === 'POST');
  assert.deepEqual(post.body, ['https://demo.autodeskplm360.net/api/v3/workspaces/57/items/1', 'https://demo.autodeskplm360.net/api/v3/workspaces/57/items/2']);
  assert.equal(post.accept, 'application/vnd.autodesk.plm.affected.items.bulk+json');
  assert.equal(r.added, 1);
  assert.equal(r.failed, 1);
  assert.deepEqual(r.results[1].heldBy, [{ ws: '84', item: '9', record: 'CO-9 - Other', state: 'Cancelled', archived: true }]);
});

test('affected add refuses an archived record; archive trusts the record over the status code', async () => {
  let deleted = true;
  const fm = fakeFm([
    ['GET', /^\/api\/v3\/workspaces\/84\/items\/7$/, () => json(200, itemBody(7, { deleted }))],
    ['PATCH', /^\/api\/v3\/workspaces\/84\/items\/7$/, (req) => ((deleted = req.query.deleted === 'true'), json(204, null))],
  ]);
  const ops = new FmOps(fm, config);
  await assert.rejects(() => ops.affectedAdd({ ws: '84', item: '7', items: ['57:1'] }), (e) => e.code === 'RECORD_ARCHIVED');
  const already = await ops.archive({ ws: '84', item: '7' });
  assert.equal(already.alreadyDone, true);
  assert.ok(!fm.calls.some((c) => c.method === 'PATCH'), 'no request when it is already archived');
  const restored = await ops.archive({ ws: '84', item: '7', undo: true });
  assert.equal(restored.archived, false);
});

test('find: only an exact match or a single hit is a clear match; empty search is not an error', async () => {
  const hit = (ws, id, descriptor) => ({ urn: `urn:adsk.plm:tenant.workspace.item:DEMO.${ws}.${id}`, descriptor, workspaceLongName: 'Items' });
  const fm = fakeFm([
    [
      'GET',
      /^\/api\/v3\/search-results$/,
      (req) => {
        const q = req.query.query;
        if (q.startsWith('TA-1008')) return json(200, { items: [hit(84, 5, 'CO-1 - Fix for TA-1008'), hit(57, 1, 'TA-1008 - Turbine Assembly.iam')] });
        if (q.includes('turbine')) return json(200, { items: [hit(57, 2, 'TA-1037 - Turbine Link Assembly.iam'), hit(57, 1, 'TA-1008 - Turbine Assembly.iam')] });
        return json(204, null);
      },
    ],
  ]);
  const ops = new FmOps(fm, config);
  const exact = await ops.find({ text: 'TA-1008' });
  assert.equal(exact.clearMatch, true);
  assert.equal(exact.results[0].item, '1');
  const vague = await ops.find({ text: 'turbine assembly' });
  assert.equal(vague.clearMatch, false);
  assert.equal(vague.results[0].item, '1', 'title match ranks first, but it is still not "clear"');
  assert.match(vague.hint, /ask which one/i);
  const none = await ops.find({ text: 'zzz', ws: '57' });
  assert.equal(none.count, 0);
  assert.ok(fm.calls.at(-1).query.query.includes('(workspaceId=57)'));
});
