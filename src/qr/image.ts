// Image -> module grid. Uses ZXing's detector for localisation / perspective
// sampling, then hands the raw grid to our own diagnostic decoder.

// Deep imports keep the bundle to the QR detector instead of every ZXing format.
import BinaryBitmap from '@zxing/library/esm/core/BinaryBitmap';
import DecodeHintType from '@zxing/library/esm/core/DecodeHintType';
import GlobalHistogramBinarizer from '@zxing/library/esm/core/common/GlobalHistogramBinarizer';
import HybridBinarizer from '@zxing/library/esm/core/common/HybridBinarizer';
import InvertedLuminanceSource from '@zxing/library/esm/core/InvertedLuminanceSource';
import type LuminanceSource from '@zxing/library/esm/core/LuminanceSource';
import RGBLuminanceSource from '@zxing/library/esm/core/RGBLuminanceSource';
import QRDetector from '@zxing/library/esm/core/qrcode/detector/Detector';
import type { BitGrid } from './decoder';

export interface ImageLike {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface GridCandidate {
  grid: BitGrid;
  method: string;
  points?: { x: number; y: number }[];
}

export function toLuminance(img: ImageLike): Uint8ClampedArray {
  const out = new Uint8ClampedArray(img.width * img.height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const a = img.data[p + 3] / 255;
    // Composite transparent pixels over white.
    const r = img.data[p] * a + 255 * (1 - a);
    const g = img.data[p + 1] * a + 255 * (1 - a);
    const b = img.data[p + 2] * a + 255 * (1 - a);
    out[i] = (r * 299 + g * 587 + b * 114) / 1000;
  }
  return out;
}

function zxingDetect(source: LuminanceSource, binarizer: 'hybrid' | 'global'): GridCandidate | null {
  try {
    const bin = binarizer === 'hybrid' ? new HybridBinarizer(source) : new GlobalHistogramBinarizer(source);
    const bitmap = new BinaryBitmap(bin);
    const hints = new Map<DecodeHintType, unknown>([[DecodeHintType.TRY_HARDER, true]]);
    const det = new QRDetector(bitmap.getBlackMatrix()).detect(hints);
    const bits = det.getBits();
    const size = bits.getWidth();
    return {
      grid: { size, get: (x, y) => bits.get(x, y) },
      method: `ZXing detector (${binarizer})`,
      points: det.getPoints().map((p) => ({ x: p.getX(), y: p.getY() })),
    };
  } catch {
    return null;
  }
}

/**
 * Fallback for clean, axis-aligned images (e.g. screenshots / generated PNGs):
 * threshold, find bounding box, estimate module size from the top-left finder.
 */
export function pureGrid(lum: Uint8ClampedArray, width: number, height: number, invert = false): GridCandidate | null {
  let min = 255;
  let max = 0;
  for (const v of lum) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max - min < 32) return null;
  const th = (min + max) / 2;
  const dark = (x: number, y: number) => (lum[y * width + x] < th) !== invert;
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (dark(x, y)) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (right < 0) return null;
  // Diagonal run through the top-left finder: 7 modules dark-light-dark...
  let run = 0;
  while (left + run < width && top + run < height && dark(left + run, top + run)) run++;
  const moduleSize = run; // outer ring is one module thick
  if (moduleSize < 1) return null;
  const wModules = (right - left + 1) / moduleSize;
  const size = Math.round(wModules);
  if ((size - 17) % 4 !== 0 || size < 21 || size > 177) return null;
  const step = (right - left + 1) / size;
  const stepY = (bottom - top + 1) / size;
  const rows: boolean[][] = [];
  for (let j = 0; j < size; j++) {
    const row: boolean[] = [];
    for (let i = 0; i < size; i++) {
      const x = Math.min(width - 1, Math.floor(left + (i + 0.5) * step));
      const y = Math.min(height - 1, Math.floor(top + (j + 0.5) * stepY));
      row.push(dark(x, y));
    }
    rows.push(row);
  }
  return {
    grid: { size, get: (x, y) => rows[y][x] },
    method: invert ? 'ピュア画像サンプリング (反転)' : 'ピュア画像サンプリング',
    points: [
      { x: left, y: bottom },
      { x: left, y: top },
      { x: right, y: top },
    ],
  };
}

/** Produce candidate grids in order of preference. */
export function gridCandidates(img: ImageLike): GridCandidate[] {
  const lum = toLuminance(img);
  const out: GridCandidate[] = [];
  const push = (c: GridCandidate | null) => {
    if (c) out.push(c);
  };
  push(pureGrid(lum, img.width, img.height));
  const src = new RGBLuminanceSource(lum, img.width, img.height);
  push(zxingDetect(src, 'hybrid'));
  push(zxingDetect(src, 'global'));
  const inv = new InvertedLuminanceSource(src);
  const hyInv = zxingDetect(inv, 'hybrid');
  if (hyInv) out.push({ ...hyInv, method: hyInv.method + ' 反転' });
  push(pureGrid(lum, img.width, img.height, true));
  return out;
}
