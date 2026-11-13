// APS Viewer wrapper: loads the library from Autodesk's CDN, opens FM derivative URNs with the
// user's own token (fetched from the local server), and implements every typed viewer command.

export const VIEWER_VERSION = '7.*';
const VIEWER_BASE = `https://developer.api.autodesk.com/modelderivative/v2/viewers/${VIEWER_VERSION}`;

export class ViewerError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

let libraryPromise = null;
function loadLibrary() {
  if (window.Autodesk?.Viewing) return Promise.resolve();
  if (libraryPromise) return libraryPromise;
  libraryPromise = new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `${VIEWER_BASE}/style.min.css`;
    document.head.appendChild(link);
    const script = document.createElement('script');
    script.src = `${VIEWER_BASE}/viewer3D.min.js`;
    script.onload = () => (window.Autodesk?.Viewing ? resolve() : reject(new ViewerError('VIEWER_LIBRARY', 'The viewer library loaded but is not usable.')));
    script.onerror = () => {
      libraryPromise = null;
      script.remove();
      reject(new ViewerError('VIEWER_LIBRARY', 'Could not load the Autodesk viewer library.', 'Check the network connection, then retry.'));
    };
    document.head.appendChild(script);
  });
  return libraryPromise;
}

function hexToVector4(hex) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return new window.THREE.Vector4(r, g, b, a);
}

