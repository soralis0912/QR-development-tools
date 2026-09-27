// Static tables from ISO/IEC 18004.

export type EcLevel = 'L' | 'M' | 'Q' | 'H';
export const EC_LEVELS: EcLevel[] = ['L', 'M', 'Q', 'H'];

/** Format-info bits for each EC level (L=01, M=00, Q=11, H=10). */
export const EC_FORMAT_BITS: Record<EcLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };
export const EC_FROM_FORMAT_BITS: EcLevel[] = ['M', 'L', 'H', 'Q'];

// Index [ecIndex][version]; index 0 unused. ecIndex follows EC_LEVELS order.
const ECC_CODEWORDS_PER_BLOCK: number[][] = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];

const NUM_ERROR_CORRECTION_BLOCKS: number[][] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

export function ecIndex(ec: EcLevel): number {
  return EC_LEVELS.indexOf(ec);
}

export function sizeOf(version: number): number {
  return version * 4 + 17;
}

/** Number of modules available for data+EC codewords (incl. remainder bits). */
export function numRawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

export function totalCodewords(version: number): number {
  return Math.floor(numRawDataModules(version) / 8);
}

export function remainderBits(version: number): number {
  return numRawDataModules(version) % 8;
}

export interface BlockInfo {
  numBlocks: number;
  eccPerBlock: number;
  numShortBlocks: number;
  shortBlockDataLen: number; // long blocks have +1
  totalCodewords: number;
  dataCodewords: number;
}

export function blockInfo(version: number, ec: EcLevel): BlockInfo {
  const i = ecIndex(ec);
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[i][version];
  const eccPerBlock = ECC_CODEWORDS_PER_BLOCK[i][version];
  const total = totalCodewords(version);
  const numShortBlocks = numBlocks - (total % numBlocks);
  const shortBlockLen = Math.floor(total / numBlocks);
  return {
    numBlocks,
    eccPerBlock,
    numShortBlocks,
    shortBlockDataLen: shortBlockLen - eccPerBlock,
    totalCodewords: total,
    dataCodewords: total - eccPerBlock * numBlocks,
  };
}

export function dataCodewords(version: number, ec: EcLevel): number {
  return blockInfo(version, ec).dataCodewords;
}

export function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = sizeOf(version) - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

// ---- BCH codes for format and version info ----

export function formatBits(ec: EcLevel, mask: number): number {
  const data = (EC_FORMAT_BITS[ec] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

export function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

export function popcount(x: number): number {
  let c = 0;
  while (x) {
    x &= x - 1;
    c++;
  }
  return c;
}

/** Find nearest valid format info. Returns ec, mask and Hamming distance. */
export function decodeFormatBits(bits: number): { ec: EcLevel; mask: number; distance: number; bits: number } {
  let best = { ec: 'M' as EcLevel, mask: 0, distance: 99, bits: 0 };
  for (const ec of EC_LEVELS) {
    for (let mask = 0; mask < 8; mask++) {
      const cand = formatBits(ec, mask);
      const d = popcount(cand ^ bits);
      if (d < best.distance) best = { ec, mask, distance: d, bits: cand };
    }
  }
  return best;
}

export function decodeVersionBits(bits: number): { version: number; distance: number } {
  let best = { version: 0, distance: 99 };
  for (let v = 7; v <= 40; v++) {
    const d = popcount(versionBits(v) ^ bits);
    if (d < best.distance) best = { version: v, distance: d };
  }
  return best;
}

// ---- Masks ----

export const MASK_FORMULAS = [
  '(i + j) mod 2 = 0',
  'i mod 2 = 0',
  'j mod 3 = 0',
  '(i + j) mod 3 = 0',
  '(⌊i/2⌋ + ⌊j/3⌋) mod 2 = 0',
  '(i·j) mod 2 + (i·j) mod 3 = 0',
  '((i·j) mod 2 + (i·j) mod 3) mod 2 = 0',
  '((i+j) mod 2 + (i·j) mod 3) mod 2 = 0',
];

/** i = row (y), j = column (x). */
export function maskBit(mask: number, i: number, j: number): boolean {
  switch (mask) {
    case 0: return (i + j) % 2 === 0;
    case 1: return i % 2 === 0;
    case 2: return j % 3 === 0;
    case 3: return (i + j) % 3 === 0;
    case 4: return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
    case 5: return ((i * j) % 2) + ((i * j) % 3) === 0;
    case 6: return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0;
    case 7: return (((i + j) % 2) + ((i * j) % 3)) % 2 === 0;
    default: throw new Error(`invalid mask ${mask}`);
  }
}

export interface CodewordOwner {
  block: number;
  isEcc: boolean;
  /** Index within the block's data or ECC part. */
  index: number;
  /** For data codewords: index in the concatenated (de-interleaved) data sequence. */
  dataIndex: number;
}

/** Describe every codeword of the interleaved final sequence. */
export function codewordOwners(version: number, ec: EcLevel): CodewordOwner[] {
  const info = blockInfo(version, ec);
  const lens: number[] = [];
  const offsets: number[] = [];
  let off = 0;
  for (let b = 0; b < info.numBlocks; b++) {
    const len = info.shortBlockDataLen + (b < info.numShortBlocks ? 0 : 1);
    lens.push(len);
    offsets.push(off);
    off += len;
  }
  const out: CodewordOwner[] = [];
  for (let i = 0; i < info.shortBlockDataLen + 1; i++) {
    for (let b = 0; b < info.numBlocks; b++) {
      if (i < lens[b]) out.push({ block: b, isEcc: false, index: i, dataIndex: offsets[b] + i });
    }
  }
  for (let i = 0; i < info.eccPerBlock; i++) {
    for (let b = 0; b < info.numBlocks; b++) out.push({ block: b, isEcc: true, index: i, dataIndex: -1 });
  }
  return out;
}
