// High-level Fusion Manage operations (spec 0004). Each one wraps a sequence of FM calls whose
// shapes were verified live, so an agent runs one command instead of hand-assembling requests.
// Reads are safe to repeat. Writes support dryRun and never retry a call that may have applied.

import { FmError, fmHttpError, requireId } from './fm.js';

const BOM_ACCEPT = 'application/vnd.autodesk.plm.bom.bulk+json';
const AFFECTED_ACCEPT = 'application/vnd.autodesk.plm.affected.items.bulk+json';
const ITEM_LINK = /\/api\/v3\/workspaces\/(\d+)\/items\/(\d+)/;

const tail = (link) => String(link || '').split('/').pop();
const norm = (s) => String(s ?? '').trim().toLowerCase();

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    }),
  );
  return out;
}

/** "TA-1038 - Turbine Fan-26.ipt [REV:w]" -> { number: "TA-1038", title: "Turbine Fan-26.ipt", revision: "w" } */
export function parseDescriptor(descriptor) {
  let text = String(descriptor || '').trim();
  let revision = '';
  const rev = /\s*\[REV:([^\]]*)\]\s*$/.exec(text);
  if (rev) {
    revision = rev[1];
    text = text.slice(0, rev.index).trim();
  }
  const sep = text.indexOf(' - ');
  if (sep > 0) {
    const head = text.slice(0, sep).trim();
    // Only treat the first part as a number when it looks like one (no spaces).
    if (!/\s/.test(head)) return { number: head, title: text.slice(sep + 3).trim(), revision, descriptor: text };
  }
  return { number: text, title: text, revision, descriptor: text };
}

/** Parse "57:1011", "57/1011" or an item link into { ws, item }. */
export function parseItemRef(ref, defaultWs) {
  const s = String(ref).trim();
  let m = ITEM_LINK.exec(s);
  if (m) return { ws: m[1], item: m[2] };
  m = /^(\d+)[:/](\d+)$/.exec(s);
  if (m) return { ws: m[1], item: m[2] };
  if (/^\d+$/.test(s) && defaultWs) return { ws: String(defaultWs), item: s };
  throw new FmError('INVALID_ARGUMENT', `"${s}" is not an item reference.`, 'Use <workspace>:<item>, for example 57:1011.');
}

/** FM validation errors arrive as an array of { message with {0}, arguments, field }. */
export function formatValidation(body) {
  if (!Array.isArray(body)) return null;
  return body.map((e) => {
    let msg = String(e.message || e.code || 'Invalid value');
    (e.arguments || []).forEach((a, i) => {
      msg = msg.replace(`{${i}}`, String(a));
    });
    return { field: tail(e.field?.__self__), title: e.field?.title, code: e.code, message: msg, arguments: e.arguments || [] };
  });
}

export class FmOps {
  constructor(fm, config, log = () => {}) {
    this.fm = fm;
    this.config = config;
    this.log = log;
    this.metaCache = new Map();
    this.shown = new WeakMap(); // picklist value object -> its title, for readable previews
  }

  itemUrl(ws, item) {
    const tenant = this.config.tenant.toUpperCase();
    return `${this.config.fmBaseUrl}/plm/workspaces/${ws}/items/itemDetails?view=full&tab=details&mode=view&itemId=urn%60adsk,plm%60tenant,workspace,item%60${tenant},${ws},${item}`;
  }

  /** GET that throws on HTTP errors; `allow` statuses return null (optional views answer 403/204). */
  async get(path, { accept, query, allow = [], what = 'read from Fusion Manage' } = {}) {
    const r = await this.fm.request({ path, accept, query });
    if (r.status === 204) return null;
    if (allow.includes(r.status)) return null;
    if (r.status >= 400) throw fmHttpError(r, what);
    return r.body;
  }

  // ---------------------------------------------------------------------------------------------
  // find
  // ---------------------------------------------------------------------------------------------
  async find({ text, ws, limit = 10 }) {
    const q = String(text || '').trim();
    if (!q) throw new FmError('INVALID_ARGUMENT', 'Give some text to search for.', 'Example: fmv fm find "turbine assembly"');
    const scope = ws ? ` AND (workspaceId=${requireId(ws, 'workspace')})` : '';
    const run = async (query) => (await this.get('/api/v3/search-results', { query: { query: query + scope, limit: 50, offset: 0, revision: 1 }, what: 'search Fusion Manage' }))?.items || [];
    const grammar = /[:=*]/.test(q);
    let items = await run(q);
    if (!items.length && !grammar) items = await run(`*${q}*`);
    const needle = norm(q);
    const scored = items.map((it) => {
      const m = /\.(\d+)\.(\d+)$/.exec(it.urn || '');
      const d = parseDescriptor(it.descriptor);
      const nd = norm(d.descriptor);
      const bare = norm(d.title).replace(/.[a-z0-9]{2,5}$/, ''); // "Turbine Assembly.iam" → "turbine assembly"
      let score = 0;
      if (norm(d.number) === needle || nd === needle) score = 100;
      else if (norm(d.title) === needle || bare === needle) score = 90;
      else if (nd.startsWith(needle)) score = 80;
      else if (needle.split(/\s+/).every((w) => nd.includes(w))) score = 60;
      else if (nd.includes(needle)) score = 50;
      return { ws: m?.[1], item: m?.[2], workspace: it.workspaceLongName, descriptor: it.descriptor, number: d.number, title: d.title, revision: d.revision, score };
    });
    // Search returns one row per revision at times; keep the best row per descriptor + workspace.
    const seen = new Map();
    for (const s of scored.sort((a, b) => b.score - a.score || Number(b.item) - Number(a.item))) {
      const key = `${s.ws}|${norm(parseDescriptor(s.descriptor).descriptor)}`;
      if (!seen.has(key)) seen.set(key, s);
    }
    const results = [...seen.values()].slice(0, Math.max(1, Math.min(Number(limit) || 10, 50)));
    // Tell the user which candidates have a 3D model, so a question can say so.
    await pool(results.slice(0, 6), 6, async (r) => {
      try {
        const atts = await this.fm.listAttachments(r.ws, r.item);
        const cad = atts.filter((a) => a.isCad);
        r.hasModel = cad.length > 0;
        if (cad.length) r.model = cad[0].name;
      } catch {}
    });
    const top = results[0];
    // Only an exact number/descriptor match, or a single hit, counts as clear. A good-looking
    // partial match is still a guess.
    const clear = Boolean(top) && (results.length === 1 || (top.score === 100 && (results[1]?.score ?? 0) < 100));
    return {
      query: q,
      count: results.length,
      totalMatches: items.length,
      clearMatch: clear,
      results: results.map(({ score, ...r }) => r),
      ...(results.length === 0 ? { hint: 'Nothing found. Try a part number, fewer words, or drop the workspace filter.' } : {}),
      ...(results.length > 1 && !clear ? { hint: 'Several items match. Show these to the user and ask which one; do not pick silently.' } : {}),
      note: 'Search can lag behind recent edits and may include archived items.',
    };
  }