function wildcardToRegex(pattern) {
  if (!/[*?]/.test(pattern)) return null;
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`, 'i');
}

const norm = (v) => String(v ?? '').trim().toLowerCase();

export class ViewerController {
  /**
   * @param {HTMLElement} container
   * @param {{ getToken: () => Promise<{access_token: string, expires_in: number}>, onSelection: (ids: number[]) => void, onAuthProblem: () => void }} hooks
   */
  constructor(container, hooks) {
    this.container = container;
    this.hooks = hooks;
    this.viewer = null;
    this.model = null;
    this.propCache = new Map();
    this.colorGroups = [];
    this.section = null;
    this.initPromise = null;
    this.theme = 'light';
  }

  init() {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      await loadLibrary();
      const AV = window.Autodesk.Viewing;
      await new Promise((resolve) =>
        AV.Initializer(
          {
            env: 'AutodeskProduction',
            api: 'derivativeV2',
            getAccessToken: (cb) => {
              this.hooks
                .getToken()
                .then((t) => cb(t.access_token, t.expires_in))
                .catch(() => {
                  this.hooks.onAuthProblem();
                  cb('', 0);
                });
            },
          },
          resolve,
        ),
      );
      const viewer = new AV.GuiViewer3D(this.container, { theme: this.theme === 'dark' ? 'dark-theme' : 'light-theme' });
      const code = viewer.start();
      if (code > 0) {
        this.initPromise = null;
        throw new ViewerError('WEBGL_UNAVAILABLE', 'This browser cannot start the 3D viewer (WebGL is unavailable).', 'Use a current Chrome, Edge or Firefox with hardware acceleration on.');
      }
      let selTimer = null;
      viewer.addEventListener(AV.SELECTION_CHANGED_EVENT, () => {
        clearTimeout(selTimer);
        selTimer = setTimeout(() => this.hooks.onSelection(viewer.getSelection()), 150);
      });
      this.viewer = viewer;
      this.applyTheme(this.theme);
      return viewer;
    })().catch((e) => {
      this.initPromise = null;
      throw e;
    });
    return this.initPromise;
  }

  applyTheme(theme) {
    this.theme = theme;
    if (!this.viewer) return;
    try {
      this.viewer.setTheme(theme === 'dark' ? 'dark-theme' : 'light-theme');
      if (theme === 'dark') this.viewer.setBackgroundColor(43, 46, 51, 43, 46, 51);
      else this.viewer.setBackgroundColor(233, 233, 233, 250, 250, 250);
    } catch {}
  }

  requireModel() {
    if (!this.viewer || !this.model) throw new ViewerError('MODEL_NOT_LOADED', 'No model is loaded in the viewer.', 'Run `fmv view load …` first.');
    return this.model;
  }

  // -------------------------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------------------------
  async load({ urn }) {
    const viewer = await this.init();
    const AV = window.Autodesk.Viewing;
    const doc = await new Promise((resolve, reject) =>
      AV.Document.load(
        `urn:${urn}`,
        resolve,
        (code, message) => {
          const denied = code === AV.ErrorCodes?.NETWORK_ACCESS_DENIED || code === 4;
          reject(
            new ViewerError(
              denied ? 'VIEWER_ACCESS_DENIED' : 'LOAD_FAILED',
              `The viewer could not open the model (error ${code}${message ? `: ${message}` : ''}).`,
              denied ? 'Sign in again with `fmv login`; your token may not cover this model.' : 'Retry; if it persists, re-open the file in Fusion Manage.',
            ),
          );
        },
      ),
    );
    const root = doc.getRoot();
    const node = root.getDefaultGeometry() || root.search({ type: 'geometry' })[0];
    if (!node) throw new ViewerError('NOT_VIEWABLE', 'The model has no viewable geometry.', 'Pick another attachment.');

    for (const m of viewer.getAllModels ? viewer.getAllModels() : this.model ? [this.model] : []) viewer.unloadModel(m);
    this.model = null;
    this.propCache.clear();
    this.colorGroups = [];
    this.section = null;

    const model = await viewer.loadDocumentNode(doc, node, { keepCurrentModels: false });
    await new Promise((resolve) => {
      if (model.isLoadDone && model.isLoadDone()) return resolve();
      const onDone = (e) => {
        if (e.model && e.model !== model) return;
        viewer.removeEventListener(AV.GEOMETRY_LOADED_EVENT, onDone);
        resolve();
      };
      viewer.addEventListener(AV.GEOMETRY_LOADED_EVENT, onDone);
    });
    await new Promise((resolve) => model.getObjectTree(() => resolve(), () => resolve()));
    this.model = model;
    const tree = model.getInstanceTree();
    let parts = 0;
    // enumNodeChildren stops when the callback returns a truthy value, so callbacks never return.
    if (tree) {
      tree.enumNodeChildren(
        tree.getRootId(),
        (id) => {
          if (tree.getChildCount(id) === 0) parts++;
        },
        true,
      );
    }
    return { is2d: node.is2D(), parts, summary: `${parts} parts` };
  }

  // -------------------------------------------------------------------------------------------
  // Part targeting
  // -------------------------------------------------------------------------------------------
  allNodeIds() {
    const tree = this.model.getInstanceTree();
    if (!tree) return [];
    const ids = [];
    tree.enumNodeChildren(
      tree.getRootId(),
      (id) => {
        ids.push(id); // no return: a truthy return value stops the enumeration
      },
      true,
    );
    return ids;
  }

  bulkProps(ids, propFilter) {
    return new Promise((resolve, reject) =>
      this.model.getBulkProperties(ids, { propFilter, ignoreHidden: false }, resolve, (e) => reject(new ViewerError('PROPERTIES_FAILED', `Could not read properties (${e?.message || e}).`))),
    );
  }

  /** Map of node id -> value of one property (by display or attribute name), cached per model. */
  async propertyIndex(name) {
    const key = norm(name);
    if (this.propCache.has(key)) return this.propCache.get(key);
    const results = await this.bulkProps(this.allNodeIds(), [name]);
    const index = new Map();
    for (const r of results) {
      const p = r.properties.find((x) => norm(x.displayName) === key || norm(x.attributeName) === key);
      if (p && p.displayValue !== '' && p.displayValue !== null && p.displayValue !== undefined) index.set(r.dbId, String(p.displayValue));
    }
    this.propCache.set(key, index);
    return index;
  }

  /** Resolve targets to dbIds. Returns { ids, matched, unmatched? }. */
  async resolve(targets) {
    const model = this.requireModel();
    const tree = model.getInstanceTree();
    if (targets.all) return { ids: tree ? [tree.getRootId()] : [], matched: 'all' };
    if (targets.dbids) return { ids: targets.dbids, matched: targets.dbids.length };
    if (targets.name) {
      const re = wildcardToRegex(targets.name);
      const needle = norm(targets.name);
      const ids = this.allNodeIds().filter((id) => {
        const n = tree.getNodeName(id) || '';
        return re ? re.test(n) : norm(n).includes(needle);
      });
      return { ids: this.topmost(ids), matched: ids.length };
    }
    if (targets.prop) {
      const { name, values } = targets.prop;
      const wanted = new Map(values.map((v) => [norm(v), v]));
      const found = new Set();
      let ids = [];
      if (norm(name) === 'name') {
        for (const id of this.allNodeIds()) {
          const v = norm(tree.getNodeName(id));
          if (wanted.has(v)) {
            ids.push(id);
            found.add(v);
          }
        }
      } else {
        const index = await this.propertyIndex(name);
        for (const [id, value] of index) {
          const v = norm(value);
          if (wanted.has(v)) {
            ids.push(id);
            found.add(v);
          }
        }
      }
      ids = this.topmost(ids);
      const unmatched = [...wanted.entries()].filter(([k]) => !found.has(k)).map(([, v]) => v);
      return { ids, matched: ids.length, ...(unmatched.length ? { unmatched } : {}) };
    }
    return { ids: [], matched: 0 };
  }

  /** Drop ids whose ancestor is already in the set (acting on the parent covers them). */
  topmost(ids) {
    const tree = this.model.getInstanceTree();
    const set = new Set(ids);
    return ids.filter((id) => {
      let p = tree.getNodeParentId(id);
      while (p !== undefined && p !== null && p > 0) {
        if (set.has(p)) return false;
        p = tree.getNodeParentId(p);
      }
      return true;
    });
  }

  report(r, verb) {
    const out = { matched: r.matched, ids: r.ids.length > 200 ? `${r.ids.length} ids` : r.ids };
    if (r.unmatched) out.unmatched = r.unmatched;
    out.summary = `${verb} ${r.matched === 'all' ? 'all parts' : `${r.matched} match${r.matched === 1 ? '' : 'es'}`}${r.unmatched ? `, ${r.unmatched.length} not found` : ''}`;
    if (r.matched === 0) out.hint = 'Nothing matched. Run `fmv view property-names` to see which properties this model has, or try --name.';
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------------------------
  async run(command, args) {
    const v = this.viewer;
    switch (command) {
      case 'load':
        return this.load(args);
      case 'fit': {
        this.requireModel();
        if (!args.targets) {
          v.fitToView();
          return { summary: 'Fit all' };
        }
        const r = await this.resolve(args.targets);
        if (r.ids.length) v.fitToView(r.ids, this.model);
        return this.report(r, 'Fit');
      }
      case 'reset':
        this.requireModel();
        v.showAll();
        v.clearThemingColors(this.model);
        v.setCutPlanes([]);
        v.explode(0);
        v.clearSelection();
        v.setGhosting(true);
        v.fitToView();
        this.legend?.(null);
        this.colorGroups = [];
        this.section = null;
        return { summary: 'Reset view' };
      case 'isolate': {
        const r = await this.resolve(args.targets);
        if (r.ids.length) v.isolate(r.ids, this.model);
        return this.report(r, 'Isolated');
      }
      case 'hide': {
        const r = await this.resolve(args.targets);
        if (r.ids.length) v.hide(r.ids, this.model);
        return this.report(r, 'Hid');
      }
      case 'show': {
        this.requireModel();
        if (!args.targets || args.targets.all) {
          v.showAll();
          return { summary: 'Showing all parts' };
        }
        const r = await this.resolve(args.targets);
        if (r.ids.length) v.show(r.ids, this.model);
        return this.report(r, 'Showed');
      }
      case 'ghost':
        this.requireModel();
        v.setGhosting(args.on);
        return { summary: `Ghosting ${args.on ? 'on' : 'off'}` };
      case 'color': {
        this.requireModel();
        const results = [];
        for (const g of args.groups) {
          const r = await this.resolve(g.targets);
          const vec = hexToVector4(g.color);
          for (const id of r.ids) v.setThemingColor(id, vec, this.model, true);
          results.push({ color: g.color, label: g.label, ...this.report(r, 'Coloured') });
          // A group that matched nothing is reported, but never shown in the legend.
          if (r.ids.length) this.colorGroups.push({ color: g.color, label: g.label || '', ids: r.ids });
        }
        v.impl.invalidate(true);
        // The legend always reflects every labelled colour currently applied.
        const entries = this.colorGroups.filter((g) => g.label).map((g) => ({ color: g.color, label: g.label, count: g.ids.length }));
        this.legend?.(entries.length ? entries : null);
        const total = results.reduce((n, x) => n + (typeof x.matched === 'number' ? x.matched : 0), 0);
        return { groups: results, summary: `Coloured ${total} matches in ${results.length} group${results.length === 1 ? '' : 's'}` };
      }
      case 'clearColor':
        this.requireModel();
        v.clearThemingColors(this.model);
        this.legend?.(null);
        this.colorGroups = [];
        return { summary: 'Cleared colours' };
      case 'section': {
        this.requireModel();
        if (args.off) {
          v.setCutPlanes([]);
          this.section = null;
          return { summary: 'Section off' };
        }
        const box = this.model.getBoundingBox();
        const axis = { x: 0, y: 1, z: 2 }[args.plane];
        const min = [box.min.x, box.min.y, box.min.z];
        const max = [box.max.x, box.max.y, box.max.z];
        const center = (min[axis] + max[axis]) / 2;
        const half = (max[axis] - min[axis]) / 2;
        const pos = center + args.offset * half;
        const n = [0, 0, 0];
        n[axis] = args.flip ? -1 : 1;
        // Cut planes discard the side where n·p + d > 0.
        const d = -(n[axis] * pos);
        v.setCutPlanes([new window.THREE.Vector4(n[0], n[1], n[2], d)]);
        this.section = { plane: args.plane, offset: args.offset, flip: args.flip };
        return { plane: args.plane, offset: args.offset, flip: args.flip, position: pos, summary: `Section on ${args.plane.toUpperCase()} at ${Math.round(args.offset * 100)}%` };
      }
      case 'explode':
        this.requireModel();
        v.explode(args.scale);
        return { summary: `Explode ${Math.round(args.scale * 100)}%` };
      case 'camera': {
        this.requireModel();
        if (args.eye) {
          const T = window.THREE;
          v.navigation.setView(new T.Vector3(...args.eye), new T.Vector3(...args.target));
          return { summary: 'Camera set' };
        }
        if (args.view === 'home') {
          if (v.autocam?.goHome) v.autocam.goHome();
          else v.fitToView();
          return { summary: 'Home view' };
        }
        const cube = v.getExtension('Autodesk.ViewCubeUi') || (await v.loadExtension('Autodesk.ViewCubeUi'));
        cube.setViewCube(args.view === 'iso' ? 'front top right' : args.view);
        return { summary: `${args.view} view` };
      }
      case 'select': {
        this.requireModel();
        if (!args.targets) {
          v.clearSelection();
          return { summary: 'Selection cleared' };
        }
        const r = await this.resolve(args.targets);
        v.select(r.ids, this.model);
        return this.report(r, 'Selected');
      }
      case 'screenshot':
        return this.screenshot(args);
      case 'getSelection': {
        this.requireModel();
        const ids = v.getSelection();
        return { ids, parts: await this.describe(ids.slice(0, 50)), summary: `${ids.length} selected` };
      }
      case 'getState': {
        this.requireModel();
        const name = async (ids) => (await this.describe(ids.slice(0, 40))).map((p) => ({ dbId: p.dbId, name: p.name, partNumber: p.properties['Part Number'] ?? null }));
        const isolated = v.getIsolatedNodes(this.model) || [];
        const hidden = v.getHiddenNodes(this.model) || [];
        const selected = v.getSelection();
        const out = {
          isolated: { count: isolated.length, parts: await name(isolated) },
          hidden: { count: hidden.length, parts: await name(hidden) },
          selected: { count: selected.length, parts: await name(selected) },
          colours: await Promise.all(this.colorGroups.map(async (g) => ({ color: g.color, label: g.label, count: g.ids.length, parts: await name(g.ids) }))),
          explode: v.getExplodeScale ? v.getExplodeScale() : 0,
          section: this.section,
          ghosting: v.prefs?.get ? Boolean(v.prefs.get('ghosting')) : null,
        };
        const focus = selected.length ? 'selected' : isolated.length ? 'isolated' : null;
        out.focus = focus;
        out.summary = focus ? `${out[focus].count} ${focus}` : 'Whole model shown, nothing selected';
        if (!focus) out.hint = 'Nothing is isolated or selected, so "this part" is ambiguous. Ask the user which part they mean.';
        return out;
      }
      case 'getProperties': {
        const r = await this.resolve(args.targets);
        const ids = r.ids.slice(0, args.limit);
        const filter = args.properties ? ['name', ...args.properties] : undefined;
        const res = await this.bulkProps(ids, filter);
        return {
          matched: r.matched,
          truncated: r.ids.length > ids.length,
          parts: res.map((p) => ({ dbId: p.dbId, name: p.name, properties: Object.fromEntries(p.properties.map((x) => [x.displayName, x.displayValue])) })),
          summary: `Properties for ${res.length} parts`,
        };
      }
      case 'propertyNames': {
        this.requireModel();
        const ids = this.allNodeIds();
        const sample = ids.length > 400 ? ids.filter((_, i) => i % Math.ceil(ids.length / 400) === 0) : ids;
        const res = await this.bulkProps(sample);
        const counts = new Map();
        for (const r of res) {
          for (const p of r.properties) {
            if (p.hidden) continue;
            const k = p.displayName;
            const c = counts.get(k) || { name: k, category: p.displayCategory || '', count: 0, example: '' };
            c.count++;
            if (!c.example && p.displayValue !== '' && p.displayValue !== null) c.example = String(p.displayValue).slice(0, 60);
            counts.set(k, c);
          }
        }
        const list = [...counts.values()].sort((a, b) => b.count - a.count);
        return { sampled: sample.length, totalNodes: ids.length, properties: list, summary: `${list.length} property names` };
      }
      default:
        throw new ViewerError('INVALID_COMMAND', `Unknown viewer command "${command}".`);
    }
  }

  async describe(ids) {
    if (!ids.length) return [];
    const res = await this.bulkProps(ids);
    return res.map((p) => ({
      dbId: p.dbId,
      name: p.name,
      properties: Object.fromEntries(p.properties.filter((x) => !x.hidden).slice(0, 60).map((x) => [x.displayName, x.displayValue])),
    }));
  }

  async screenshot({ width, height }) {
    this.requireModel();
    const w = Math.round(width || this.container.clientWidth);
    const h = Math.round(height || this.container.clientHeight);
    const blobUrl = await new Promise((resolve) => this.viewer.getScreenShot(w, h, resolve));
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new ViewerError('SCREENSHOT_FAILED', 'Could not capture the view.'));
      img.src = blobUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    URL.revokeObjectURL?.(blobUrl);
    return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height, summary: `Screenshot ${canvas.width}×${canvas.height}` };
  }
}
