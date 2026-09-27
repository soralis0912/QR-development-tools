// Data segments (mode + payload) and bit stream helpers.

export type Mode = 'numeric' | 'alphanumeric' | 'byte' | 'kanji' | 'eci';

export const MODE_INDICATOR: Record<Mode, number> = {
  numeric: 0b0001,
  alphanumeric: 0b0010,
  byte: 0b0100,
  kanji: 0b1000,
  eci: 0b0111,
};

export const MODE_NAMES: Record<number, string> = {
  0b0000: 'Terminator',
  0b0001: 'Numeric',
  0b0010: 'Alphanumeric',
  0b0011: 'Structured Append',
  0b0100: 'Byte',
  0b0101: 'FNC1 (1st position)',
  0b0111: 'ECI',
  0b1000: 'Kanji',
  0b1001: 'FNC1 (2nd position)',
  0b1101: 'Hanzi (GB 2312)',
};

export const ALPHANUMERIC_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

export function charCountBits(mode: Mode, version: number): number {
  const idx = version <= 9 ? 0 : version <= 26 ? 1 : 2;
  switch (mode) {
    case 'numeric': return [10, 12, 14][idx];
    case 'alphanumeric': return [9, 11, 13][idx];
    case 'byte': return [8, 16, 16][idx];
    case 'kanji': return [8, 10, 12][idx];
    case 'eci': return 0;
  }
}

export class BitBuffer {
  bits: number[] = [];
  /** Optional labels for visualisation: [startBit, length, label]. */
  spans: { start: number; length: number; label: string; kind: string }[] = [];

  push(value: number, length: number, label?: string, kind = 'data'): void {
    if (length < 0 || length > 31 || value >>> length !== 0) {
      if (!(length === 0 && value === 0)) throw new Error(`value ${value} does not fit in ${length} bits`);
    }
    if (label) this.spans.push({ start: this.bits.length, length, label, kind });
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }

  get length(): number {
    return this.bits.length;
  }

  toBytes(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((b, i) => {
      out[i >>> 3] |= b << (7 - (i & 7));
    });
    return out;
  }
}

export class BitReader {
  pos = 0;
  constructor(private readonly bytes: Uint8Array, readonly totalBits = bytes.length * 8) {}
  get remaining(): number {
    return this.totalBits - this.pos;
  }
  read(n: number): number {
    if (n > this.remaining) throw new Error('read past end of bit stream');
    let v = 0;
    for (let i = 0; i < n; i++) {
      const p = this.pos + i;
      v = (v << 1) | ((this.bytes[p >>> 3] >>> (7 - (p & 7))) & 1);
    }
    this.pos += n;
    return v >>> 0;
  }
  peek(n: number): number {
    const save = this.pos;
    const v = this.read(Math.min(n, this.remaining));
    this.pos = save;
    return v;
  }
}

// ---- Shift_JIS helpers (built lazily from TextDecoder) ----

let sjisEncodeMap: Map<string, number> | null = null;

function buildSjisMap(): Map<string, number> {
  const map = new Map<string, number>();
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder('shift_jis', { fatal: true });
  } catch {
    return map;
  }
  const buf = new Uint8Array(2);
  const leads: number[] = [];
  for (let b = 0x81; b <= 0x9f; b++) leads.push(b);
  for (let b = 0xe0; b <= 0xfc; b++) leads.push(b);
  for (const lead of leads) {
    for (let trail = 0x40; trail <= 0xfc; trail++) {
      if (trail === 0x7f) continue;
      buf[0] = lead;
      buf[1] = trail;
      try {
        const s = decoder.decode(buf);
        if (s.length >= 1 && !map.has(s)) map.set(s, (lead << 8) | trail);
      } catch {
        // unmapped
      }
    }
  }
  // single byte
  for (let b = 0x20; b < 0x7f; b++) map.set(String.fromCharCode(b), b);
  for (let b = 0xa1; b <= 0xdf; b++) {
    try {
      map.set(decoder.decode(new Uint8Array([b])), b);
    } catch {
      // ignore
    }
  }
  return map;
}

export function sjisCode(ch: string): number | undefined {
  sjisEncodeMap ??= buildSjisMap();
  return sjisEncodeMap.get(ch);
}

export function isKanjiChar(ch: string): boolean {
  const c = sjisCode(ch);
  if (c === undefined || c < 0x100) return false;
  return (c >= 0x8140 && c <= 0x9ffc) || (c >= 0xe040 && c <= 0xebbf);
}

export function encodeShiftJis(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const c = sjisCode(ch);
    if (c === undefined) throw new Error(`Shift_JIS で表現できない文字: ${ch}`);
    if (c > 0xff) out.push(c >> 8, c & 0xff);
    else out.push(c);
  }
  return Uint8Array.from(out);
}

export type ByteEncoding = 'utf-8' | 'shift_jis' | 'iso-8859-1' | 'hex';

export function encodeBytes(text: string, encoding: ByteEncoding): Uint8Array {
  switch (encoding) {
    case 'utf-8':
      return new TextEncoder().encode(text);
    case 'shift_jis':
      return encodeShiftJis(text);
    case 'iso-8859-1': {
      const out: number[] = [];
      for (const ch of text) {
        const c = ch.codePointAt(0)!;
        if (c > 0xff) throw new Error(`ISO-8859-1 で表現できない文字: ${ch}`);
        out.push(c);
      }
      return Uint8Array.from(out);
    }
    case 'hex':
      return parseHex(text);
  }
}

