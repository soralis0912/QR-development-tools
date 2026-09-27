// QR encoder with every knob exposed for debugging.

import { QrMatrix, penalty, type PenaltyBreakdown } from './matrix';
import { rsEncode } from './reedsolomon';
import { appendSegment, BitBuffer, segmentBitLength, validateSegment, type SegmentInput } from './segments';
import { blockInfo, dataCodewords, EC_LEVELS, remainderBits, type EcLevel } from './tables';

export type PaddingMode = 'standard' | 'zeros' | 'custom';

export interface EncodeOptions {
  segments: SegmentInput[];
  ec: EcLevel;
  /** 1-40, or 'auto' for smallest fitting version between minVersion and maxVersion. */
  version: number | 'auto';
  minVersion?: number;
  maxVersion?: number;
  /** Raise EC level while the data still fits in the chosen version. */
  boostEc?: boolean;
  /** 0-7, 'auto' (lowest penalty), or 'none' (leave data unmasked; format still claims `maskFormatAs`). */
  mask: number | 'auto' | 'none';
  /** Mask number written into format info when mask === 'none'. */
  maskFormatAs?: number;
  /** Terminator length: 'auto' = up to 4 zero bits (standard). */
  terminatorBits?: number | 'auto';
  padding?: PaddingMode;
  /** Pad byte pattern (repeated) for padding === 'custom'. */
  customPad?: Uint8Array;
  /**
   * Bytes injected right after the terminator (byte-aligned), before pad bytes.
   * A standard decoder ignores them; used to test "data after terminator" detection.
   */
  hiddenData?: Uint8Array;
  /** Replace the entire data codeword sequence (before RS) — raw mode. */
  rawDataCodewords?: Uint8Array;
  /** Override the 15-bit format info word. */
  formatBitsOverride?: number;
  /** Modules (x,y) to flip after masking (error injection). */
  flips?: [number, number][];
  /** Data codewords (by index into final interleaved stream) to corrupt by XOR 0xFF. */
  corruptCodewords?: number[];
}

export interface EncodeResult {
  version: number;
  ec: EcLevel;
  mask: number;
  maskApplied: boolean;
  size: number;
  matrix: QrMatrix;
  bitBuffer: BitBuffer;
  /** Bits used by segments (before terminator). */
  segmentBits: number;
  terminatorBits: number;
  hiddenBytes: number;
  padBytes: number;
  capacityBits: number;
  dataCodewords: Uint8Array;
  blocks: { data: Uint8Array; ecc: Uint8Array }[];
  finalCodewords: Uint8Array;
  /** For each data module in placement order: codeword index (or -1 for remainder bits). */
  moduleCodeword: Int32Array;
  penalties: PenaltyBreakdown[];
  formatBits: number;
  versionBits: number | null;
  warnings: string[];
}

export function fitsVersion(segments: SegmentInput[], version: number, ec: EcLevel): boolean {
  const bits = segments.reduce((s, seg) => s + segmentBitLength(seg, version), 0);
  return bits <= dataCodewords(version, ec) * 8;
}

