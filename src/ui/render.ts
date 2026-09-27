// Rendering of module grids to canvas / SVG plus debug overlays.

import type { QrMatrix, ModuleKind } from '../qr/matrix';
import { codewordOwners, maskBit, type EcLevel } from '../qr/tables';

export interface RenderGrid {
  size: number;
  get(x: number, y: number): boolean;
}

export interface RenderOptions {
  scale: number;
  quiet: number;
  fg: string;
  bg: string;
  /** Per-module overlay colour (index y*size+x). */
  overlay?: (string | null)[];
  overlayAlpha?: number;
  /** Module indices to outline. */
  highlight?: Set<number>;
  gridLines?: boolean;
}

export function drawToCanvas(canvas: HTMLCanvasElement, g: RenderGrid, o: RenderOptions): void {
  const dim = (g.size + o.quiet * 2) * o.scale;
  canvas.width = dim;
  canvas.height = dim;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = o.bg;
  ctx.fillRect(0, 0, dim, dim);
  ctx.fillStyle = o.fg;
  for (let y = 0; y < g.size; y++) {
    for (let x = 0; x < g.size; x++) {
      if (g.get(x, y)) ctx.fillRect((x + o.quiet) * o.scale, (y + o.quiet) * o.scale, o.scale, o.scale);
    }
  }
  if (o.overlay) {
    ctx.globalAlpha = o.overlayAlpha ?? 0.55;
    for (let y = 0; y < g.size; y++) {
      for (let x = 0; x < g.size; x++) {
        const c = o.overlay[y * g.size + x];
        if (!c) continue;
        ctx.fillStyle = c;
        ctx.fillRect((x + o.quiet) * o.scale, (y + o.quiet) * o.scale, o.scale, o.scale);
      }
    }
    ctx.globalAlpha = 1;
  }
  if (o.gridLines && o.scale >= 4) {
    ctx.strokeStyle = 'rgba(128,128,128,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= g.size; i++) {
      const p = (i + o.quiet) * o.scale + 0.5;
      ctx.moveTo(p, o.quiet * o.scale);
      ctx.lineTo(p, (g.size + o.quiet) * o.scale);
      ctx.moveTo(o.quiet * o.scale, p);
      ctx.lineTo((g.size + o.quiet) * o.scale, p);
    }
    ctx.stroke();
  }
  if (o.highlight?.size) {
    ctx.strokeStyle = '#ff2d55';
    ctx.lineWidth = Math.max(1, o.scale / 5);
    for (const idx of o.highlight) {
      const x = idx % g.size;
      const y = Math.floor(idx / g.size);
      ctx.strokeRect((x + o.quiet) * o.scale + 0.5, (y + o.quiet) * o.scale + 0.5, o.scale - 1, o.scale - 1);
    }
  }
}