  // ---------------------------------------------------------------------------------------------
  // workspace metadata
  // ---------------------------------------------------------------------------------------------
  async meta(ws) {
    requireId(ws, 'workspace');
    if (this.metaCache.has(ws)) return this.metaCache.get(ws);
    const [wsBody, fieldsBody, sectionsBody] = await Promise.all([
      this.get(`/api/v3/workspaces/${ws}`, { what: 'read the workspace' }),
      this.get(`/api/v3/workspaces/${ws}/fields`, { what: 'read the workspace fields' }),
      this.get(`/api/v3/workspaces/${ws}/sections`, { what: 'read the workspace sections' }),
    ]);
    const sectionList = Array.isArray(sectionsBody) ? sectionsBody : sectionsBody?.sections || [];
    const sections = await pool(sectionList, 6, async (s) => {
      const d = await this.get(s.link, { what: 'read a workspace section' });
      return { link: s.link, id: tail(s.link), title: String(s.title || '').trim(), fieldLinks: (d?.fields || []).filter((f) => f.type === 'FIELD' || !f.type).map((f) => f.link) };
    });
    const sectionOf = new Map();
    for (const s of sections) for (const l of s.fieldLinks) sectionOf.set(l, s);
    const fields = (fieldsBody?.fields || fieldsBody || []).map((f) => {
      const typeTitle = f.type?.title || '';
      return {
        id: tail(f.__self__),
        link: f.__self__,
        name: f.name,
        type: typeTitle,
        // Required picklists carry "dropDownSelection" instead of "required".
        required: (f.fieldValidators || []).some((v) => ['required', 'dropDownSelection'].includes(v.validatorName)),
        editable: f.editability !== 'NEVER' && !f.formulaField,
        visible: f.visibility !== 'NEVER',
        derived: Boolean(f.derived),
        derivedFrom: f.derivedFieldSource ? tail(f.derivedFieldSource.__self__) : null,
        picklist: typeof f.picklist === 'string' ? f.picklist : f.picklist?.link || null,
        multiple: /multiple/i.test(typeTitle),
        defaultValue: f.defaultValue ?? null,
        section: sectionOf.get(f.__self__) || null,
      };
    });
    const m = { ws: String(ws), name: wsBody?.name || '', systemName: wsBody?.systemName || '', fields, sections };
    this.metaCache.set(ws, m);
    return m;
  }

  async options({ ws, field, filter, limit = 50 }) {
    const m = await this.meta(ws);
    const f = this.matchField(m, field);
    if (!f.picklist) throw new FmError('INVALID_ARGUMENT', `${f.name} is not a picklist field.`, 'Set it with a plain value.');
    const list = await this.lookup(f.picklist, filter, limit);
    return { field: f.id, name: f.name, multiple: f.multiple, options: list.map((o) => o.title), count: list.length, ...(list.length >= limit ? { hint: 'More options exist. Narrow with --filter "<text>".' } : {}) };
  }

  async lookup(picklist, filter, limit = 100) {
    const out = [];
    for (let offset = 0; out.length < limit; offset += 100) {
      const body = await this.get(picklist, { query: { offset, limit: 100, ...(filter ? { filter } : {}) }, what: 'read a picklist' });
      const items = body?.items || [];
      out.push(...items.map((o) => ({ link: o.link, title: String(o.title ?? '') })));
      if (items.length < 100) break;
    }
    return out.slice(0, limit);
  }

  matchField(m, key) {
    const k = norm(key);
    const hit = m.fields.find((f) => norm(f.id) === k) || m.fields.find((f) => norm(f.name) === k) || m.fields.find((f) => norm(f.id) === k.replace(/\s+/g, '_'));
    if (hit) return hit;
    const ku = k.replace(/s+/g, '_');
    const partial = m.fields.filter((f) => f.editable && (norm(f.id).includes(ku) || norm(f.name).includes(k)));
    if (partial.length === 1) return partial[0];
    const close = partial.map((f) => f.id);
    throw new FmError('UNKNOWN_FIELD', `No field "${key}" in ${m.name}.`, close.length ? `Did you mean: ${close.join(', ')}?` : `Run \`fmv fm describe ${m.ws}\` to list the fields.`);
  }