export function encode(opts: EncodeOptions): EncodeResult {
  const warnings: string[] = [];
  for (const seg of opts.segments) {
    const err = validateSegment(seg);
    if (err) throw new Error(err);
  }
  const hidden = opts.hiddenData ?? new Uint8Array(0);

  // --- choose version ---
  let version: number;
  const extraBits = hidden.length * 8 + (hidden.length ? 7 + 4 : 0);
  const need = (v: number) =>
    opts.segments.reduce((s, seg) => s + segmentBitLength(seg, v), 0) + (opts.rawDataCodewords ? 0 : extraBits);
  if (opts.version === 'auto') {
    const minV = opts.minVersion ?? 1;
    const maxV = opts.maxVersion ?? 40;
    let found = -1;
    for (let v = minV; v <= maxV; v++) {
      const cap = dataCodewords(v, opts.ec) * 8;
      if (opts.rawDataCodewords ? opts.rawDataCodewords.length * 8 <= cap : need(v) <= cap) {
        found = v;
        break;
      }
    }
    if (found < 0) throw new Error('データが大きすぎて指定範囲のバージョンに収まりません');
    version = found;
  } else {
    version = opts.version;
    if (version < 1 || version > 40) throw new Error('バージョンは 1〜40');
  }

  // --- EC boost ---
  let ec = opts.ec;
  if (opts.boostEc && !opts.rawDataCodewords) {
    for (const cand of EC_LEVELS.slice(EC_LEVELS.indexOf(ec) + 1)) {
      if (need(version) <= dataCodewords(version, cand) * 8) ec = cand;
    }
  }

  const info = blockInfo(version, ec);
  const capacityBits = info.dataCodewords * 8;

  // --- bit stream ---
  const bb = new BitBuffer();
  let segmentBits = 0;
  let terminatorBits = 0;
  let padBytes = 0;
  let data: Uint8Array;

  if (opts.rawDataCodewords) {
    data = new Uint8Array(info.dataCodewords);
    data.set(opts.rawDataCodewords.subarray(0, info.dataCodewords));
    if (opts.rawDataCodewords.length > info.dataCodewords) warnings.push('生データが容量を超えたため切り詰めました');
    if (opts.rawDataCodewords.length < info.dataCodewords) warnings.push('生データが容量未満のため 0x00 で埋めました');
    for (const b of data) bb.push(b, 8);
    bb.spans.push({ start: 0, length: bb.length, label: '生データコード語', kind: 'data' });
  } else {
    opts.segments.forEach((seg, i) => appendSegment(bb, seg, version, i));
    segmentBits = bb.length;
    if (segmentBits > capacityBits) {
      throw new Error(`データ ${segmentBits} bit が容量 ${capacityBits} bit (v${version}-${ec}) を超えています`);
    }
    const wantTerm = opts.terminatorBits === 'auto' || opts.terminatorBits === undefined ? 4 : opts.terminatorBits;
    terminatorBits = Math.min(wantTerm, capacityBits - bb.length);
    if (terminatorBits > 0) bb.push(0, terminatorBits, '終端パターン', 'terminator');
    const alignBits = (8 - (bb.length % 8)) % 8;
    if (alignBits && bb.length + alignBits <= capacityBits) bb.push(0, alignBits, 'バイト境界埋め', 'align');

    if (hidden.length) {
      const room = Math.floor((capacityBits - bb.length) / 8);
      const n = Math.min(room, hidden.length);
      if (n < hidden.length) warnings.push(`終端後データ ${hidden.length}B のうち ${n}B のみ格納しました`);
      const start = bb.length;
      for (let i = 0; i < n; i++) bb.push(hidden[i], 8);
      if (n) bb.spans.push({ start, length: n * 8, label: `終端後データ (${n}B)`, kind: 'hidden' });
    }

    const padMode = opts.padding ?? 'standard';
    const pattern =
      padMode === 'standard' ? [0xec, 0x11] : padMode === 'zeros' ? [0x00] : Array.from(opts.customPad ?? [0xec, 0x11]);
    if (pattern.length === 0) pattern.push(0);
    const padStart = bb.length;
    for (let i = 0; bb.length + 8 <= capacityBits; i++) {
      bb.push(pattern[i % pattern.length], 8);
      padBytes++;
    }
    if (padBytes) bb.spans.push({ start: padStart, length: padBytes * 8, label: `埋め草 (${padBytes}B)`, kind: 'pad' });
    data = bb.toBytes();
    if (data.length < info.dataCodewords) {
      const d2 = new Uint8Array(info.dataCodewords);
      d2.set(data);
      data = d2;
    }
  }

  // --- blocks + RS ---
  const blocks: { data: Uint8Array; ecc: Uint8Array }[] = [];
  let k = 0;
  for (let i = 0; i < info.numBlocks; i++) {
    const len = info.shortBlockDataLen + (i < info.numShortBlocks ? 0 : 1);
    const d = data.slice(k, k + len);
    k += len;
    blocks.push({ data: d, ecc: rsEncode(d, info.eccPerBlock) });
  }
  const final: number[] = [];
  const maxData = info.shortBlockDataLen + 1;
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data.length) final.push(b.data[i]);
  for (let i = 0; i < info.eccPerBlock; i++) for (const b of blocks) final.push(b.ecc[i]);
  const finalCodewords = Uint8Array.from(final);
  for (const idx of opts.corruptCodewords ?? []) {
    if (idx >= 0 && idx < finalCodewords.length) finalCodewords[idx] ^= 0xff;
  }

  // --- place ---
  const base = new QrMatrix(version);
  const order = base.dataModuleOrder();
  const moduleCodeword = new Int32Array(order.length).fill(-1);
  const rem = remainderBits(version);
  order.forEach(([x, y], i) => {
    const cw = i >>> 3;
    if (cw < finalCodewords.length) {
      base.set(x, y, ((finalCodewords[cw] >>> (7 - (i & 7))) & 1) === 1);
      moduleCodeword[i] = cw;
    } else {
      base.set(x, y, false, 'remainder');
    }
  });
  if (order.length !== finalCodewords.length * 8 + rem) warnings.push('内部エラー: モジュール数が一致しません');
  const versionBitsValue = base.drawVersion();

  // --- masks ---
  const penalties: PenaltyBreakdown[] = [];
  for (let m = 0; m < 8; m++) {
    const t = base.clone();
    t.applyMask(m);
    t.drawFormat(ec, m);
    penalties.push(penalty(t));
  }
  let mask: number;
  let maskApplied = true;
  if (opts.mask === 'auto') {
    mask = 0;
    for (let m = 1; m < 8; m++) if (penalties[m].total < penalties[mask].total) mask = m;
  } else if (opts.mask === 'none') {
    mask = opts.maskFormatAs ?? 0;
    maskApplied = false;
    warnings.push('マスク未適用: 仕様外のシンボルです（通常のリーダーでは読めません）');
  } else {
    mask = opts.mask;
  }
  const matrix = base.clone();
  if (maskApplied) matrix.applyMask(mask);
  const fmt = matrix.drawFormat(ec, mask, opts.formatBitsOverride);
  for (const [x, y] of opts.flips ?? []) {
    if (x >= 0 && y >= 0 && x < matrix.size && y < matrix.size) matrix.modules[y * matrix.size + x] ^= 1;
  }

  return {
    version,
    ec,
    mask,
    maskApplied,
    size: matrix.size,
    matrix,
    bitBuffer: bb,
    segmentBits,
    terminatorBits,
    hiddenBytes: hidden.length,
    padBytes,
    capacityBits,
    dataCodewords: data,
    blocks,
    finalCodewords,
    moduleCodeword,
    penalties,
    formatBits: fmt,
    versionBits: versionBitsValue,
    warnings,
  };
}
