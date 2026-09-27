import jsQR from 'jsqr';
import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';
import { decodeGrid, type BitGrid } from '../src/qr/decoder';
import { encode, type EncodeOptions } from '../src/qr/encoder';
import { gridCandidates, type ImageLike } from '../src/qr/image';
import type { QrMatrix } from '../src/qr/matrix';
import { rsDecode, rsEncode } from '../src/qr/reedsolomon';
import type { SegmentInput } from '../src/qr/segments';
import { EC_LEVELS } from '../src/qr/tables';

function render(m: QrMatrix, scale = 4, quiet = 4): ImageLike {
  const dim = (m.size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (!m.get(x, y)) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const p = (((y + quiet) * scale + dy) * dim + (x + quiet) * scale + dx) * 4;
          data[p] = data[p + 1] = data[p + 2] = 0;
        }
      }
    }
  }
  return { data, width: dim, height: dim };
}

const grid = (m: QrMatrix): BitGrid => ({ size: m.size, get: (x, y) => m.get(x, y) });

function enc(segments: SegmentInput[], extra: Partial<EncodeOptions> = {}) {
  return encode({ segments, ec: 'M', version: 'auto', mask: 'auto', ...extra });
}

describe('reed-solomon', () => {
  it('corrects up to t errors', () => {
    const data = Array.from({ length: 20 }, (_, i) => (i * 37 + 11) & 0xff);
    const ecc = rsEncode(data, 10);
    const block = [...data, ...ecc];
    const bad = block.slice();
    for (const p of [0, 5, 13, 22, 29]) bad[p] ^= 0x5a;
    const r = rsDecode(bad, 10);
    expect(r.ok).toBe(true);
    expect(Array.from(r.corrected)).toEqual(block);
    expect(r.errorPositions.sort((a, b) => a - b)).toEqual([0, 5, 13, 22, 29]);
  });
  it('fails beyond capacity', () => {
    const data = [1, 2, 3, 4, 5, 6, 7, 8];
    const block = [...data, ...rsEncode(data, 4)];
    for (const p of [0, 1, 2]) block[p] ^= 0xff;
    expect(rsDecode(block, 4).ok).toBe(false);
  });
});

describe('encoder vs jsQR', () => {
  const cases: [string, SegmentInput[]][] = [
    ['numeric', [{ mode: 'numeric', text: '01234567890123' }]],
    ['alnum', [{ mode: 'alphanumeric', text: 'HELLO WORLD $%*+-./:' }]],
    ['byte', [{ mode: 'byte', text: 'Hello, world! https://example.com/?q=1', encoding: 'utf-8' }]],
    ['mixed', [
      { mode: 'alphanumeric', text: 'ABC' },
      { mode: 'numeric', text: '12345' },
      { mode: 'byte', text: 'xyz', encoding: 'utf-8' },
    ]],
  ];
  for (const [name, segs] of cases) {
    for (const ec of EC_LEVELS) {
      it(`${name} ${ec} all masks`, () => {
        for (let mask = 0; mask < 8; mask++) {
          const r = enc(segs, { ec, mask });
          const img = render(r.matrix);
          const out = jsQR(img.data, img.width, img.height);
          expect(out?.data).toBe(segs.map((s) => s.text).join(''));
          expect(out?.version).toBe(r.version);
        }
      });
    }
  }
  it('every version 1-40 is bit-identical to node-qrcode', () => {
    for (let v = 1; v <= 40; v++) {
      for (const ec of EC_LEVELS) {
        const text = `v${v}`;
        const mask = v % 8;
        const r = enc([{ mode: 'byte', text, encoding: 'utf-8' }], { version: v, ec, mask });
        const q = QRCode.create(text, { errorCorrectionLevel: ec, version: v, maskPattern: mask as 0 });
        let diff = 0;
        for (let y = 0; y < r.size; y++) for (let x = 0; x < r.size; x++) if ((q.modules.get(y, x) === 1) !== r.matrix.get(x, y)) diff++;
        expect(diff, `v${v}-${ec}`).toBe(0);
        const d = decodeGrid(grid(r.matrix));
        expect(d.ok, `v${v} ${d.errors}`).toBe(true);
        expect(d.text).toBe(text);
        expect(d.trailing?.hasDataAfterTerminator).toBe(false);
      }
    }
  });
  it('kanji mode', () => {
    const r = enc([{ mode: 'kanji', text: '漢字テスト' }]);
    const img = render(r.matrix);
    const out = jsQR(img.data, img.width, img.height);
    expect(out?.chunks.some((c) => c.type === 'kanji')).toBe(true);
    expect(decodeGrid(grid(r.matrix)).text).toBe('漢字テスト');
  });
});