export function toSvg(g: RenderGrid, o: Pick<RenderOptions, 'quiet' | 'fg' | 'bg'>, moduleSize = 10): string {
  const dim = g.size + o.quiet * 2;
  let path = '';
  for (let y = 0; y < g.size; y++) {
    for (let x = 0; x < g.size; x++) {
      if (g.get(x, y)) path += `M${x + o.quiet},${y + o.quiet}h1v1h-1z`;
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim * moduleSize}" height="${dim * moduleSize}" shape-rendering="crispEdges">
<rect width="100%" height="100%" fill="${o.bg}"/>
<path d="${path}" fill="${o.fg}"/>
</svg>`;
}

export function moduleAt(canvas: HTMLCanvasElement, ev: MouseEvent, size: number, o: RenderOptions): [number, number] | null {
  const rect = canvas.getBoundingClientRect();
  const px = ((ev.clientX - rect.left) / rect.width) * canvas.width;
  const py = ((ev.clientY - rect.top) / rect.height) * canvas.height;
  const x = Math.floor(px / o.scale) - o.quiet;
  const y = Math.floor(py / o.scale) - o.quiet;
  if (x < 0 || y < 0 || x >= size || y >= size) return null;
  return [x, y];
}

// ---- Overlays ----

export const KIND_COLORS: Record<ModuleKind, string> = {
  finder: '#e5484d',
  separator: '#f5a524',
  timing: '#30a46c',
  alignment: '#8e4ec6',
  format: '#0091ff',
  version: '#12a594',
  dark: '#ff00aa',
  data: '',
  remainder: '#777777',
};

export const KIND_LABELS: Record<ModuleKind, string> = {
  finder: '位置検出パターン',
  separator: '分離パターン',
  timing: 'タイミングパターン',
  alignment: '位置合わせパターン',
  format: '形式情報',
  version: '型番情報',
  dark: '暗モジュール',
  data: 'データ/誤り訂正',
  remainder: '剰余ビット',
};

export function kindOverlay(m: QrMatrix): (string | null)[] {
  return m.kinds.map((k) => KIND_COLORS[k] || null);
}

function blockHue(b: number): number {
  return (b * 137.508) % 360;
}

/** Colour data modules by RS block; ECC codewords use a darker shade. */
export function codewordOverlay(m: QrMatrix, ec: EcLevel): (string | null)[] {
  const owners = codewordOwners(m.version, ec);
  const order = m.dataModuleOrder();
  const out: (string | null)[] = new Array(m.size * m.size).fill(null);
  order.forEach(([x, y], i) => {
    const o = owners[i >>> 3];
    if (!o) {
      out[y * m.size + x] = KIND_COLORS.remainder;
      return;
    }
    const h = blockHue(o.block);
    const alt = (i >>> 3) % 2 === 0;
    out[y * m.size + x] = o.isEcc ? `hsl(${h} 45% ${alt ? 30 : 38}%)` : `hsl(${h} 85% ${alt ? 55 : 65}%)`;
  });
  return out;
}

export const REGION_COLORS: Record<string, string> = {
  mode: '#e5484d',
  count: '#f5a524',
  data: '#0091ff',
  terminator: '#30a46c',
  align: '#8fd694',
  hidden: '#ff00aa',
  pad: '#9e9e9e',
  ecc: '#8e4ec6',
  suspicious: '#ff00aa',
};

export interface BitSpan {
  start: number;
  length: number;
  kind: string;
}

/** Colour every data bit's module by the bit-stream region it belongs to. */
export function regionOverlay(m: QrMatrix, ec: EcLevel, spans: BitSpan[]): (string | null)[] {
  const owners = codewordOwners(m.version, ec);
  const finalOfData: number[] = [];
  owners.forEach((o, i) => {
    if (!o.isEcc) finalOfData[o.dataIndex] = i;
  });
  const order = m.dataModuleOrder();
  const out: (string | null)[] = new Array(m.size * m.size).fill(null);
  order.forEach(([x, y], i) => {
    const o = owners[i >>> 3];
    if (!o) out[y * m.size + x] = KIND_COLORS.remainder;
    else if (o.isEcc) out[y * m.size + x] = REGION_COLORS.ecc;
  });
  for (const s of spans) {
    const color = REGION_COLORS[s.kind] ?? REGION_COLORS.data;
    for (let b = s.start; b < s.start + s.length; b++) {
      const fi = finalOfData[b >>> 3];
      if (fi === undefined) continue;
      const mod = order[fi * 8 + (b & 7)];
      if (mod) out[mod[1] * m.size + mod[0]] = color;
    }
  }
  return out;
}

export function maskOverlay(m: QrMatrix, mask: number): (string | null)[] {
  const out: (string | null)[] = new Array(m.size * m.size).fill(null);
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (!m.isFunction(x, y) && maskBit(mask, y, x)) out[y * m.size + x] = '#ffb224';
    }
  }
  return out;
}

/** Module indices belonging to the given final codeword indices. */
export function codewordModules(m: QrMatrix, finalIndices: Iterable<number>): Set<number> {
  const order = m.dataModuleOrder();
  const out = new Set<number>();
  for (const cw of finalIndices) {
    for (let k = 0; k < 8; k++) {
      const mod = order[cw * 8 + k];
      if (mod) out.add(mod[1] * m.size + mod[0]);
    }
  }
  return out;
}
