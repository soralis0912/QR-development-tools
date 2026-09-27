// Matrix -> data decoder with detailed diagnostics, including analysis of
// anything stored after the terminator (padding area).

import { QrMatrix } from './matrix';
import { rsDecode } from './reedsolomon';
import { ALPHANUMERIC_CHARSET, BitReader, charCountBits, MODE_NAMES, toHex, type Mode } from './segments';
import { blockInfo, decodeFormatBits, decodeVersionBits, maskBit, remainderBits, type EcLevel } from './tables';

export interface DecodedSegment {
  modeBits: number;
  modeName: string;
  startBit: number;
  endBit: number;
  count?: number;
  text?: string;
  bytes?: Uint8Array;
  eci?: number;
  charset?: string;
  error?: string;
  /** Byte segment contains NUL (0x00) followed by more non-NUL data. */
  nulThenData?: { nulIndex: number; bytesAfter: number };
}

export interface TrailingAnalysis {
  /** Bit position (in data codeword stream) where the terminator starts, or -1 if no room for it. */
  terminatorStart: number;
  terminatorLength: number;
  /** Terminator was cut short / absent because capacity was exhausted. */
  implicitEnd: boolean;
  alignBits: number[];
  alignBitsNonZero: boolean;
  /** Byte offset (within data codewords) where padding starts. */
  padStartByte: number;
  padBytes: Uint8Array;
  /** true if padBytes is exactly EC 11 EC 11 ... */
  standardPadding: boolean;
  /** Index within padBytes of first deviation from EC/11 pattern, -1 if none. */
  firstDeviation: number;
  /** Bytes that deviate from the standard pattern. */
  deviatingBytes: number;
  /** Bytes from first deviation up to the last deviating byte (candidate hidden payload). */
  suspiciousBytes: Uint8Array;
  /** Attempt to interpret the region after the terminator as further segments. */
  hiddenSegments: DecodedSegment[];
  /** Printable guess for suspicious bytes. */
  suspiciousText: string;
  /** Overall verdict: something other than standard padding exists after terminator. */
  hasDataAfterTerminator: boolean;
}

export interface BlockReport {
  index: number;
  dataLength: number;
  eccLength: number;
  ok: boolean;
  errorsCorrected: number;
  errorPositions: number[];
  message?: string;
}

export interface DecodeResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  size: number;
  version: number;
  versionInfo?: { raw: [number, number]; decoded: number; distance: number };
  ec: EcLevel;
  mask: number;
  formatInfo: { raw: [number, number]; corrected: number; distance: number; usedCopy: number };
  mirrored: boolean;
  rawCodewords: Uint8Array;
  dataCodewords: Uint8Array;
  blocks: BlockReport[];
  segments: DecodedSegment[];
  text: string;
  trailing?: TrailingAnalysis;
  remainderBitsValues: number[];
  /** Unmasked matrix for visualization. */
  matrix: QrMatrix;
}

export interface BitGrid {
  size: number;
  get(x: number, y: number): boolean;
}

export function gridFromRows(rows: boolean[][]): BitGrid {
  return { size: rows.length, get: (x, y) => rows[y][x] };
}

const ECI_CHARSETS: Record<number, string> = {
  0: 'cp437',
  1: 'iso-8859-1',
  2: 'cp437',
  3: 'iso-8859-1',
  4: 'iso-8859-2',
  5: 'iso-8859-3',
  6: 'iso-8859-4',
  7: 'iso-8859-5',
  8: 'iso-8859-6',
  9: 'iso-8859-7',
  10: 'iso-8859-8',
  11: 'iso-8859-9',
  13: 'iso-8859-11',
  15: 'iso-8859-13',
  16: 'iso-8859-14',
  17: 'iso-8859-15',
  18: 'iso-8859-16',
  20: 'shift_jis',
  21: 'windows-1250',
  22: 'windows-1251',
  23: 'windows-1252',
  24: 'windows-1256',
  25: 'utf-16be',
  26: 'utf-8',
  27: 'us-ascii',
  28: 'big5',
  29: 'gb18030',
  30: 'euc-kr',
};

