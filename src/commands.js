// Typed viewer and panel commands (spec 0002). Every command is validated here before it is
// relayed to the browser; anything not described below is rejected.

export class CommandError extends Error {
  constructor(message, hint) {
    super(message);
    this.code = 'INVALID_COMMAND';
    this.hint = hint;
  }
}

const HEX = /^#?[0-9a-f]{6}([0-9a-f]{2})?$/i;
const NAMED_VIEWS = ['home', 'front', 'back', 'left', 'right', 'top', 'bottom', 'iso', 'front top right', 'front top left', 'back top right', 'back top left'];
const PANELS = ['bom', 'table', 'markdown', 'card'];
const MAX_IDS = 50_000;

function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function str(v, name, { max = 500, required = true } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw new CommandError(`${name} is required.`);
    return undefined;
  }
  if (typeof v !== 'string' && typeof v !== 'number') throw new CommandError(`${name} must be text.`);
  const s = String(v);
  if (s.length > max) throw new CommandError(`${name} is too long (max ${max} characters).`);
  return s;
}

function num(v, name, { min = -Infinity, max = Infinity, required = true, fallback } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw new CommandError(`${name} is required.`);
    return fallback;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new CommandError(`${name} must be a number from ${min} to ${max}.`);
  return n;
}

function bool(v, fallback = false) {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  return ['true', '1', 'yes', 'on'].includes(String(v).toLowerCase());
}

function color(v, name = 'color') {
  const s = str(v, name, { max: 9 });
  if (!HEX.test(s)) throw new CommandError(`${name} must be a hex colour like #ff6600.`);
  return s.startsWith('#') ? s.toLowerCase() : `#${s.toLowerCase()}`;
}

function vec3(v, name) {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : null;
  if (!arr || arr.length !== 3) throw new CommandError(`${name} must be three numbers x,y,z.`);
  return arr.map((n, i) => num(n, `${name}[${i}]`));
}

/** Parts to act on: dbIds, a name pattern, or a property match. */
export function targets(v, { required = true } = {}) {
  if (v === undefined || v === null) {
    if (required) throw new CommandError('Say which parts: --dbid, --name or --prop "Name=value".', 'Use --all for every part.');
    return undefined;
  }
  if (!isObj(v)) throw new CommandError('targets must be an object.');
  const out = {};
  let count = 0;
  if (v.all) {
    out.all = true;
    count++;
  }
  if (v.dbids !== undefined) {
    const ids = Array.isArray(v.dbids) ? v.dbids : String(v.dbids).split(',');
    if (ids.length === 0 || ids.length > MAX_IDS) throw new CommandError(`dbids must list 1 to ${MAX_IDS} IDs.`);
    out.dbids = ids.map((n) => {
      const id = Number(n);
      if (!Number.isInteger(id) || id < 0) throw new CommandError('dbids must be whole numbers.');
      return id;
    });
    count++;
  }
  if (v.name !== undefined) {
    out.name = str(v.name, 'name', { max: 200 });
    count++;
  }
  if (v.prop !== undefined) {
    if (!isObj(v.prop)) throw new CommandError('prop must be { name, values }.');
    const values = Array.isArray(v.prop.values) ? v.prop.values : [v.prop.values ?? v.prop.value];
    if (values.length === 0 || values.length > MAX_IDS) throw new CommandError('prop needs at least one value.');
    out.prop = { name: str(v.prop.name, 'prop name', { max: 200 }), values: values.map((x) => str(x, 'prop value', { max: 500 })) };
    count++;
  }
  if (count !== 1) throw new CommandError('Give exactly one of dbids, name, prop or all.');
  return out;
}

/** Validators return the cleaned args or throw CommandError. */
const VIEW = {
  load: (a) => ({ urn: str(a.urn, 'urn', { max: 2000 }), label: str(a.label, 'label', { required: false, max: 300 }) }),
  fit: (a) => ({ targets: targets(a.targets, { required: false }) }),
  reset: () => ({}),
  isolate: (a) => ({ targets: targets(a.targets) }),
  hide: (a) => ({ targets: targets(a.targets) }),
  show: (a) => ({ targets: targets(a.targets, { required: false }) }),
  ghost: (a) => ({ on: bool(a.on, true) }),
  color: (a) => {
    if (a.groups !== undefined) {
      if (!Array.isArray(a.groups) || a.groups.length === 0 || a.groups.length > 100) throw new CommandError('groups must list 1 to 100 { color, targets } entries.');
      return {
        groups: a.groups.map((g, i) => {
          if (!isObj(g)) throw new CommandError(`groups[${i}] must be an object.`);
          return { color: color(g.color, `groups[${i}].color`), targets: targets(g.targets), label: str(g.label, 'label', { required: false, max: 100 }) };
        }),
        legend: bool(a.legend, true),
      };
    }
    return { groups: [{ color: color(a.color), targets: targets(a.targets), label: str(a.label, 'label', { required: false, max: 100 }) }], legend: bool(a.legend, false) };
  },
  clearColor: () => ({}),
  section: (a) => {
    if (bool(a.off)) return { off: true };
    const plane = str(a.plane, 'plane', { max: 1 }).toLowerCase();
    if (!['x', 'y', 'z'].includes(plane)) throw new CommandError('plane must be x, y or z.');
    return { plane, offset: num(a.offset, 'offset', { min: -1, max: 1, required: false, fallback: 0 }), flip: bool(a.flip) };
  },
  explode: (a) => ({ scale: num(a.scale, 'scale', { min: 0, max: 1 }) }),
  camera: (a) => {
    if (a.eye !== undefined || a.target !== undefined) return { eye: vec3(a.eye, 'eye'), target: vec3(a.target, 'target') };
    const view = str(a.view, 'view', { max: 40 }).toLowerCase();
    if (!NAMED_VIEWS.includes(view)) throw new CommandError(`view must be one of: ${NAMED_VIEWS.join(', ')}.`);
    return { view };
  },
  select: (a) => ({ targets: targets(a.targets, { required: false }) }),
  screenshot: (a) => ({
    width: num(a.width, 'width', { min: 64, max: 4096, required: false }),
    height: num(a.height, 'height', { min: 64, max: 4096, required: false }),
  }),
  getSelection: () => ({}),
  getState: () => ({}),
  getProperties: (a) => ({
    targets: targets(a.targets),
    properties: a.properties === undefined ? undefined : (Array.isArray(a.properties) ? a.properties : String(a.properties).split(',')).map((p) => str(p, 'property', { max: 200 })),
    limit: num(a.limit, 'limit', { min: 1, max: 5000, required: false, fallback: 200 }),
  }),
  propertyNames: () => ({}),
};

