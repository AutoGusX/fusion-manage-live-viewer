// Viewer page: connects to the local server over Server-Sent Events, runs commands one at a time,
// posts results and user events back. Only talks to its own origin.

import { Panels } from './panels.js';
import { ViewerController } from './viewer.js';

const $ = (id) => document.getElementById(id);
const state = { signedIn: false, unsafeEval: false, tenant: '', fmBaseUrl: '' };

async function post(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
  return r.json().catch(() => ({}));
}

function sendEvent(type, data) {
  post('/ui/event', { type, data }).catch(() => {});
}

function setChip(id, tone, text) {
  const chip = $(id);
  chip.dataset.tone = tone;
  chip.querySelector('.dot').textContent = { ok: '●', warn: '◐', bad: '■' }[tone] || '◇';
  chip.querySelector('.chip-text').textContent = text;
}

function setAuth(signedIn) {
  state.signedIn = signedIn;
  setChip('chip-auth', signedIn ? 'ok' : 'warn', signedIn ? 'Signed in' : 'Not signed in');
  $('btn-signin').hidden = signedIn;
  if (signedIn) hideBanner();
}

function showBanner(text, tone = 'warn') {
  const b = $('banner');
  b.dataset.tone = tone;
  b.textContent = text;
  b.hidden = false;
}
function hideBanner() {
  $('banner').hidden = true;
}

function showProgress(text) {
  $('progress-text').textContent = text;
  $('progress').hidden = !text;
}

// Legend ---------------------------------------------------------------------------------------
function renderLegend(entries) {
  const box = $('legend');
  if (!entries || !entries.length) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  box.replaceChildren(
    ...entries.map((e) => {
      const row = document.createElement('div');
      row.className = 'legend-row';
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = e.color;
      const label = document.createElement('span');
      label.textContent = e.label;
      const count = document.createElement('span');
      count.className = 'legend-count';
      count.textContent = typeof e.count === 'number' ? String(e.count) : '';
      row.append(sw, label, count);
      return row;
    }),
  );
  box.hidden = false;
}

// Viewer + panels --------------------------------------------------------------------------------
const viewer = new ViewerController($('viewer'), {
  getToken: async () => {
    const r = await fetch('/ui/token', { credentials: 'same-origin' });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error?.message || 'No token');
    return data.result;
  },
  onAuthProblem: () => {
    setAuth(false);
    showBanner('Your Autodesk session has ended. Sign in again to keep viewing models.');
  },
  onSelection: async (ids) => {
    let parts = [];
    try {
      parts = await viewer.describe(ids.slice(0, 5));
    } catch {}
    sendEvent('selection', { ids, parts });
  },
});
viewer.legend = renderLegend;
viewer.applyTheme(document.documentElement.classList.contains('dark-theme') ? 'dark' : 'light');

const panels = new Panels($('dock'), {
  onBomRow: async (row, matchProperty) => {
    sendEvent('panelClick', { panel: 'bom', row });
    if (!viewer.model || !row.number) return;
    try {
      const targets = matchProperty ? { prop: { name: matchProperty, values: [row.number] } } : { name: row.number };
      const r = await viewer.run('isolate', { targets });
      if (r.matched) await viewer.run('fit', { targets });
    } catch {}
  },
  onTableRow: (index, row, columns) => sendEvent('panelClick', { panel: 'table', index, row: Object.fromEntries(columns.map((c, i) => [c, row[i]])) }),
});