function tryDecode(bytes: Uint8Array, charset: string, fatal = true): string | null {
  try {
    return new TextDecoder(charset, { fatal }).decode(bytes);
  } catch {
    return null;
  }
}

export function guessDecode(bytes: Uint8Array, eciCharset?: string): { text: string; charset: string } {
  if (eciCharset) {
    const t = tryDecode(bytes, eciCharset, false);
    if (t !== null) return { text: t, charset: eciCharset };
  }
  const utf8 = tryDecode(bytes, 'utf-8');
  if (utf8 !== null) return { text: utf8, charset: 'utf-8' };
  const sjis = tryDecode(bytes, 'shift_jis');
  if (sjis !== null) return { text: sjis, charset: 'shift_jis' };
  return { text: tryDecode(bytes, 'iso-8859-1', false) ?? '', charset: 'iso-8859-1' };
}

function decodeKanji(v: number): string {
  let c = Math.floor(v / 0xc0) * 0x100 + (v % 0xc0);
  c += c < 0x1f00 ? 0x8140 : 0xc140;
  return tryDecode(new Uint8Array([c >> 8, c & 0xff]), 'shift_jis', false) ?? '?';
}

function decodeHanzi(v: number): string {
  let c = Math.floor(v / 0x60) * 0x100 + (v % 0x60);
  c += c < 0x0a00 ? 0xa1a1 : 0xa6a1;
  return tryDecode(new Uint8Array([c >> 8, c & 0xff]), 'gb18030', false) ?? '?';
}

