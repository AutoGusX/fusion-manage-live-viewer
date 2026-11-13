// Side panels: BOM tree, table, notes (markdown), record card and activity log.
// All content is rendered with textContent / DOM nodes; nothing pushed by Claude becomes HTML.

import { renderMarkdown } from './markdown.js';

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c !== null && c !== undefined) e.append(c);
  return e;
}

/** Status shown with a shape and its label, never colour alone. */
export function stateTone(state) {
  const s = String(state || '').toLowerCase();
  if (!s) return null;
  if (/(released|production|approved|complete|closed|done|active)/.test(s)) return 'ok';
  if (/(obsolete|rejected|cancel|superseded|inactive|hold|failed)/.test(s)) return 'bad';
  if (/(work|draft|progress|review|pending|open|new|prototype|change)/.test(s)) return 'warn';
  return 'info';
}
const SHAPE = { ok: '●', warn: '◐', bad: '■', info: '◇' };

function badge(state) {
  if (!state) return '';
  const tone = stateTone(state);
  return el('span', { class: 'badge', 'data-tone': tone }, el('span', { class: 'dot', 'aria-hidden': 'true', text: SHAPE[tone] }), el('span', { text: state }));
}

function head(title, ...extra) {
  return el('div', { class: 'panel-head' }, el('div', { class: 'panel-title', text: title || '' }), ...extra);
}

function filterBox(onInput) {
  return el('input', { class: 'filter', type: 'search', placeholder: 'Filter', 'aria-label': 'Filter rows', oninput: (e) => onInput(e.target.value) });
}