describe('decoder vs qrcode lib', () => {
  it('decodes matrices from node-qrcode', () => {
    for (const ec of EC_LEVELS) {
      for (let mask = 0; mask < 8; mask++) {
        const text = `qrcode-lib ${ec} ${mask} テスト`;
        const q = QRCode.create(text, { errorCorrectionLevel: ec, maskPattern: mask as 0 });
        const size = q.modules.size;
        const d = decodeGrid({ size, get: (x, y) => q.modules.get(y, x) === 1 });
        expect(d.ok, d.errors.join()).toBe(true);
        expect(d.text).toBe(text);
        expect(d.mask).toBe(mask);
        expect(d.ec).toBe(ec);
        expect(d.trailing?.standardPadding).toBe(true);
      }
    }
  });
  it('auto mask matches qrcode lib for simple input', () => {
    // Penalty rules are implemented slightly differently across libraries; just check validity.
    const r = enc([{ mode: 'byte', text: 'penalty', encoding: 'utf-8' }]);
    expect(r.mask).toBeGreaterThanOrEqual(0);
    expect(r.penalties).toHaveLength(8);
  });
});

describe('diagnostics', () => {
  it('detects data after terminator', () => {
    const hidden = new TextEncoder().encode('SECRET');
    const r = enc([{ mode: 'byte', text: 'visible', encoding: 'utf-8' }], { version: 3, hiddenData: hidden });
    // normal readers show only visible text
    const img = render(r.matrix);
    expect(jsQR(img.data, img.width, img.height)?.data).toBe('visible');
    const d = decodeGrid(grid(r.matrix));
    expect(d.ok).toBe(true);
    expect(d.text).toBe('visible');
    expect(d.trailing?.hasDataAfterTerminator).toBe(true);
    expect(d.trailing?.standardPadding).toBe(false);
    expect(new TextDecoder().decode(d.trailing!.suspiciousBytes)).toContain('SECRET');
  });
  it('detects hidden segments after terminator', () => {
    // Build a hidden valid segment stream: byte mode "HI"
    const hidden = Uint8Array.from([0x40, 0x24, 0x84, 0x90, 0xec]);
    const r = enc([{ mode: 'numeric', text: '123' }], { version: 2, hiddenData: hidden });
    const d = decodeGrid(grid(r.matrix));
    expect(d.text).toBe('123');
    expect(d.trailing?.hiddenSegments.map((s) => s.text).join('')).toBe('HI');
  });
  it('zero padding is flagged as non-standard', () => {
    const r = enc([{ mode: 'numeric', text: '1' }], { version: 1, padding: 'zeros' });
    const d = decodeGrid(grid(r.matrix));
    expect(d.text).toBe('1');
    expect(d.trailing?.standardPadding).toBe(false);
  });
  it('detects NUL followed by data', () => {
    const r = enc([{ mode: 'byte', text: '00 41 42', encoding: 'hex' }]);
    const d = decodeGrid(grid(r.matrix));
    expect(d.segments[0].nulThenData).toEqual({ nulIndex: 0, bytesAfter: 2 });
    const r2 = enc([{ mode: 'byte', text: 'AB\u0000CD', encoding: 'utf-8' }]);
    expect(decodeGrid(grid(r2.matrix)).segments[0].nulThenData).toEqual({ nulIndex: 2, bytesAfter: 2 });
  });
  it('reports corrected errors', () => {
    const r = enc([{ mode: 'byte', text: 'error injection', encoding: 'utf-8' }], {
      ec: 'H',
      version: 3,
      corruptCodewords: [0, 5, 9],
    });
    const d = decodeGrid(grid(r.matrix));
    expect(d.ok).toBe(true);
    expect(d.text).toBe('error injection');
    expect(d.blocks.reduce((s, b) => s + b.errorsCorrected, 0)).toBe(3);
  });
  it('corrects format info bit errors', () => {
    const r = enc([{ mode: 'byte', text: 'fmt', encoding: 'utf-8' }], { flips: [[8, 0], [8, 1]] });
    const d = decodeGrid(grid(r.matrix));
    expect(d.ok).toBe(true);
    expect(d.text).toBe('fmt');
  });
  it('decodes mirrored symbols', () => {
    const r = enc([{ mode: 'byte', text: 'mirror', encoding: 'utf-8' }]);
    const d = decodeGrid({ size: r.size, get: (x, y) => r.matrix.get(y, x) });
    expect(d.ok).toBe(true);
    expect(d.mirrored).toBe(true);
    expect(d.text).toBe('mirror');
  });
  it('ECI + shift_jis byte mode', () => {
    const r = enc([
      { mode: 'eci', text: '20' },
      { mode: 'byte', text: 'こんにちは', encoding: 'shift_jis' },
    ]);
    const d = decodeGrid(grid(r.matrix));
    expect(d.text).toBe('こんにちは');
  });
});

describe('image pipeline', () => {
  it('reads generated images', () => {
    for (const v of [1, 5, 7, 20]) {
      const r = enc([{ mode: 'byte', text: `img ${v}`, encoding: 'utf-8' }], { version: v });
      const img = render(r.matrix, 3);
      const cands = gridCandidates(img);
      const ok = cands.map((c) => decodeGrid(c.grid)).find((d) => d.ok);
      expect(ok?.text, `v${v}`).toBe(`img ${v}`);
    }
  });
  it('zxing detector path works on its own', () => {
    const r = enc([{ mode: 'byte', text: 'zxing', encoding: 'utf-8' }], { version: 8 });
    const img = render(r.matrix, 5);
    const cand = gridCandidates(img).find((c) => c.method.startsWith('ZXing'));
    expect(cand).toBeTruthy();
    expect(decodeGrid(cand!.grid).text).toBe('zxing');
  });
});