/** Parse segments from a bit reader. Stops at terminator, end of data, or error. */
export function parseSegments(
  r: BitReader,
  version: number,
): { segments: DecodedSegment[]; terminatorAt: number; implicitEnd: boolean; error?: string } {
  const segments: DecodedSegment[] = [];
  let charset: string | undefined;
  while (true) {
    if (r.remaining < 4) {
      return { segments, terminatorAt: r.remaining > 0 ? r.pos : -1, implicitEnd: true };
    }
    const start = r.pos;
    const mode = r.read(4);
    if (mode === 0) return { segments, terminatorAt: start, implicitEnd: false };
    const seg: DecodedSegment = { modeBits: mode, modeName: MODE_NAMES[mode] ?? `不明 (${mode.toString(2).padStart(4, '0')})`, startBit: start, endBit: start };
    segments.push(seg);
    try {
      switch (mode) {
        case 0b0111: {
          const first = r.read(8);
          let eci: number;
          if ((first & 0x80) === 0) eci = first;
          else if ((first & 0xc0) === 0x80) eci = ((first & 0x3f) << 8) | r.read(8);
          else if ((first & 0xe0) === 0xc0) eci = ((first & 0x1f) << 16) | r.read(16);
          else throw new Error('不正な ECI 指定子');
          seg.eci = eci;
          charset = ECI_CHARSETS[eci];
          seg.charset = charset ?? '(未対応)';
          seg.text = `ECI ${eci}${charset ? ` → ${charset}` : ''}`;
          break;
        }
        case 0b0011: {
          const idx = r.read(4);
          const total = r.read(4);
          const parity = r.read(8);
          seg.text = `シンボル ${idx + 1}/${total + 1}, パリティ 0x${parity.toString(16).padStart(2, '0')}`;
          break;
        }
        case 0b0101:
          seg.text = 'GS1';
          break;
        case 0b1001: {
          const ai = r.read(8);
          seg.text = `アプリケーション指示子 ${ai}`;
          break;
        }
        case 0b0001:
        case 0b0010:
        case 0b0100:
        case 0b1000: {
          const m: Mode = mode === 1 ? 'numeric' : mode === 2 ? 'alphanumeric' : mode === 4 ? 'byte' : 'kanji';
          const count = r.read(charCountBits(m, version));
          seg.count = count;
          if (m === 'numeric') {
            let s = '';
            let n = count;
            while (n >= 3) {
              const v = r.read(10);
              if (v > 999) throw new Error(`数字モードの値が範囲外: ${v}`);
              s += v.toString().padStart(3, '0');
              n -= 3;
            }
            if (n === 2) {
              const v = r.read(7);
              if (v > 99) throw new Error(`数字モードの値が範囲外: ${v}`);
              s += v.toString().padStart(2, '0');
            } else if (n === 1) {
              const v = r.read(4);
              if (v > 9) throw new Error(`数字モードの値が範囲外: ${v}`);
              s += v.toString();
            }
            seg.text = s;
          } else if (m === 'alphanumeric') {
            let s = '';
            let n = count;
            while (n >= 2) {
              const v = r.read(11);
              if (v >= 45 * 45) throw new Error(`英数字モードの値が範囲外: ${v}`);
              s += ALPHANUMERIC_CHARSET[Math.floor(v / 45)] + ALPHANUMERIC_CHARSET[v % 45];
              n -= 2;
            }
            if (n === 1) {
              const v = r.read(6);
              if (v >= 45) throw new Error(`英数字モードの値が範囲外: ${v}`);
              s += ALPHANUMERIC_CHARSET[v];
            }
            seg.text = s;
          } else if (m === 'byte') {
            const bytes = new Uint8Array(count);
            for (let i = 0; i < count; i++) bytes[i] = r.read(8);
            seg.bytes = bytes;
            const g = guessDecode(bytes, charset);
            seg.text = g.text;
            seg.charset = g.charset;
            const nul = bytes.indexOf(0);
            if (nul >= 0) {
              let after = 0;
              for (let i = nul + 1; i < bytes.length; i++) if (bytes[i] !== 0) after++;
              if (after > 0) seg.nulThenData = { nulIndex: nul, bytesAfter: bytes.length - nul - 1 };
            }
          } else {
            let s = '';
            for (let i = 0; i < count; i++) s += decodeKanji(r.read(13));
            seg.text = s;
          }
          break;
        }
        case 0b1101: {
          const subset = r.read(4);
          const count = r.read(charCountBits('kanji', version));
          seg.count = count;
          let s = '';
          for (let i = 0; i < count; i++) s += decodeHanzi(r.read(13));
          seg.text = subset === 1 ? s : `(subset ${subset}) ${s}`;
          break;
        }
        default:
          seg.error = '未知のモード指示子';
          seg.endBit = r.pos;
          return { segments, terminatorAt: -1, implicitEnd: false, error: `未知のモード指示子 ${mode.toString(2).padStart(4, '0')} (bit ${start})` };
      }
    } catch (e) {
      seg.error = (e as Error).message;
      seg.endBit = r.pos;
      return { segments, terminatorAt: -1, implicitEnd: false, error: `${seg.modeName}: ${seg.error}` };
    }
    seg.endBit = r.pos;
  }
}

function printable(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
}