  async describe({ ws }) {
    const m = await this.meta(ws);
    const writable = m.fields.filter((f) => f.editable && f.section);
    const withOptions = await pool(writable, 6, async (f) => {
      const row = { id: f.id, name: f.name, type: f.type, required: f.required, section: f.section.title };
      if (f.defaultValue !== null && f.defaultValue !== '') row.default = f.defaultValue;
      if (f.picklist) {
        if (f.required) {
          const opts = await this.lookup(f.picklist, undefined, 40).catch(() => []);
          row.options = opts.map((o) => o.title);
          if (opts.length >= 40) row.optionsNote = `More exist: fmv fm options ${ws} ${f.id} --filter "<text>"`;
        } else row.options = `fmv fm options ${ws} ${f.id}`;
      }
      return row;
    });
    const derived = m.fields.filter((f) => f.derived).map((f) => ({ id: f.id, name: f.name, derivedFrom: f.derivedFrom }));
    let transitions = [];
    try {
      const t = await this.get(`/api/v3/workspaces/${ws}/workflows/1/transitions`, { allow: [403, 404] });
      transitions = (Array.isArray(t) ? t : t?.transitions || []).map((x) => ({ name: x.name, from: x.fromState?.title, to: x.toState?.title, comment: x.comments }));
    } catch {}
    return {
      ws: m.ws,
      name: m.name,
      systemName: m.systemName,
      required: withOptions.filter((f) => f.required).map((f) => f.id),
      writableFields: withOptions,
      derivedFields: derived,
      ...(derived.length ? { derivedNote: 'Derived fields are filled by Fusion Manage from their source field. `fmv fm create` supplies them for you.' } : {}),
      workflowTransitions: transitions,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // item (compact read)
  // ---------------------------------------------------------------------------------------------
  async item({ ws, item }) {
    requireId(ws, 'workspace');
    requireId(item, 'item');
    const b = await this.get(`/api/v3/workspaces/${ws}/items/${item}`, { what: 'read the item' });
    const fields = {};
    for (const s of b.sections || []) {
      for (const f of s.fields || []) {
        const v = f.value;
        let shown = v;
        if (Array.isArray(v)) shown = v.map((x) => x?.title ?? x);
        else if (v && typeof v === 'object') shown = v.title ?? v.link ?? v;
        if (shown === null || shown === undefined || shown === '') continue;
        fields[tail(f.__self__)] = shown;
      }
    }
    return {
      ws: String(ws),
      item: String(item),
      title: b.title,
      state: b.currentState?.title || null,
      lifecycle: b.lifecycle?.title || null,
      deleted: Boolean(b.deleted),
      locked: Boolean(b.itemLocked),
      workingVersion: b.workingVersion ?? null,
      url: this.itemUrl(ws, item),
      fields,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // BOM
  // ---------------------------------------------------------------------------------------------
  async bomRaw(ws, item, depth) {
    return this.get(`/api/v3/workspaces/${ws}/items/${item}/bom`, { accept: BOM_ACCEPT, query: { depth }, what: 'read the BOM' });
  }

  async bom({ ws, item, depth = 1 }) {
    requireId(ws, 'workspace');
    requireId(item, 'item');
    const d = Math.max(1, Math.min(Number(depth) || 1, 20));
    const b = await this.bomRaw(ws, item, d);
    const root = await this.get(`/api/v3/workspaces/${ws}/items/${item}`, { what: 'read the item' });
    const rootInfo = parseDescriptor(root.title);
    const rootRow = { level: 0, number: rootInfo.number, title: rootInfo.title, quantity: 1, state: root.lifecycle?.title || root.currentState?.title || '', revision: rootInfo.revision, ws: String(ws), item: String(item) };
    if (!b || !(b.edges || []).length) return { ws: String(ws), item: String(item), rows: [rootRow], count: 1, note: 'This item has no BOM children.', panel: { matchProperty: 'Part Number', rows: [rootRow] } };

    // Column meaning comes from the BOM view definition, never from position.
    const byId = new Map();
    try {
      const defs = await this.get(`${b.config.viewDef.link}/fields`, { what: 'read the BOM view' });
      for (const f of Array.isArray(defs) ? defs : defs?.fields || []) byId.set(String(f.viewDefFieldId ?? tail(f.__self__?.link || f.__self__)), { semantics: f.semantics || '', fieldId: f.fieldId || '', name: f.name || '' });
    } catch {}
    const pick = (fields, test) => {
      for (const f of fields || []) {
        const def = byId.get(tail(f.metaData?.link));
        if (def && test(def)) return f.value && typeof f.value === 'object' ? f.value.title ?? '' : f.value;
      }
      return undefined;
    };
    const isQty = (d2) => /quantity/i.test(d2.semantics) || /^quantity$/i.test(d2.fieldId) || /^(qty|quantity)$/i.test(d2.name);
    const isState = (d2) => /lifecycle/i.test(d2.semantics) || /^lifecycle$/i.test(d2.fieldId) || /^lifecycle$/i.test(d2.name);
    const isNumber = (d2) => /^(number|part_number|item_number)$/i.test(d2.fieldId);

    const nodes = new Map((b.nodes || []).map((n) => [n.item.urn, n]));
    const kids = new Map();
    for (const e of b.edges || []) {
      if (!kids.has(e.parent)) kids.set(e.parent, []);
      kids.get(e.parent).push(e);
    }
    const rows = [rootRow];
    const walk = (urn, level, trail) => {
      for (const e of (kids.get(urn) || []).sort((a, c) => (a.itemNumber ?? 0) - (c.itemNumber ?? 0))) {
        const n = nodes.get(e.child);
        if (!n || trail.has(e.child)) continue;
        const info = parseDescriptor(n.item.title);
        const m = ITEM_LINK.exec(n.item.link) || [];
        const qty = pick(e.fields, isQty);
        rows.push({
          level,
          number: String(pick(n.fields, isNumber) ?? info.number),
          title: info.title,
          quantity: qty === undefined || qty === '' ? '' : Number(qty),
          state: String(pick(n.fields, isState) ?? ''),
          revision: info.revision,
          ws: m[1],
          item: m[2],
        });
        walk(e.child, level + 1, new Set([...trail, e.child]));
      }
    };
    const rootNode = nodes.get(b.root);
    if (rootNode) {
      const st = pick(rootNode.fields, isState);
      if (st !== undefined && st !== '') rootRow.state = String(st);
      const num = pick(rootNode.fields, isNumber);
      if (num !== undefined && num !== '') rootRow.number = String(num);
    }
    walk(b.root, 1, new Set([b.root]));
    return {
      ws: String(ws),
      item: String(item),
      depth: d,
      count: rows.length,
      rows,
      panel: { matchProperty: 'Part Number', rows: rows.map(({ level, number, title, quantity, state }) => ({ level, number, title, quantity, state })) },
      note: 'number comes from the item descriptor unless the BOM view has a number column. If parts do not match in the viewer by Part Number, match by name prefix instead.',
    };
  }

  // ---------------------------------------------------------------------------------------------
  // related records (changes, relationships, and records in other workspaces that reference the BOM)
  // ---------------------------------------------------------------------------------------------
  async related({ ws, item, depth = 10, scan = [], revisions = true }) {
    requireId(ws, 'workspace');
    requireId(item, 'item');
    const rootLink = `/api/v3/workspaces/${ws}/items/${item}`;
    const titles = new Map(); // link -> title of the BOM item it belongs to
    const b = await this.bomRaw(ws, item, Math.max(1, Math.min(Number(depth) || 10, 20)));
    for (const n of b?.nodes || []) titles.set(n.item.link, parseDescriptor(n.item.title).descriptor);
    if (!titles.has(rootLink)) {
      const root = await this.get(rootLink, { what: 'read the item' });
      titles.set(rootLink, parseDescriptor(root.title).descriptor);
    }
    const current = [...titles.keys()];
    this.log({ kind: 'info', message: `Checking ${current.length} BOM items for related records…` });

    // Records often point at an older revision, which has its own item ID.
    if (revisions) {
      await pool(current, 10, async (link) => {
        try {
          const v = await this.get(`${link}/versions`, { allow: [403, 404] });
          for (const ver of v?.versions || []) if (ver.item?.link && !titles.has(ver.item.link)) titles.set(ver.item.link, titles.get(link));
        } catch {}
      });
    }
    const all = [...titles.keys()];

    const records = new Map(); // record link -> { ..., items:Set }
    const add = (kind, rec, state, workspace, sourceLink, extra = {}) => {
      if (!rec?.link) return;
      const key = `${kind}|${rec.link}`;
      if (!records.has(key)) {
        const m = ITEM_LINK.exec(rec.link) || [];
        records.set(key, { kind, record: rec.title, state: state || '', workspace: workspace || '', ws: m[1], item: m[2], deleted: Boolean(rec.deleted), url: m[1] ? this.itemUrl(m[1], m[2]) : undefined, bomItems: new Set(), ...extra });
      }
      records.get(key).bomItems.add(titles.get(sourceLink));
    };

    await pool(all, 10, async (link) => {
      try {
        const changes = await this.get(`${link}/views/2`, { allow: [403, 404] });
        for (const e of Array.isArray(changes) ? changes : []) add('change', e.item, e['workflow-state']?.title || e.item?.currentState, 'Change', link);
      } catch {}
      try {
        const rel = await this.get(`${link}/views/10`, { allow: [403, 404] });
        for (const e of Array.isArray(rel) ? rel : rel?.relationships || []) add('relationship', e.item, '', e.workspace?.title, link, { direction: e.direction?.type || e.direction || '' });
      } catch {}
    });

    // Other workspaces (non-conformances, CAPAs…) reference items through picklist fields, which
    // have no reverse lookup. Read every record in the requested workspaces and look for our items.
    const scanned = [];
    const set = new Set(all);
    for (const sws of scan) {
      requireId(sws, 'scan workspace');
      const recs = [];
      let truncated = false;
      for (let offset = 0; ; offset += 100) {
        const page = await this.get(`/api/v3/workspaces/${sws}/items`, { query: { offset, limit: 100 }, what: 'list a workspace' });
        const items = page?.items || [];
        recs.push(...items.map((it) => ({ link: it.__self__, title: it.descriptor, workspace: it.workspaceLongName })));
        if (items.length < 100) break;
        if (recs.length >= 1000) {
          truncated = true;
          break;
        }
      }
      this.log({ kind: 'info', message: `Scanning ${recs.length} records in workspace ${sws}…` });
      let hits = 0;
      await pool(recs, 8, async (rec) => {
        const texts = [];
        let state = '';
        let deleted = false;
        try {
          const body = await this.get(rec.link);
          state = body?.currentState?.title || body?.lifecycle?.title || '';
          deleted = Boolean(body?.deleted);
          texts.push(JSON.stringify(body));
        } catch {}
        try {
          const aff = await this.get(`${rec.link}/views/11`, { allow: [403, 404] });
          if (aff) texts.push(JSON.stringify(aff));
        } catch {}
        const refs = new Set((texts.join(' ').match(/\/api\/v3\/workspaces\/\d+\/items\/\d+/g) || []).filter((l) => set.has(l)));
        if (refs.size) {
          hits++;
          for (const l of refs) add('reference', { link: rec.link, title: rec.title, deleted }, state, rec.workspace, l);
        }
      });
      scanned.push({ ws: String(sws), workspace: recs[0]?.workspace || '', records: recs.length, hits, ...(truncated ? { truncated: true } : {}) });
    }

    const list = [...records.values()].map((r) => ({ ...r, bomItems: [...r.bomItems].sort() })).sort((a, c) => a.kind.localeCompare(c.kind) || String(a.record).localeCompare(String(c.record)));
    return {
      root: titles.get(rootLink),
      bomItemsChecked: current.length,
      revisionsChecked: all.length,
      changes: list.filter((r) => r.kind === 'change'),
      relationships: list.filter((r) => r.kind === 'relationship'),
      // A record already listed as a change is not repeated as a reference.
      references: list.filter((r) => r.kind === 'reference' && !list.some((c) => c.kind === 'change' && c.ws === r.ws && c.item === r.item)),
      scanned,
      ...(scan.length === 0 ? { hint: 'Only change orders and relationships were checked. To include non-conformances, CAPAs or other records, pass their workspace IDs with --scan (find them with `fmv fm workspaces`).' } : {}),
    };
  }

  async workspaces({ filter } = {}) {
    const body = await this.get('/api/v3/workspaces', { query: { limit: 500 }, what: 'list workspaces' });
    const f = norm(filter);
    const rows = (body?.items || []).map((w) => ({ ws: tail(w.link), name: w.title })).filter((w) => !f || norm(w.name).includes(f));
    return { count: rows.length, workspaces: rows };
  }

  // ---------------------------------------------------------------------------------------------
  // create / update
  // ---------------------------------------------------------------------------------------------
  async resolveValue(f, value) {
    if (!f.picklist) return value;
    const one = async (v) => {
      if (v && typeof v === 'object' && v.link) return { link: v.link };
      const s = String(v).trim();
      if (s.startsWith('/api/v3/')) return { link: s };
      let opts = await this.lookup(f.picklist, s, 100).catch(() => []);
      if (!opts.length) opts = await this.lookup(f.picklist, undefined, 300);
      const n = norm(s);
      const exact = opts.filter((o) => norm(o.title) === n);
      const hits = exact.length ? exact : opts.filter((o) => norm(o.title).includes(n));
      if (hits.length === 1) {
        const res = { link: hits[0].link };
        this.shown.set(res, hits[0].title);
        return res;
      }
      if (hits.length === 0) {
        throw new FmError('INVALID_OPTION', `"${s}" is not an option for ${f.name}.`, `Options include: ${opts.slice(0, 25).map((o) => o.title).join(' | ')}`);
      }
      throw new FmError('AMBIGUOUS_OPTION', `"${s}" matches several options for ${f.name}.`, `Pick one: ${hits.slice(0, 15).map((o) => o.title).join(' | ')}`);
    };
    if (f.multiple) return Promise.all((Array.isArray(value) ? value : [value]).map(one));
    return one(Array.isArray(value) ? value[0] : value);
  }

  display(value) {
    if (Array.isArray(value)) return value.map((v) => this.display(v));
    if (value && typeof value === 'object') return this.shown.get(value) ?? value.link ?? value;
    return value;
  }

  async buildFields(m, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new FmError('INVALID_ARGUMENT', 'fields must be a JSON object of field → value.', 'Example: {"TITLE":"New bracket","PRIORITY":"2 / Medium"}');
    const out = [];
    for (const [key, value] of Object.entries(input)) {
      const f = this.matchField(m, key);
      if (!f.section) throw new FmError('FIELD_NOT_WRITABLE', `${f.name} is not on the item details form.`, 'It may live on another tab.');
      if (!f.editable && !f.derived) throw new FmError('FIELD_NOT_WRITABLE', `${f.name} cannot be edited (it is system-managed).`, 'Leave it out.');
      out.push({ f, value: await this.resolveValue(f, value) });
    }
    return out;
  }

  async create({ ws, fields, dryRun = false }) {
    const m = await this.meta(ws);
    const built = await this.buildFields(m, fields);
    const given = new Set(built.map((x) => x.f.id));
    const missing = m.fields.filter((f) => f.required && f.editable && f.section && !given.has(f.id) && (f.defaultValue === null || f.defaultValue === ''));
    if (missing.length) {
      const detail = await pool(missing, 4, async (f) => ({ id: f.id, name: f.name, type: f.type, ...(f.picklist ? { options: (await this.lookup(f.picklist, undefined, 30).catch(() => [])).map((o) => o.title) } : {}) }));
      throw new FmError('MISSING_REQUIRED', `${m.name} needs: ${missing.map((f) => f.name).join(', ')}.`, 'Ask the user for these values (offer the options), then run create again.', { missing: detail });
    }
    const payloadOf = (list) => {
      const sections = new Map();
      for (const { f, value } of list) {
        if (!sections.has(f.section.link)) sections.set(f.section.link, { link: f.section.link, fields: [] });
        sections.get(f.section.link).fields.push({ __self__: f.link, value });
      }
      return { sections: [...sections.values()] };
    };
    const summary = () => Object.fromEntries(built.map(({ f, value }) => [f.id, this.display(value)]));
    if (dryRun) return { dryRun: true, workspace: m.name, wouldCreate: summary(), payload: payloadOf(built), note: 'Nothing was sent. Show this to the user; run again without --dry-run once they approve.' };

    const derivedFilled = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      const r = await this.fm.request({ method: 'POST', path: `/api/v3/workspaces/${ws}/items`, body: payloadOf(built) });
      if (r.status === 201) {
        const loc = ITEM_LINK.exec(r.headers.location || '');
        if (!loc) throw new FmError('FM_ERROR', 'The record was created but Fusion Manage did not return its location.', 'Search for it by title; do not create it again.');
        const created = await this.item({ ws: loc[1], item: loc[2] });
        return { created: true, ws: loc[1], item: loc[2], title: created.title, state: created.state, url: created.url, ...(derivedFilled.length ? { derivedFilled } : {}) };
      }
      const problems = formatValidation(r.body);
      // A derived field must carry the value FM computes from its source; FM names that value.
      const derived = problems?.filter((p) => p.code === 'error.derived.invalidDerivedFieldValue' && p.arguments.length) || [];
      if (derived.length && derived.length === problems.length) {
        let progressed = false;
        for (const p of derived) {
          const f = m.fields.find((x) => x.id === p.field);
          if (!f || !f.section || built.some((x) => x.f.id === f.id)) continue;
          const arg = String(p.arguments[0]);
          built.push({ f, value: f.picklist ? { link: `${f.picklist}/options/${arg}` } : arg });
          derivedFilled.push(f.id);
          progressed = true;
        }
        if (progressed) continue;
      }
      if (problems) {
        throw new FmError('FM_VALIDATION', `Fusion Manage rejected the record: ${problems.map((p) => p.message).join(' ')}`, 'Fix the named fields and run create again. Nothing was created.', { status: r.status, problems });
      }
      throw fmHttpError(r, 'create the record');
    }
    throw new FmError('FM_VALIDATION', 'Fusion Manage kept asking for more derived fields.', 'Run `fmv fm describe` and supply the derived fields yourself.');
  }

  async update({ ws, item, fields, dryRun = false }) {
    requireId(item, 'item');
    const m = await this.meta(ws);
    const built = await this.buildFields(m, fields);
    const before = await this.item({ ws, item });
    // PATCH merges and needs the item's own links. PUT replaces the whole record, so it is never used.
    const sections = new Map();
    for (const { f, value } of built) {
      const sLink = `/api/v3/workspaces/${ws}/items/${item}/views/1/sections/${f.section.id}`;
      const fLink = f.link.replace(`/workspaces/${ws}/views/`, `/workspaces/${ws}/items/${item}/views/`);
      if (!sections.has(sLink)) sections.set(sLink, { link: sLink, fields: [] });
      sections.get(sLink).fields.push({ __self__: fLink, value });
    }
    const payload = { sections: [...sections.values()] };
    const changes = Object.fromEntries(built.map(({ f, value }) => [f.id, { from: before.fields[f.id] ?? null, to: this.display(value) }]));
    if (dryRun) return { dryRun: true, record: before.title, wouldChange: changes, payload, note: 'Nothing was sent. Show this to the user; run again without --dry-run once they approve.' };
    const r = await this.fm.request({ method: 'PATCH', path: `/api/v3/workspaces/${ws}/items/${item}`, body: payload });
    if (r.status >= 400) {
      const problems = formatValidation(r.body);
      if (problems) throw new FmError('FM_VALIDATION', `Fusion Manage rejected the change: ${problems.map((p) => p.message).join(' ')}`, 'Fix the named fields and try again. Nothing was changed.', { status: r.status, problems });
      throw fmHttpError(r, 'update the record');
    }
    const after = await this.item({ ws, item });
    return { updated: true, record: after.title, url: after.url, fields: Object.fromEntries(built.map(({ f }) => [f.id, { from: before.fields[f.id] ?? null, to: after.fields[f.id] ?? null }])) };
  }

  async archive({ ws, item, undo = false }) {
    requireId(ws, 'workspace');
    requireId(item, 'item');
    // Trust the record, not the status code: some workflows archive on their own (a cancel
    // transition, for example), and a repeat request answers 404.
    const before = await this.item({ ws, item });
    if (before.deleted === !undo) return { record: before.title, archived: before.deleted, alreadyDone: true, url: before.url };
    const r = await this.fm.request({ method: 'PATCH', path: `/api/v3/workspaces/${ws}/items/${item}`, query: { deleted: undo ? 'false' : 'true' }, body: {} });
    const after = await this.item({ ws, item });
    if (after.deleted === undo) {
      if (r.status >= 400) throw fmHttpError(r, undo ? 'restore the record' : 'archive the record');
      throw new FmError('FM_ERROR', 'Fusion Manage accepted the request but the record did not change.', 'Check the record in Fusion Manage.');
    }
    return { record: after.title, archived: after.deleted, url: after.url };
  }

  // ---------------------------------------------------------------------------------------------
  // workflow
  // ---------------------------------------------------------------------------------------------
  async transitions({ ws, item }) {
    requireId(ws, 'workspace');
    requireId(item, 'item');
    const [rec, t] = await Promise.all([this.item({ ws, item }), this.get(`/api/v3/workspaces/${ws}/items/${item}/workflows/1/transitions`, { allow: [403, 404] })]);
    const list = (Array.isArray(t) ? t : t?.transitions || []).map((x) => ({ id: tail(x.__self__), link: x.__self__, name: x.name, to: x.toState?.title || '', comment: x.comments || 'OPTIONAL' }));
    return { record: rec.title, state: rec.state, available: list.map(({ link, ...x }) => x), _links: list, ...(list.length === 0 ? { hint: 'No workflow transitions are available to you from this state.' } : {}) };
  }

  async transition({ ws, item, transition, comment, dryRun = false }) {
    const t = await this.transitions({ ws, item });
    const want = norm(transition);
    const list = t._links;
    const hits = list.filter((x) => x.id === String(transition) || norm(x.name) === want);
    const pick = hits.length ? hits : list.filter((x) => norm(x.name).includes(want) || norm(x.to) === want);
    if (pick.length !== 1) {
      throw new FmError(
        pick.length ? 'AMBIGUOUS_OPTION' : 'INVALID_OPTION',
        pick.length ? `"${transition}" matches several transitions.` : `"${transition}" is not available from "${t.state}".`,
        `Available: ${list.map((x) => `${x.name} → ${x.to}${x.comment === 'REQUIRED' ? ' (comment required)' : ''}`).join(' | ') || 'none'}`,
      );
    }
    const chosen = pick[0];
    if (chosen.comment === 'REQUIRED' && !String(comment || '').trim()) {
      throw new FmError('COMMENT_REQUIRED', `"${chosen.name}" needs a comment.`, 'Ask the user for the comment, then pass --comment "…".');
    }
    if (dryRun) return { dryRun: true, record: t.record, from: t.state, wouldRun: chosen.name, to: chosen.to, note: 'Nothing was sent. Transitions can notify people and lock records; confirm with the user first.' };
    const r = await this.fm.request({
      method: 'POST',
      path: `/api/v3/workspaces/${ws}/items/${item}/workflows/1/transitions`,
      body: comment ? { comment: String(comment) } : {},
      contentLocation: chosen.link,
    });
    // Success is 303 See Other. A 400 is a business rule from the tenant: report it, never retry.
    if (r.status >= 400) {
      const msg = typeof r.body === 'string' ? r.body : r.body?.message || formatValidation(r.body)?.map((p) => p.message).join(' ') || JSON.stringify(r.body);
      throw new FmError('TRANSITION_REFUSED', `Fusion Manage refused "${chosen.name}": ${String(msg).slice(0, 500)}`, 'This is a rule configured on the workflow. Tell the user what it says; the record is unchanged.', { status: r.status });
    }
    const after = await this.item({ ws, item });
    return { record: after.title, transition: chosen.name, from: t.state, to: after.state, url: after.url };
  }

  // ---------------------------------------------------------------------------------------------
  // affected items on a change record
  // ---------------------------------------------------------------------------------------------
  async affectedList({ ws, item }) {
    requireId(ws, 'workspace');
    requireId(item, 'item');
    const b = await this.get(`/api/v3/workspaces/${ws}/items/${item}/views/11`, { allow: [403], what: 'read the affected items' });
    const rows = (b?.affectedItems || []).map((a) => {
      const m = ITEM_LINK.exec(a.item?.link || '') || [];
      return { ws: m[1], item: m[2], title: a.item?.title, revision: a.item?.version || '', targetTransition: a.targetTransition?.title || null, from: a.fromRelease || '', to: a.toRelease || '', effectivity: a.effectivityDate || '' };
    });
    return { count: rows.length, affectedItems: rows };
  }

  async affectedAdd({ ws, item, items, dryRun = false }) {
    requireId(ws, 'workspace');
    requireId(item, 'item');
    const refs = (Array.isArray(items) ? items : [items]).map((r) => parseItemRef(r));
    if (!refs.length) throw new FmError('INVALID_ARGUMENT', 'List the items to add.', 'Example: fmv fm affected add 84 5001 57:1011 57:1012');
    // The array must hold absolute URLs; relative links are rejected.
    const urls = refs.map((r) => `${this.config.fmBaseUrl}/api/v3/workspaces/${r.ws}/items/${r.item}`);
    const target = await this.item({ ws, item });
    if (target.deleted) throw new FmError('RECORD_ARCHIVED', `${target.title} is archived.`, 'Items added to an archived record stay locked to it. Restore it first (fmv fm archive … --undo) or use another record.');
    // FM accepts an archived item and reports SUCCESS, but it never appears on the record.
    const checked = await pool(refs, 4, async (ref) => {
      try {
        const it = await this.item(ref);
        return { ...ref, title: it.title, archived: it.deleted };
      } catch (e) {
        return { ...ref, missing: true };
      }
    });
    const unusable = checked.filter((c) => c.archived || c.missing);
    if (unusable.length) {
      throw new FmError('INVALID_ARGUMENT', `Cannot add ${unusable.map((u) => `${u.ws}:${u.item}${u.archived ? ' (archived)' : ' (not found)'}`).join(', ')}.`, 'Check the item IDs with `fmv fm find`. Nothing was added.');
    }
    if (dryRun) return { dryRun: true, record: target.title, wouldAdd: checked.map(({ ws: w, item: i, title }) => ({ ws: w, item: i, title })), note: 'Nothing was sent.' };
    const r = await this.fm.request({ method: 'POST', path: `/api/v3/workspaces/${ws}/items/${item}/affected-items`, accept: AFFECTED_ACCEPT, body: urls });
    if (r.status >= 400) throw fmHttpError(r, 'add the affected items');
    // The call answers 200 even when rows fail, so every row is read.
    const results = await pool(Array.isArray(r.body) ? r.body : [], 4, async (row) => {
      const m = ITEM_LINK.exec(row.path || '') || [];
      const out = { ws: m[1], item: m[2], result: row.result };
      if (row.result !== 'SUCCESS') {
        out.error = row.errorMessage || 'Failed';
        if (/already been added/i.test(out.error) && m[1]) {
          try {
            const holders = await this.get(`/api/v3/workspaces/${m[1]}/items/${m[2]}/views/2`, { allow: [403, 404] });
            out.heldBy = (Array.isArray(holders) ? holders : []).map((h) => {
              const hm = ITEM_LINK.exec(h.item?.link || '') || [];
              return { ws: hm[1], item: hm[2], record: h.item?.title, state: h['workflow-state']?.title || h.item?.currentState || '', archived: Boolean(h.item?.deleted) };
            });
          } catch {}
        }
      }
      return out;
    });
    const failed = results.filter((x) => x.result !== 'SUCCESS');
    return {
      added: results.length - failed.length,
      failed: failed.length,
      results,
      ...(failed.some((f) => f.heldBy)
        ? { hint: 'An item can sit on only one open change at a time. heldBy names the record holding it (archived records still hold their items). Tell the user; only remove it from the other record if they agree: fmv fm affected remove <ws> <record> <itemWs>:<item>.' }
        : {}),
    };
  }

  async affectedRemove({ ws, item, items }) {
    requireId(ws, 'workspace');
    requireId(item, 'item');
    const refs = (Array.isArray(items) ? items : [items]).map((r) => parseItemRef(r));
    const results = [];
    for (const ref of refs) {
      const r = await this.fm.request({ method: 'DELETE', path: `/api/v3/workspaces/${ws}/items/${item}/views/11/affected-items/${ref.item}` });
      results.push({ ...ref, removed: r.status < 400, ...(r.status >= 400 ? { error: r.body?.message || `HTTP ${r.status}` } : {}) });
    }
    return { removed: results.filter((x) => x.removed).length, results };
  }

  async affectedTransitions({ ws, item, affected }) {
    const ref = parseItemRef(affected);
    const b = await this.get(`/api/v3/workspaces/${ws}/items/${item}/views/11/affected-items/${ref.item}/transitions`, { what: 'read the lifecycle transitions for this affected item' });
    // These entries carry an id but no link; the link lives beside the state links.
    const list = (Array.isArray(b) ? b : b?.transitions || b?.items || []).map((t) => ({
      link: t.__self__ || t.link || (t.fromState?.link ? t.fromState.link.replace(/\/states\/\d+$/, `/transitions/${t.id}`) : null),
      name: t.name || t.title,
      to: t.toState?.title || '',
    }));
    return { item: ref, available: list.map((t) => `${t.name}${t.to ? ` → ${t.to}` : ''}`), _links: list };
  }

  async affectedSet({ ws, item, affected, transition, dryRun = false }) {
    const t = await this.affectedTransitions({ ws, item, affected });
    const want = norm(transition);
    const exact = t._links.filter((x) => norm(x.name) === want);
    const loose = (x) => norm(x).replace(/[^a-z0-9]/g, '');
    const pick = exact.length ? exact : t._links.filter((x) => norm(x.name).includes(want) || loose(x.to) === loose(want));
    if (pick.length !== 1) throw new FmError(pick.length ? 'AMBIGUOUS_OPTION' : 'INVALID_OPTION', `"${transition}" is not a single lifecycle transition for this item.`, `Available: ${t.available.join(' | ') || 'none'}`);
    if (!pick[0].link) throw new FmError('FM_ERROR', 'Fusion Manage did not say how to address this transition.', 'Set it in the Fusion Manage UI instead.');
    if (dryRun) return { dryRun: true, wouldSet: pick[0].name, note: 'Nothing was sent.' };
    const r = await this.fm.request({ method: 'PUT', path: `/api/v3/workspaces/${ws}/items/${item}/views/11/affected-items/${t.item.item}`, body: { linkedFields: [], targetTransition: { link: pick[0].link } } });
    if (r.status >= 400) throw fmHttpError(r, 'set the lifecycle transition');
    const list = await this.affectedList({ ws, item });
    return { set: pick[0].name, affectedItem: list.affectedItems.find((a) => a.item === t.item.item) || null };
  }
}

export const OPS = {
  find: { fn: 'find', write: false },
  workspaces: { fn: 'workspaces', write: false },
  describe: { fn: 'describe', write: false },
  options: { fn: 'options', write: false },
  item: { fn: 'item', write: false },
  bom: { fn: 'bom', write: false },
  related: { fn: 'related', write: false },
  transitions: { fn: 'transitions', write: false },
  'affected-list': { fn: 'affectedList', write: false },
  'affected-transitions': { fn: 'affectedTransitions', write: false },
  create: { fn: 'create', write: true },
  update: { fn: 'update', write: true },
  archive: { fn: 'archive', write: true },
  transition: { fn: 'transition', write: true },
  'affected-add': { fn: 'affectedAdd', write: true },
  'affected-remove': { fn: 'affectedRemove', write: true },
  'affected-set': { fn: 'affectedSet', write: true },
};