function timeOf(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export class Panels {
  /**
   * @param {HTMLElement} dock
   * @param {{ onBomRow: (row: object, matchProperty?: string) => void, onTableRow: (index: number, row: string[], columns: string[]) => void }} hooks
   */
  constructor(dock, hooks) {
    this.dock = dock;
    this.hooks = hooks;
    this.tabs = [...dock.querySelectorAll('[role=tab]')];
    this.sections = Object.fromEntries([...dock.querySelectorAll('[data-panel]')].map((s) => [s.dataset.panel, s]));
    for (const t of this.tabs) t.addEventListener('click', () => this.focus(t.dataset.tab));
    this.activity = [];
    for (const name of ['bom', 'table', 'markdown', 'card']) this.clear(name);
    this.renderActivity();
  }

  focus(name) {
    for (const t of this.tabs) {
      const on = t.dataset.tab === name;
      t.setAttribute('aria-selected', String(on));
      if (on) t.classList.remove('has-new');
    }
    for (const [k, s] of Object.entries(this.sections)) s.hidden = k !== name;
  }

  markNew(name) {
    const t = this.tabs.find((x) => x.dataset.tab === name);
    if (t && t.getAttribute('aria-selected') !== 'true') t.classList.add('has-new');
  }

  show({ panel, title, focus, data }) {
    const render = { bom: () => this.renderBom(title, data), table: () => this.renderTable(title, data), markdown: () => this.renderMarkdown(title, data), card: () => this.renderCard(title, data) }[panel];
    if (!render) throw new Error(`Unknown panel ${panel}`);
    render();
    if (focus) this.focus(panel);
    else this.markNew(panel);
    return { panel, summary: `Showed ${panel}${title ? `: ${title}` : ''}` };
  }

  clear(panel) {
    const names = panel ? [panel] : ['bom', 'table', 'markdown', 'card'];
    const empty = { bom: 'No BOM yet. Claude can push one with `fmv panel bom`.', table: 'No table yet.', markdown: 'No notes yet.', card: 'No record yet.' };
    for (const n of names) {
      const s = this.sections[n];
      if (!s) continue;
      s.replaceChildren(el('div', { class: 'panel-empty', text: empty[n] }));
    }
    return { summary: `Cleared ${panel || 'all panels'}` };
  }

  renderBom(title, { rows, matchProperty }) {
    const s = this.sections.bom;
    const tbody = el('tbody');
    const draw = (filter = '') => {
      const f = filter.trim().toLowerCase();
      tbody.replaceChildren(
        ...rows
          .filter((r) => !f || `${r.number} ${r.title} ${r.state}`.toLowerCase().includes(f))
          .map((r) => {
            const tr = el(
              'tr',
              { tabindex: '0' },
              el(
                'td',
                { class: 'num' },
                el('span', { class: 'indent', style: `width:${r.level * 14}px` }),
                r.color ? el('span', { class: 'swatch', style: `background:${r.color};margin-right:6px` }) : '',
                r.number,
              ),
              el('td', { text: r.title }),
              el('td', { class: 'qty', text: r.quantity }),
              el('td', {}, badge(r.state)),
            );
            const pick = () => {
              for (const x of tbody.querySelectorAll('tr.selected')) x.classList.remove('selected');
              tr.classList.add('selected');
              this.hooks.onBomRow(r, matchProperty);
            };
            tr.addEventListener('click', pick);
            tr.addEventListener('keydown', (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                pick();
              }
            });
            return tr;
          }),
      );
    };
    draw();
    const table = el('table', { class: 'grid' }, el('thead', {}, el('tr', {}, el('th', { text: 'Number' }), el('th', { text: 'Title' }), el('th', { text: 'Qty' }), el('th', { text: 'State' }))), tbody);
    s.replaceChildren(head(title || `BOM (${rows.length})`, filterBox(draw)), table);
  }

  renderTable(title, { columns, rows }) {
    const s = this.sections.table;
    let sortCol = -1;
    let sortDir = 1;
    let filter = '';
    const tbody = el('tbody');
    const ths = columns.map((c, i) =>
      el('th', {
        text: c,
        tabindex: '0',
        onclick: () => {
          sortDir = sortCol === i ? -sortDir : 1;
          sortCol = i;
          draw();
        },
      }),
    );
    const draw = () => {
      ths.forEach((th, i) => (i === sortCol ? th.setAttribute('aria-sort', sortDir > 0 ? 'ascending' : 'descending') : th.removeAttribute('aria-sort')));
      let list = rows.map((r, i) => ({ r, i }));
      const f = filter.trim().toLowerCase();
      if (f) list = list.filter(({ r }) => r.join(' ').toLowerCase().includes(f));
      if (sortCol >= 0) list.sort((a, b) => sortDir * String(a.r[sortCol]).localeCompare(String(b.r[sortCol]), undefined, { numeric: true }));
      tbody.replaceChildren(
        ...list.map(({ r, i }) => {
          const tr = el('tr', { tabindex: '0' }, ...columns.map((_, c) => el('td', { text: r[c] ?? '' })));
          tr.addEventListener('click', () => {
            for (const x of tbody.querySelectorAll('tr.selected')) x.classList.remove('selected');
            tr.classList.add('selected');
            this.hooks.onTableRow(i, r, columns);
          });
          return tr;
        }),
      );
    };
    draw();
    s.replaceChildren(
      head(
        title || `Table (${rows.length})`,
        filterBox((v) => {
          filter = v;
          draw();
        }),
      ),
      el('table', { class: 'grid' }, el('thead', {}, el('tr', {}, ...ths)), tbody),
    );
  }

  renderMarkdown(title, { text }) {
    const s = this.sections.markdown;
    s.replaceChildren(...(title ? [head(title)] : []), renderMarkdown(text));
  }

  renderCard(title, d) {
    const s = this.sections.card;
    const dl = el('dl');
    for (const f of d.fields) dl.append(el('dt', { text: f.label }), el('dd', { text: f.value }));
    s.replaceChildren(
      ...(title ? [head(title)] : []),
      el(
        'div',
        { class: 'card' },
        el('div', { class: 'card-title', text: d.title }),
        d.subtitle ? el('div', { class: 'card-sub', text: d.subtitle }) : '',
        d.state ? badge(d.state) : '',
        dl,
        d.link ? el('p', {}, el('a', { href: d.link, target: '_blank', rel: 'noopener noreferrer', text: 'Open in Fusion Manage' })) : '',
      ),
    );
  }

  // Activity log ---------------------------------------------------------------------------------
  setActivity(entries) {
    this.activity = entries.slice(-300);
    this.renderActivity();
  }

  addActivity(entry) {
    this.activity.push(entry);
    if (this.activity.length > 300) this.activity.shift();
    this.renderActivity();
  }

  renderActivity() {
    const s = this.sections.activity;
    const items = [...this.activity].reverse().map((e) => {
      let what;
      if (e.kind === 'fm') what = el('span', {}, `${e.method} ${e.path} `, el('span', { class: e.status >= 400 ? 'fail' : 'meta', text: `${e.status} · ${e.ms} ms` }));
      else if (e.kind === 'view') what = el('span', { class: e.ok ? '' : 'fail' }, `${e.command}${e.message ? ` — ${e.message}` : ''} `, el('span', { class: 'meta', text: `${e.ms} ms` }));
      else what = el('span', { text: e.message || e.panel || '' });
      return el('li', {}, el('span', { class: 'time', text: timeOf(e.at) }), el('span', { class: 'kind', text: e.kind }), el('span', { class: 'what' }, what));
    });
    s.replaceChildren(head('Activity'), items.length ? el('ul', { class: 'log' }, ...items) : el('div', { class: 'panel-empty', text: 'Nothing yet. Every Fusion Manage call and viewer command shows up here.' }));
  }
}
