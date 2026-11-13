// Small, safe markdown renderer for the Notes panel.
// parseMarkdown() is pure (tested in Node); renderMarkdown() builds DOM nodes with textContent
// only, never innerHTML, so pushed text can't inject markup. Links must be http(s).

export function safeHref(href) {
  // Strip control characters first: "jav\tascript:" still runs in a browser.
  const s = String(href || '').replace(/[\u0000-\u001f\u007f\s]+/g, '');
  if (/^https?:\/\//i.test(s)) return s;
  return null;
}

/** Inline tokens: text, code, strong, em, link. */
export function parseInline(text) {
  const out = [];
  let i = 0;
  let buf = '';
  const flush = () => {
    if (buf) out.push({ type: 'text', text: buf });
    buf = '';
  };
  while (i < text.length) {
    const rest = text.slice(i);
    let m;
    if (rest[0] === '\\' && rest.length > 1 && /[\\`*_[\]()#|-]/.test(rest[1])) {
      buf += rest[1];
      i += 2;
    } else if ((m = /^`([^`]+)`/.exec(rest))) {
      flush();
      out.push({ type: 'code', text: m[1] });
      i += m[0].length;
    } else if ((m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest))) {
      flush();
      const href = safeHref(m[2]);
      if (href) out.push({ type: 'link', href, children: parseInline(m[1]) });
      else out.push({ type: 'text', text: m[1] });
      i += m[0].length;
    } else if ((m = /^\*\*([^*]+?)\*\*/.exec(rest)) || (m = /^__([^_]+?)__/.exec(rest))) {
      flush();
      out.push({ type: 'strong', children: parseInline(m[1]) });
      i += m[0].length;
    } else if ((m = /^\*([^*\s][^*]*?)\*/.exec(rest)) || (m = /^_([^_\s][^_]*?)_(?![A-Za-z0-9])/.exec(rest))) {
      flush();
      out.push({ type: 'em', children: parseInline(m[1]) });
      i += m[0].length;
    } else {
      buf += rest[0];
      i += 1;
    }
  }
  flush();
  return out;
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

/** Block tokens: heading, paragraph, list, code, quote, hr, table. */
export function parseMarkdown(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    let m;
    if ((m = /^```\s*([\w-]*)\s*$/.exec(line))) {
      const body = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push({ type: 'code', lang: m[1], text: body.join('\n') });
    } else if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) {
      blocks.push({ type: 'heading', level: m[1].length, children: parseInline(m[2].trim()) });
      i++;
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
    } else if (/^\s*>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push({ type: 'quote', children: parseInline(body.join(' ')) });
    } else if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        let text = lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, '');
        let checked = null;
        const t = /^\[( |x|X)\]\s+/.exec(text);
        if (t) {
          checked = t[1] !== ' ';
          text = text.slice(t[0].length);
        }
        items.push({ checked, children: parseInline(text) });
        i++;
      }
      blocks.push({ type: 'list', ordered, items });
    } else if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const header = splitRow(line).map(parseInline);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]).map(parseInline));
      blocks.push({ type: 'table', header, rows });
    } else {
      const body = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^(#{1,4})\s+/.test(lines[i]) &&
        !/^```/.test(lines[i]) &&
        !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) &&
        !/^\s*>/.test(lines[i])
      ) {
        body.push(lines[i++].trim());
      }
      blocks.push({ type: 'paragraph', children: parseInline(body.join(' ')) });
    }
  }
  return blocks;
}

function renderInline(doc, parent, nodes) {
  for (const n of nodes) {
    if (n.type === 'text') parent.appendChild(doc.createTextNode(n.text));
    else if (n.type === 'code') {
      const el = doc.createElement('code');
      el.textContent = n.text;
      parent.appendChild(el);
    } else if (n.type === 'link') {
      const a = doc.createElement('a');
      a.href = n.href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      renderInline(doc, a, n.children);
      parent.appendChild(a);
    } else if (n.type === 'strong' || n.type === 'em') {
      const el = doc.createElement(n.type);
      renderInline(doc, el, n.children);
      parent.appendChild(el);
    }
  }
}

export function renderMarkdown(src, doc = document) {
  const root = doc.createElement('div');
  root.className = 'md';
  for (const b of parseMarkdown(src)) {
    let el;
    if (b.type === 'heading') {
      el = doc.createElement(`h${b.level}`);
      renderInline(doc, el, b.children);
    } else if (b.type === 'paragraph') {
      el = doc.createElement('p');
      renderInline(doc, el, b.children);
    } else if (b.type === 'code') {
      el = doc.createElement('pre');
      const code = doc.createElement('code');
      code.textContent = b.text;
      el.appendChild(code);
    } else if (b.type === 'quote') {
      el = doc.createElement('blockquote');
      renderInline(doc, el, b.children);
    } else if (b.type === 'hr') {
      el = doc.createElement('hr');
    } else if (b.type === 'list') {
      el = doc.createElement(b.ordered ? 'ol' : 'ul');
      for (const item of b.items) {
        const li = doc.createElement('li');
        if (item.checked !== null) li.appendChild(doc.createTextNode(item.checked ? '☑ ' : '☐ '));
        renderInline(doc, li, item.children);
        el.appendChild(li);
      }
    } else if (b.type === 'table') {
      el = doc.createElement('table');
      const thead = doc.createElement('thead');
      const tr = doc.createElement('tr');
      for (const cell of b.header) {
        const th = doc.createElement('th');
        renderInline(doc, th, cell);
        tr.appendChild(th);
      }
      thead.appendChild(tr);
      el.appendChild(thead);
      const tbody = doc.createElement('tbody');
      for (const row of b.rows) {
        const r = doc.createElement('tr');
        for (const cell of row) {
          const td = doc.createElement('td');
          renderInline(doc, td, cell);
          r.appendChild(td);
        }
        tbody.appendChild(r);
      }
      el.appendChild(tbody);
    }
    if (el) root.appendChild(el);
  }
  return root;
}
