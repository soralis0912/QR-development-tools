export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
}

type Child = Node | string | number | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | EventListener | undefined> | null = null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = String(v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'object' ? c : String(c));
  }
  return el;
}

export function download(name: string, data: Blob): void {
  const url = URL.createObjectURL(data);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Visualise control characters / NULs in decoded text. */
export function visibleText(s: string): Node {
  const frag = document.createDocumentFragment();
  let buf = '';
  const flush = () => {
    if (buf) frag.append(buf);
    buf = '';
  };
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '\n') {
      flush();
      frag.append(h('span', { class: 'ctrl' }, '↵'), '\n');
    } else if (c < 0x20 || c === 0x7f || (c >= 0x80 && c < 0xa0) || c === 0xfffd) {
      flush();
      const label = c === 0 ? 'NUL' : c === 0xfffd ? 'U+FFFD' : `\\x${c.toString(16).padStart(2, '0')}`;
      frag.append(h('span', { class: c === 0 ? 'ctrl nul' : 'ctrl' }, label));
    } else {
      buf += ch;
    }
  }
  flush();
  return frag;
}

export function kv(rows: [string, Child | Child[]][]): HTMLElement {
  return h('dl', { class: 'kv' }, rows.map(([k, v]) => [h('dt', null, k), h('dd', null, v as Child)]).flat());
}

export function badge(text: string, kind: 'ok' | 'warn' | 'bad' | 'info' = 'info'): HTMLElement {
  return h('span', { class: `badge ${kind}` }, text);
}

export function card(title: string, ...children: (Child | Child[])[]): HTMLElement {
  return h('div', { class: 'card' }, h('h3', null, title), ...children);
}

export function seededRandom(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}