export function parseHex(text: string): Uint8Array {
  const clean = text.replace(/0x/gi, '').replace(/[\s,:_-]/g, '');
  if (clean.length % 2 !== 0) throw new Error('16進数の桁数が奇数です');
  if (!/^[0-9a-fA-F]*$/.test(clean)) throw new Error('16進数として解釈できません');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

export function toHex(bytes: ArrayLike<number>, sep = ' '): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(sep);
}

// ---- Segments ----

export interface SegmentInput {
  mode: Mode;
  /** Text for numeric/alphanumeric/kanji/byte; for ECI the assignment number as string. */
  text: string;
  /** Byte mode only. */
  encoding?: ByteEncoding;
  /** Override the character count indicator (for testing malformed codes). */
  countOverride?: number;
}

export function validateSegment(seg: SegmentInput): string | null {
  switch (seg.mode) {
    case 'numeric':
      return /^[0-9]*$/.test(seg.text) ? null : '数字モードは 0-9 のみ使用できます';
    case 'alphanumeric':
      for (const ch of seg.text) if (!ALPHANUMERIC_CHARSET.includes(ch)) return `英数字モードで使えない文字: "${ch}"`;
      return null;
    case 'kanji':
      for (const ch of seg.text) if (!isKanjiChar(ch)) return `漢字モードで使えない文字: "${ch}"`;
      return null;
    case 'byte':
      try {
        encodeBytes(seg.text, seg.encoding ?? 'utf-8');
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    case 'eci': {
      const n = Number(seg.text);
      return Number.isInteger(n) && n >= 0 && n < 1000000 ? null : 'ECI 番号は 0〜999999';
    }
  }
}

function segmentCount(seg: SegmentInput): number {
  switch (seg.mode) {
    case 'byte':
      return encodeBytes(seg.text, seg.encoding ?? 'utf-8').length;
    case 'eci':
      return 0;
    default:
      return [...seg.text].length;
  }
}

/** Bits needed for a segment at a version (header included). */
export function segmentBitLength(seg: SegmentInput, version: number): number {
  const count = segmentCount(seg);
  switch (seg.mode) {
    case 'numeric':
      return 4 + charCountBits('numeric', version) + Math.floor(count / 3) * 10 + [0, 4, 7][count % 3];
    case 'alphanumeric':
      return 4 + charCountBits('alphanumeric', version) + Math.floor(count / 2) * 11 + (count % 2) * 6;
    case 'byte':
      return 4 + charCountBits('byte', version) + count * 8;
    case 'kanji':
      return 4 + charCountBits('kanji', version) + count * 13;
    case 'eci': {
      const n = Number(seg.text);
      return 4 + (n < 128 ? 8 : n < 16384 ? 16 : 24);
    }
  }
}

export function appendSegment(bb: BitBuffer, seg: SegmentInput, version: number, index: number): void {
  const tag = `#${index + 1}`;
  bb.push(MODE_INDICATOR[seg.mode], 4, `${tag} モード指示子 (${seg.mode})`, 'mode');
  if (seg.mode === 'eci') {
    const n = Number(seg.text);
    if (n < 128) bb.push(n, 8, `${tag} ECI ${n}`, 'count');
    else if (n < 16384) bb.push(0b10 << 14 | n, 16, `${tag} ECI ${n}`, 'count');
    else bb.push(0b110 << 21 | n, 24, `${tag} ECI ${n}`, 'count');
    return;
  }
  const count = seg.countOverride ?? segmentCount(seg);
  const ccBits = charCountBits(seg.mode, version);
  if (count >>> ccBits !== 0) throw new Error(`文字数 ${count} が文字数指示子 (${ccBits}bit) に収まりません`);
  bb.push(count, ccBits, `${tag} 文字数指示子 = ${count}`, 'count');
  const start = bb.length;
  switch (seg.mode) {
    case 'numeric': {
      const t = seg.text;
      for (let i = 0; i < t.length; i += 3) {
        const chunk = t.substr(i, 3);
        bb.push(parseInt(chunk, 10), [0, 4, 7, 10][chunk.length]);
      }
      break;
    }
    case 'alphanumeric': {
      const t = seg.text;
      for (let i = 0; i + 1 < t.length; i += 2) {
        bb.push(ALPHANUMERIC_CHARSET.indexOf(t[i]) * 45 + ALPHANUMERIC_CHARSET.indexOf(t[i + 1]), 11);
      }
      if (t.length % 2) bb.push(ALPHANUMERIC_CHARSET.indexOf(t[t.length - 1]), 6);
      break;
    }
    case 'byte':
      for (const b of encodeBytes(seg.text, seg.encoding ?? 'utf-8')) bb.push(b, 8);
      break;
    case 'kanji':
      for (const ch of seg.text) {
        let c = sjisCode(ch)!;
        c -= c <= 0x9ffc ? 0x8140 : 0xc140;
        bb.push((c >> 8) * 0xc0 + (c & 0xff), 13);
      }
      break;
  }
  bb.spans.push({ start, length: bb.length - start, label: `${tag} データ`, kind: 'data' });
}

/** Choose a single mode that can hold the whole text most compactly. */
export function autoSegments(text: string, encoding: ByteEncoding = 'utf-8'): SegmentInput[] {
  if (text.length === 0) return [{ mode: 'byte', text: '', encoding }];
  if (/^[0-9]+$/.test(text)) return [{ mode: 'numeric', text }];
  if ([...text].every((c) => ALPHANUMERIC_CHARSET.includes(c))) return [{ mode: 'alphanumeric', text }];
  return [{ mode: 'byte', text, encoding }];
}
