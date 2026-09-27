// Reed-Solomon over GF(256), primitive polynomial 0x11D, generator roots α^0..α^(n-1).

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

export function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error('division by zero');
  if (a === 0) return 0;
  return EXP[(LOG[a] + 255 - LOG[b]) % 255];
}

function gfPow(e: number): number {
  return EXP[((e % 255) + 255) % 255];
}

const generatorCache = new Map<number, Uint8Array>();

/** Generator polynomial coefficients, highest degree first, leading 1 omitted. */
function generator(degree: number): Uint8Array {
  const cached = generatorCache.get(degree);
  if (cached) return cached;
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 2);
  }
  generatorCache.set(degree, result);
  return result;
}

export function rsEncode(data: ArrayLike<number>, eccLen: number): Uint8Array {
  const gen = generator(eccLen);
  const result = new Uint8Array(eccLen);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ result[0];
    result.copyWithin(0, 1);
    result[eccLen - 1] = 0;
    for (let j = 0; j < eccLen; j++) result[j] ^= gfMul(gen[j], factor);
  }
  return result;
}

export interface RsDecodeResult {
  ok: boolean;
  corrected: Uint8Array;
  /** Positions (index into codeword array) that were corrected. */
  errorPositions: number[];
  message?: string;
}

/**
 * Decode a block (data followed by ECC, highest-degree coefficient first).
 * Uses syndromes + Berlekamp–Massey + Chien search + Forney.
 */
export function rsDecode(block: ArrayLike<number>, eccLen: number): RsDecodeResult {
  const n = block.length;
  const msg = Uint8Array.from(block);
  // Syndromes S_i = r(α^i), i = 0..eccLen-1
  const synd = new Uint8Array(eccLen);
  let allZero = true;
  for (let i = 0; i < eccLen; i++) {
    let s = 0;
    const a = gfPow(i);
    for (let j = 0; j < n; j++) s = gfMul(s, a) ^ msg[j];
    synd[i] = s;
    if (s) allZero = false;
  }
  if (allZero) return { ok: true, corrected: msg, errorPositions: [] };

  // Berlekamp–Massey: find error locator Λ(x), lowest degree first.
  let lambda = [1];
  let prev = [1];
  let L = 0;
  let m = 1;
  let b = 1;
  for (let k = 0; k < eccLen; k++) {
    let d = synd[k];
    for (let i = 1; i <= L; i++) d ^= gfMul(lambda[i] ?? 0, synd[k - i]);
    if (d === 0) {
      m++;
      continue;
    }
    const coef = gfDiv(d, b);
    const next = lambda.slice();
    while (next.length < prev.length + m) next.push(0);
    for (let i = 0; i < prev.length; i++) next[i + m] ^= gfMul(coef, prev[i]);
    if (2 * L <= k) {
      prev = lambda;
      L = k + 1 - L;
      b = d;
      m = 1;
    } else {
      m++;
    }
    lambda = next;
  }
  while (lambda.length > 1 && lambda[lambda.length - 1] === 0) lambda.pop();
  const numErrors = lambda.length - 1;
  if (numErrors * 2 > eccLen) {
    return { ok: false, corrected: msg, errorPositions: [], message: 'too many errors' };
  }

  // Chien search. Coefficient at array index p corresponds to power e = n-1-p;
  // its locator X = α^e and Λ(X^-1) = 0.
  const positions: number[] = [];
  for (let p = 0; p < n; p++) {
    const e = n - 1 - p;
    const xinv = gfPow(-e);
    let v = 0;
    for (let i = lambda.length - 1; i >= 0; i--) v = gfMul(v, xinv) ^ lambda[i];
    if (v === 0) positions.push(p);
  }
  if (positions.length !== numErrors) {
    return { ok: false, corrected: msg, errorPositions: [], message: 'error locator roots mismatch' };
  }

  // Ω(x) = S(x)Λ(x) mod x^eccLen, S(x) = Σ S_i x^i
  const omega = new Array<number>(eccLen).fill(0);
  for (let i = 0; i < eccLen; i++) {
    for (let j = 0; j < lambda.length && i + j < eccLen; j++) omega[i + j] ^= gfMul(synd[i], lambda[j]);
  }
  // Forney (b = 0 generator): e = X * Ω(X^-1) / Λ'(X^-1)
  for (const p of positions) {
    const e = n - 1 - p;
    const X = gfPow(e);
    const xinv = gfPow(-e);
    let num = 0;
    for (let i = omega.length - 1; i >= 0; i--) num = gfMul(num, xinv) ^ omega[i];
    let den = 0;
    for (let i = 1; i < lambda.length; i += 2) den ^= gfMul(lambda[i], gfPow(-e * (i - 1)));
    if (den === 0) return { ok: false, corrected: msg, errorPositions: [], message: 'Forney denominator zero' };
    msg[p] ^= gfMul(X, gfDiv(num, den));
  }

  // Verify.
  for (let i = 0; i < eccLen; i++) {
    let s = 0;
    const a = gfPow(i);
    for (let j = 0; j < n; j++) s = gfMul(s, a) ^ msg[j];
    if (s) return { ok: false, corrected: Uint8Array.from(block), errorPositions: [], message: 'verification failed' };
  }
  return { ok: true, corrected: msg, errorPositions: positions };
}