// Commands run strictly one after another so they can't interleave.
let queue = Promise.resolve();
function runCommand({ id, command, args }) {
  queue = queue.then(async () => {
    try {
      let result;
      if (command === 'panel') result = panels.show(args);
      else if (command === 'clearPanels') result = panels.clear(args.panel);
      else if (command === 'eval') {
        if (!state.unsafeEval) throw Object.assign(new Error('eval is disabled.'), { code: 'INVALID_COMMAND' });
        // Only reachable when the server was started with --unsafe-eval (banner shown).
        // eslint-disable-next-line no-new-func
        const fn = new Function('viewer', 'model', 'THREE', 'Autodesk', `return (async () => { ${args.code} })();`);
        result = { value: await fn(viewer.viewer, viewer.model, window.THREE, window.Autodesk) };
      } else {
        if (command === 'load') {
          $('empty').hidden = true;
          showProgress(`Loading ${args.label || 'model'}…`);
        }
        try {
          result = await viewer.run(command, args);
        } finally {
          if (command === 'load') showProgress('');
        }
        if (command === 'load') {
          $('model-label').textContent = args.label || 'Model';
          $('model-label').title = args.label || '';
          renderLegend(null);
          sendEvent('modelLoaded', { label: args.label, parts: result.parts, is2d: result.is2d });
        }
      }
      await post('/ui/result', { id, ok: true, result });
    } catch (e) {
      if (command === 'load' && !viewer.model) $('empty').hidden = false;
      await post('/ui/result', { id, ok: false, error: { code: e.code || 'VIEWER_ERROR', message: e.message || String(e), hint: e.hint } });
    }
  });
}

// Stream ---------------------------------------------------------------------------------------
function connect() {
  const es = new EventSource('/ui/stream');
  es.onopen = () => setChip('chip-connection', 'ok', 'Connected');
  es.onerror = () => setChip('chip-connection', 'bad', 'Reconnecting…');
  es.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === 'hello') {
      state.tenant = msg.tenant;
      state.fmBaseUrl = msg.fmBaseUrl;
      state.unsafeEval = Boolean(msg.unsafeEval);
      $('chip-tenant').textContent = msg.tenant;
      $('chip-tenant').title = msg.fmBaseUrl;
      setAuth(Boolean(msg.signedIn));
      panels.setActivity(msg.activity || []);
      if (state.unsafeEval) showBanner('Unsafe eval is enabled: Claude can run arbitrary code in this page. Restart with `fmv start` to turn it off.', 'bad');
      else if (!msg.signedIn) showBanner('Not signed in. Click Sign in, or run `fmv login` in Claude Code.');
    } else if (msg.type === 'log') panels.addActivity(msg.entry);
    else if (msg.type === 'auth') setAuth(Boolean(msg.signedIn));
    else if (msg.type === 'progress') showProgress(msg.message || '');
    else if (msg.type === 'command') runCommand(msg);
  };
  es.addEventListener('error', () => {
    // A 403 means the page cookie is stale (server restarted): reload to get a fresh one.
    fetch('/ui/token', { credentials: 'same-origin' })
      .then((r) => {
        if (r.status === 403) location.reload();
      })
      .catch(() => {});
  });
}

// Chrome -------------------------------------------------------------------------------------
$('btn-signin').addEventListener('click', async () => {
  const r = await post('/ui/login', {});
  if (r.ok) location.href = r.result.url;
});
$('btn-theme').addEventListener('click', () => {
  const dark = !document.documentElement.classList.contains('dark-theme');
  document.documentElement.className = dark ? 'dark-theme' : 'fusion-theme';
  try {
    localStorage.setItem('fmv.theme', dark ? 'dark' : 'light');
  } catch {}
  viewer.applyTheme(dark ? 'dark' : 'light');
});
$('btn-dock').addEventListener('click', (e) => {
  const hidden = $('layout').classList.toggle('dock-hidden');
  e.currentTarget.setAttribute('aria-pressed', String(!hidden));
  window.dispatchEvent(new Event('resize'));
});

// Resizable dock
(() => {
  const splitter = $('splitter');
  const dock = $('dock');
  let startX = 0;
  let startW = 0;
  const move = (e) => {
    dock.style.width = `${Math.max(260, startW - (e.clientX - startX))}px`;
    window.dispatchEvent(new Event('resize'));
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  splitter.addEventListener('pointerdown', (e) => {
    startX = e.clientX;
    startW = dock.getBoundingClientRect().width;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  splitter.addEventListener('keydown', (e) => {
    const w = dock.getBoundingClientRect().width;
    if (e.key === 'ArrowLeft') dock.style.width = `${w + 20}px`;
    if (e.key === 'ArrowRight') dock.style.width = `${Math.max(260, w - 20)}px`;
    window.dispatchEvent(new Event('resize'));
  });
})();

connect();