export function analyzeTrailing(data: Uint8Array, version: number, terminatorAt: number, implicitEnd: boolean): TrailingAnalysis {
  const totalBits = data.length * 8;
  const r = new BitReader(data);
  let terminatorLength = 0;
  let pos: number;
  if (implicitEnd) {
    pos = terminatorAt < 0 ? totalBits : terminatorAt;
    terminatorLength = totalBits - pos;
    pos = totalBits;
  } else {
    terminatorLength = Math.min(4, totalBits - terminatorAt);
    pos = terminatorAt + terminatorLength;
  }
  const alignBits: number[] = [];
  r.pos = pos;
  while (r.pos % 8 !== 0 && r.remaining > 0) alignBits.push(r.read(1));
  const padStartByte = r.pos / 8;
  const padBytes = data.slice(padStartByte);
  let firstDeviation = -1;
  let lastDeviation = -1;
  let deviating = 0;
  padBytes.forEach((b, i) => {
    const expected = i % 2 === 0 ? 0xec : 0x11;
    if (b !== expected) {
      deviating++;
      if (firstDeviation < 0) firstDeviation = i;
      lastDeviation = i;
    }
  });
  const suspicious = firstDeviation >= 0 ? padBytes.slice(firstDeviation, lastDeviation + 1) : new Uint8Array(0);

  // Try to parse the whole region after the terminator as more segments.
  let hiddenSegments: DecodedSegment[] = [];
  if (!implicitEnd && terminatorAt >= 0) {
    for (const startBit of [terminatorAt + 4, padStartByte * 8]) {
      if (startBit >= totalBits) continue;
      const rr = new BitReader(data);
      rr.pos = startBit;
      const parsed = parseSegments(rr, version);
      const good = parsed.segments.filter((s) => !s.error && (s.count ?? 0) > 0);
      if (good.length > 0 && !parsed.error) {
        hiddenSegments = parsed.segments;
        break;
      }
    }
  }
  // Heuristic: EC/11 pad but shifted by one (starts with 0x11) is still "standard-ish"; we keep strict.
  const alignNonZero = alignBits.some((b) => b !== 0);
  return {
    terminatorStart: implicitEnd ? -1 : terminatorAt,
    terminatorLength,
    implicitEnd,
    alignBits,
    alignBitsNonZero: alignNonZero,
    padStartByte,
    padBytes,
    standardPadding: deviating === 0,
    firstDeviation,
    deviatingBytes: deviating,
    suspiciousBytes: suspicious,
    hiddenSegments,
    suspiciousText: guessDecode(suspicious).text,
    hasDataAfterTerminator: deviating > 0 || alignNonZero || hiddenSegments.length > 0,
  };
}

export function decodeGrid(grid: BitGrid, opts: { allowMirror?: boolean } = {}): DecodeResult {
  const first = decodeGridOnce(grid, false);
  if (first.ok || opts.allowMirror === false) return first;
  const mirrored = decodeGridOnce({ size: grid.size, get: (x, y) => grid.get(y, x) }, true);
  return mirrored.ok ? mirrored : first;
}

