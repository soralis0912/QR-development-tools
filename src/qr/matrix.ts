// Module matrix construction shared by the encoder and decoder.

import { alignmentPositions, formatBits, maskBit, sizeOf, versionBits, type EcLevel } from './tables';

export type ModuleKind =
  | 'finder'
  | 'separator'
  | 'timing'
  | 'alignment'
  | 'format'
  | 'version'
  | 'dark'
  | 'data'
  | 'remainder';

export class QrMatrix {
  readonly size: number;
  readonly modules: Uint8Array; // 1 = dark
  readonly kinds: ModuleKind[];

  constructor(readonly version: number) {
    this.size = sizeOf(version);
    this.modules = new Uint8Array(this.size * this.size);
    this.kinds = new Array<ModuleKind>(this.size * this.size).fill('data');
    this.drawFunctionPatterns();
  }

  get(x: number, y: number): boolean {
    return this.modules[y * this.size + x] === 1;
  }

  set(x: number, y: number, dark: boolean, kind?: ModuleKind): void {
    this.modules[y * this.size + x] = dark ? 1 : 0;
    if (kind) this.kinds[y * this.size + x] = kind;
  }

  kind(x: number, y: number): ModuleKind {
    return this.kinds[y * this.size + x];
  }

  isFunction(x: number, y: number): boolean {
    const k = this.kind(x, y);
    return k !== 'data' && k !== 'remainder';
  }

  clone(): QrMatrix {
    const m = new QrMatrix(this.version);
    m.modules.set(this.modules);
    for (let i = 0; i < this.kinds.length; i++) m.kinds[i] = this.kinds[i];
    return m;
  }

  private drawFunctionPatterns(): void {
    const size = this.size;
    for (let i = 0; i < size; i++) {
      this.set(6, i, i % 2 === 0, 'timing');
      this.set(i, 6, i % 2 === 0, 'timing');
    }
    this.drawFinder(3, 3);
    this.drawFinder(size - 4, 3);
    this.drawFinder(3, size - 4);
    const pos = alignmentPositions(this.version);
    const n = pos.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        this.drawAlignment(pos[i], pos[j]);
      }
    }
    // Reserve format areas (values filled later).
    for (let i = 0; i <= 8; i++) {
      if (i !== 6) {
        this.set(8, i, false, 'format');
        this.set(i, 8, false, 'format');
      }
    }
    for (let i = 0; i < 8; i++) {
      this.set(size - 1 - i, 8, false, 'format');
      this.set(8, size - 1 - i, false, 'format');
    }
    this.set(8, size - 8, true, 'dark');
    if (this.version >= 7) {
      for (let i = 0; i < 18; i++) {
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.set(a, b, false, 'version');
        this.set(b, a, false, 'version');
      }
    }
  }

  private drawFinder(cx: number, cy: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= this.size || y >= this.size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        if (dist === 4) this.set(x, y, false, 'separator');
        else this.set(x, y, dist !== 2, 'finder');
      }
    }
  }

  private drawAlignment(cx: number, cy: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1, 'alignment');
      }
    }
  }

  drawFormat(ec: EcLevel, mask: number, bitsOverride?: number): number {
    const bits = bitsOverride ?? formatBits(ec, mask);
    this.writeFormatBits(bits);
    return bits;
  }

  writeFormatBits(bits: number): void {
    const size = this.size;
    const bit = (i: number) => ((bits >>> i) & 1) === 1;
    // Copy 1 (around top-left finder)
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
    // Copy 2
    for (let i = 0; i < 8; i++) this.set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, size - 15 + i, bit(i));
    this.set(8, size - 8, true);
  }

  /** Read both copies of format info (bit 14 = MSB). */
  readFormatBits(): [number, number] {
    const size = this.size;
    let a = 0;
    let b = 0;
    const g = (x: number, y: number) => (this.get(x, y) ? 1 : 0);
    for (let i = 0; i <= 5; i++) a |= g(8, i) << i;
    a |= g(8, 7) << 6;
    a |= g(8, 8) << 7;
    a |= g(7, 8) << 8;
    for (let i = 9; i < 15; i++) a |= g(14 - i, 8) << i;
    for (let i = 0; i < 8; i++) b |= g(size - 1 - i, 8) << i;
    for (let i = 8; i < 15; i++) b |= g(8, size - 15 + i) << i;
    return [a, b];
  }

  drawVersion(): number | null {
    if (this.version < 7) return null;
    const bits = versionBits(this.version);
    const size = this.size;
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.set(a, b, bit);
      this.set(b, a, bit);
    }
    return bits;
  }

  /** Read both copies of version info: [top-right, bottom-left]. */
  readVersionBits(): [number, number] {
    const size = this.size;
    let a = 0;
    let b = 0;
    for (let i = 0; i < 18; i++) {
      const x = size - 11 + (i % 3);
      const y = Math.floor(i / 3);
      if (this.get(x, y)) a |= 1 << i;
      if (this.get(y, x)) b |= 1 << i;
    }
    return [a, b];
  }

  /** Coordinates of data modules in placement order (zig-zag). */
  dataModuleOrder(): [number, number][] {
    const out: [number, number][] = [];
    const size = this.size;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!this.isFunction(x, y)) out.push([x, y]);
        }
      }
    }
    return out;
  }

  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (!this.isFunction(x, y) && maskBit(mask, y, x)) this.modules[y * this.size + x] ^= 1;
      }
    }
  }
}

export interface PenaltyBreakdown {
  n1: number;
  n2: number;
  n3: number;
  n4: number;
  total: number;
}

/** ISO/IEC 18004 mask evaluation penalty. */
export function penalty(m: QrMatrix): PenaltyBreakdown {
  const size = m.size;
  let n1 = 0;
  let n2 = 0;
  let n3 = 0;
  const get = (x: number, y: number) => m.get(x, y);

  // N1: runs of 5+ same colour in rows/cols.
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < size; a++) {
      let run = 1;
      let prev = pass === 0 ? get(0, a) : get(a, 0);
      for (let b = 1; b < size; b++) {
        const c = pass === 0 ? get(b, a) : get(a, b);
        if (c === prev) {
          run++;
        } else {
          if (run >= 5) n1 += 3 + run - 5;
          run = 1;
          prev = c;
        }
      }
      if (run >= 5) n1 += 3 + run - 5;
    }
  }
  // N2: 2x2 blocks.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = get(x, y);
      if (c === get(x + 1, y) && c === get(x, y + 1) && c === get(x + 1, y + 1)) n2 += 3;
    }
  }
  // N3: 1:1:3:1:1 finder-like pattern with 4 light modules on either side.
  const pat = [true, false, true, true, true, false, true];
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < size; a++) {
      for (let b = 0; b + 7 <= size; b++) {
        let match = true;
        for (let k = 0; k < 7 && match; k++) {
          const c = pass === 0 ? get(b + k, a) : get(a, b + k);
          if (c !== pat[k]) match = false;
        }
        if (!match) continue;
        const light = (from: number, to: number) => {
          for (let k = from; k < to; k++) {
            if (k < 0 || k >= size) continue; // outside symbol counts as light
            if (pass === 0 ? get(k, a) : get(a, k)) return false;
          }
          return true;
        };
        if (light(b - 4, b)) n3 += 40;
        if (light(b + 7, b + 11)) n3 += 40;
      }
    }
  }
  // N4: dark proportion.
  let dark = 0;
  for (let i = 0; i < m.modules.length; i++) dark += m.modules[i];
  const total = size * size;
  const k = Math.max(0, Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1);
  const n4 = k * 10;
  return { n1, n2, n3, n4, total: n1 + n2 + n3 + n4 };
}