function rows(v, name, max = 20_000) {
  if (!Array.isArray(v)) throw new CommandError(`${name} must be an array.`);
  if (v.length > max) throw new CommandError(`${name} has too many rows (max ${max}).`);
  return v;
}

const PANEL = {
  bom: (d) => {
    if (!isObj(d)) throw new CommandError('BOM data must be an object with rows.');
    return {
      rows: rows(d.rows, 'rows').map((r, i) => {
        if (!isObj(r)) throw new CommandError(`rows[${i}] must be an object.`);
        return {
          level: num(r.level, 'level', { min: 0, max: 50, required: false, fallback: 0 }),
          number: str(r.number, 'number', { required: false, max: 200 }) ?? '',
          title: str(r.title, 'title', { required: false, max: 500 }) ?? '',
          quantity: r.quantity === undefined ? '' : String(r.quantity).slice(0, 50),
          state: str(r.state, 'state', { required: false, max: 100 }) ?? '',
          color: r.color ? color(r.color, `rows[${i}].color`) : undefined,
        };
      }),
      matchProperty: str(d.matchProperty, 'matchProperty', { required: false, max: 200 }),
    };
  },
  table: (d) => {
    if (!isObj(d)) throw new CommandError('Table data must be an object with columns and rows.');
    const columns = rows(d.columns, 'columns', 100).map((c) => str(typeof c === 'object' && c ? c.label ?? c.key : c, 'column', { max: 200 }));
    const body = rows(d.rows, 'rows').map((r) => {
      if (Array.isArray(r)) return r.slice(0, columns.length).map((c) => (c === null || c === undefined ? '' : String(c).slice(0, 2000)));
      if (isObj(r)) {
        const keys = d.columns.map((c) => (typeof c === 'object' && c ? c.key ?? c.label : c));
        return keys.map((k) => (r[k] === null || r[k] === undefined ? '' : String(r[k]).slice(0, 2000)));
      }
      throw new CommandError('Each table row must be an array or an object.');
    });
    return { columns, rows: body };
  },
  markdown: (d) => ({ text: str(typeof d === 'string' ? d : d?.text, 'text', { max: 200_000 }) }),
  card: (d) => {
    if (!isObj(d)) throw new CommandError('Card data must be an object.');
    return {
      title: str(d.title, 'title', { max: 500 }),
      subtitle: str(d.subtitle, 'subtitle', { required: false, max: 500 }),
      state: str(d.state, 'state', { required: false, max: 100 }),
      link: d.link ? safeHttpUrl(d.link) : undefined,
      fields: rows(d.fields ?? [], 'fields', 200).map((f) => ({ label: str(f?.label, 'field label', { max: 200 }), value: f?.value === undefined || f?.value === null ? '' : String(f.value).slice(0, 5000) })),
    };
  },
};

export function safeHttpUrl(v) {
  const s = str(v, 'link', { max: 2000 });
  try {
    const u = new URL(s);
    if (u.protocol === 'https:' || u.protocol === 'http:') return u.toString();
  } catch {}
  throw new CommandError('link must be an http(s) URL.');
}

export const VIEW_COMMANDS = Object.keys(VIEW);
export const PANEL_TYPES = PANELS;

export function validateViewCommand(command, args = {}) {
  const fn = Object.hasOwn(VIEW, command) ? VIEW[command] : null;
  if (!fn) throw new CommandError(`Unknown viewer command "${command}".`, `Known commands: ${VIEW_COMMANDS.join(', ')}.`);
  if (!isObj(args)) throw new CommandError('Command arguments must be an object.');
  return fn(args);
}

export function validatePanel(panel, data, opts = {}) {
  const fn = Object.hasOwn(PANEL, panel) ? PANEL[panel] : null;
  if (!fn) throw new CommandError(`Unknown panel "${panel}".`, `Panels: ${PANELS.join(', ')}.`);
  return { panel, title: str(opts.title, 'title', { required: false, max: 300 }), focus: bool(opts.focus, true), data: fn(data) };
}