function decodeGridOnce(grid: BitGrid, mirrored: boolean): DecodeResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const size = grid.size;
  const version = (size - 17) / 4;
  if (!Number.isInteger(version) || version < 1 || version > 40) {
    throw new Error(`サイズ ${size} は有効な QR コードのサイズではありません`);
  }
  // Load raw matrix
  const probe = new QrMatrix(version);
  const loadInto = (m: QrMatrix) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) m.modules[y * size + x] = grid.get(x, y) ? 1 : 0;
  };
  loadInto(probe);

  let versionInfo: DecodeResult['versionInfo'];
  if (version >= 7) {
    const raw = probe.readVersionBits();
    const a = decodeVersionBits(raw[0]);
    const b = decodeVersionBits(raw[1]);
    const best = a.distance <= b.distance ? a : b;
    versionInfo = { raw, decoded: best.version, distance: best.distance };
    if (best.distance > 3) warnings.push(`バージョン情報が読めません (距離 ${best.distance})。サイズから v${version} とみなします`);
    else if (best.version !== version) {
      warnings.push(`バージョン情報 (v${best.version}) とサイズ (v${version}) が不一致。サイズを優先します`);
    }
  }

  const fraw = probe.readFormatBits();
  const f0 = decodeFormatBits(fraw[0]);
  const f1 = decodeFormatBits(fraw[1]);
  const usedCopy = f0.distance <= f1.distance ? 0 : 1;
  const f = usedCopy === 0 ? f0 : f1;
  if (f.distance > 3) errors.push(`形式情報を訂正できません (距離 ${f.distance})`);
  else if (f.distance > 0) warnings.push(`形式情報に ${f.distance} bit の誤りがありました（訂正済み）`);
  if (fraw[0] !== fraw[1]) warnings.push('形式情報の2つのコピーが一致しません');
  const ec = f.ec;
  const mask = f.mask;

  const m = new QrMatrix(version);
  loadInto(m);
  const order = m.dataModuleOrder();
  // Unmask data modules
  for (const [x, y] of order) {
    if (maskBit(mask, y, x)) m.modules[y * size + x] ^= 1;
  }
  const info = blockInfo(version, ec);
  const raw = new Uint8Array(info.totalCodewords);
  order.forEach(([x, y], i) => {
    const cw = i >>> 3;
    if (cw < raw.length && m.get(x, y)) raw[cw] |= 1 << (7 - (i & 7));
  });
  const remainderBitsValues = order.slice(info.totalCodewords * 8).map(([x, y]) => (m.get(x, y) ? 1 : 0));
  if (remainderBitsValues.length !== remainderBits(version)) warnings.push('剰余ビット数が想定と異なります');

  // Deinterleave
  const blocksData: number[][] = [];
  const blockLens: number[] = [];
  for (let i = 0; i < info.numBlocks; i++) {
    blockLens.push(info.shortBlockDataLen + (i < info.numShortBlocks ? 0 : 1));
    blocksData.push([]);
  }
  let k = 0;
  for (let i = 0; i < info.shortBlockDataLen + 1; i++) {
    for (let b = 0; b < info.numBlocks; b++) if (i < blockLens[b]) blocksData[b].push(raw[k++]);
  }
  for (let i = 0; i < info.eccPerBlock; i++) for (let b = 0; b < info.numBlocks; b++) blocksData[b].push(raw[k++]);

  const blocks: BlockReport[] = [];
  const data: number[] = [];
  blocksData.forEach((bd, i) => {
    const res = rsDecode(bd, info.eccPerBlock);
    blocks.push({
      index: i,
      dataLength: blockLens[i],
      eccLength: info.eccPerBlock,
      ok: res.ok,
      errorsCorrected: res.errorPositions.length,
      errorPositions: res.errorPositions,
      message: res.message,
    });
    if (!res.ok) errors.push(`ブロック ${i + 1}: 誤り訂正に失敗 (${res.message})`);
    for (let j = 0; j < blockLens[i]; j++) data.push(res.corrected[j]);
  });
  const dataCodewords = Uint8Array.from(data);

  const reader = new BitReader(dataCodewords);
  const parsed = parseSegments(reader, version);
  if (parsed.error) errors.push(parsed.error);
  const segments = parsed.segments;
  let trailing: TrailingAnalysis | undefined;
  if (!parsed.error) trailing = analyzeTrailing(dataCodewords, version, parsed.terminatorAt, parsed.implicitEnd);

  for (const s of segments) {
    if (s.nulThenData) {
      warnings.push(`${s.modeName} セグメントに NUL (0x00) があり、その後ろに ${s.nulThenData.bytesAfter} バイトのデータがあります（NUL 終端として扱うリーダーでは切り捨てられます）`);
    }
  }
  if (trailing?.hasDataAfterTerminator) warnings.push('終端パターン以降に標準の埋め草 (EC 11) 以外のデータがあります');
  if (remainderBitsValues.some((b) => b)) warnings.push('剰余ビットが 0 ではありません');

  const text = segments
    .filter((s) => s.modeBits !== 0b0111 && s.modeBits !== 0b0011 && s.modeBits !== 0b0101 && s.modeBits !== 0b1001)
    .map((s) => s.text ?? '')
    .join('');

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    size,
    version,
    versionInfo,
    ec,
    mask,
    formatInfo: { raw: fraw, corrected: f.bits, distance: f.distance, usedCopy },
    mirrored,
    rawCodewords: raw,
    dataCodewords,
    blocks,
    segments,
    text,
    trailing,
    remainderBitsValues,
    matrix: m,
  };
}

export { toHex, printable };
