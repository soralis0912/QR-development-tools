import { decodeGrid, printable, type BitGrid, type DecodeResult, type DecodedSegment } from '../qr/decoder';
import { gridCandidates, type GridCandidate } from '../qr/image';
import { charCountBits, toHex, type Mode } from '../qr/segments';
import { codewordOwners, MASK_FORMULAS } from '../qr/tables';
import { $, badge, card, h, kv, visibleText } from './dom';
import {
  codewordModules,
  codewordOverlay,
  drawToCanvas,
  KIND_COLORS,
  KIND_LABELS,
  kindOverlay,
  REGION_COLORS,
  regionOverlay,
  type BitSpan,
} from './render';

const MAX_DIM = 1400;

interface Attempt {
  cand: GridCandidate;
  result?: DecodeResult;
  error?: string;
}

export interface ReaderApi {
  loadCanvas(c: HTMLCanvasElement): void;
}

const MODE_OF: Record<number, Mode | undefined> = { 1: 'numeric', 2: 'alphanumeric', 4: 'byte', 8: 'kanji' };

function segmentSpans(r: DecodeResult): BitSpan[] {
  const spans: BitSpan[] = [];
  for (const s of r.segments) {
    const m = MODE_OF[s.modeBits];
    spans.push({ start: s.startBit, length: 4, kind: 'mode' });
    if (m) {
      const cc = charCountBits(m, r.version);
      spans.push({ start: s.startBit + 4, length: cc, kind: 'count' });
      spans.push({ start: s.startBit + 4 + cc, length: s.endBit - s.startBit - 4 - cc, kind: 'data' });
    } else {
      spans.push({ start: s.startBit + 4, length: s.endBit - s.startBit - 4, kind: 'count' });
    }
  }
  const t = r.trailing;
  if (t) {
    if (t.terminatorStart >= 0) spans.push({ start: t.terminatorStart, length: t.terminatorLength, kind: 'terminator' });
    const alignStart = t.padStartByte * 8 - t.alignBits.length;
    if (t.alignBits.length) spans.push({ start: alignStart, length: t.alignBits.length, kind: t.alignBitsNonZero ? 'hidden' : 'align' });
    t.padBytes.forEach((b, i) => {
      const std = i % 2 === 0 ? 0xec : 0x11;
      spans.push({ start: (t.padStartByte + i) * 8, length: 8, kind: b === std ? 'pad' : 'hidden' });
    });
  }
  return spans;
}

export function initReader(): ReaderApi {
  const srcCanvas = $<HTMLCanvasElement>('src-canvas');
  const readCanvas = $<HTMLCanvasElement>('read-canvas');
  const details = $('read-details');
  const candSel = $<HTMLSelectElement>('cand');
  const legend = $('r-legend');
  let attempts: Attempt[] = [];
  let current: Attempt | null = null;
  let overlay = 'region';

  function process(imageData: ImageData): boolean {
    const cands = gridCandidates(imageData);
    attempts = cands.map((cand) => {
      try {
        return { cand, result: decodeGrid(cand.grid) };
      } catch (e) {
        return { cand, error: (e as Error).message };
      }
    });
    // Drop duplicate grids that produced identical results.
    const best = attempts.find((a) => a.result?.ok) ?? attempts.find((a) => a.result) ?? attempts[0] ?? null;
    candSel.replaceChildren(
      ...attempts.map((a, i) =>
        h('option', { value: i, selected: a === best }, `${a.cand.method} — ${a.result ? (a.result.ok ? `OK v${a.result.version}` : 'エラー') : a.error}`),
      ),
    );
    $('cand-wrap').hidden = attempts.length < 2;
    select(best);
    return !!best?.result?.ok;
  }

  function select(a: Attempt | null): void {
    current = a;
    drawSourceMarkers();
    if (!a) {
      details.replaceChildren(h('div', { class: 'error' }, 'QR コードを検出できませんでした。'));
      readCanvas.width = readCanvas.height = 0;
      return;
    }
    drawMatrix();
    if (a.result) renderResult(a.result, a.cand);
    else details.replaceChildren(h('div', { class: 'error' }, `解析失敗: ${a.error}`));
  }

  let srcImage: ImageData | null = null;
  function drawSourceMarkers(): void {
    if (!srcImage) return;
    const ctx = srcCanvas.getContext('2d')!;
    ctx.putImageData(srcImage, 0, 0);
    const pts = current?.cand.points;
    if (!pts) return;
    ctx.strokeStyle = '#ff2d55';
    ctx.fillStyle = '#ff2d55';
    ctx.lineWidth = Math.max(2, srcCanvas.width / 300);
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, ctx.lineWidth * 3, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function drawMatrix(): void {
    if (!current) return;
    const g: BitGrid = current.cand.grid;
    const r = current.result;
    const showUnmasked = $<HTMLInputElement>('r-unmasked').checked && r;
    const grid = showUnmasked ? r.matrix : g;
    const scale = Math.max(2, Math.min(12, Math.floor(560 / (g.size + 8))));
    let ov: (string | null)[] | undefined;
    let items: [string, string][] = [];
    let highlight: Set<number> | undefined;
    if (r) {
      if (overlay === 'kind') {
        ov = kindOverlay(r.matrix);
        items = (Object.keys(KIND_COLORS) as (keyof typeof KIND_COLORS)[]).filter((k) => KIND_COLORS[k]).map((k) => [KIND_COLORS[k], KIND_LABELS[k]]);
      } else if (overlay === 'region') {
        ov = regionOverlay(r.matrix, r.ec, segmentSpans(r));
        items = [
          [REGION_COLORS.mode, 'モード指示子'],
          [REGION_COLORS.count, '文字数指示子 / ECI 等'],
          [REGION_COLORS.data, 'データ'],
          [REGION_COLORS.terminator, '終端'],
          [REGION_COLORS.pad, '埋め草 (標準)'],
          [REGION_COLORS.hidden, '非標準 / 終端後データ'],
          [REGION_COLORS.ecc, '誤り訂正'],
        ];
      } else if (overlay === 'codeword') {
        ov = codewordOverlay(r.matrix, r.ec);
        items = [['hsl(0 85% 60%)', 'データ (ブロック毎)'], ['hsl(0 45% 34%)', '誤り訂正']];
      }
      // Highlight corrected codewords.
      const owners = codewordOwners(r.version, r.ec);
      const fix: number[] = [];
      owners.forEach((o, i) => {
        const b = r.blocks[o.block];
        const pos = o.isEcc ? b.dataLength + o.index : o.index;
        if (b.errorPositions.includes(pos)) fix.push(i);
      });
      if (fix.length) {
        highlight = codewordModules(r.matrix, fix);
        items.push(['#ff2d55', `訂正されたコード語 (${fix.length})`]);
      }
    }
    drawToCanvas(readCanvas, grid, { scale, quiet: 2, fg: '#000', bg: '#fff', overlay: ov, highlight });
    legend.replaceChildren(...items.map(([c, l]) => h('span', null, h('i', { style: `background:${c}` }), l)));
  }

  function renderResult(r: DecodeResult, cand: GridCandidate): void {
    const t = r.trailing;
    const nulSegs = r.segments.filter((s) => s.nulThenData);
    const totalFixed = r.blocks.reduce((s, b) => s + b.errorsCorrected, 0);
    const copyBtn = h('button', { class: 'small' }, 'コピー');
    copyBtn.addEventListener('click', () => navigator.clipboard.writeText(r.text).catch(() => undefined));

    const verdict = h(
      'div',
      { class: `verdict ${r.ok ? 'ok' : 'bad'}` },
      h('div', { class: 'badges' },
        r.ok ? badge('デコード成功', 'ok') : badge('デコード失敗', 'bad'),
        t ? (t.hasDataAfterTerminator ? badge('終端以降にデータあり', 'bad') : badge('終端以降: 標準の埋め草のみ', 'ok')) : null,
        nulSegs.length ? badge('NUL (0x00) 以降にデータあり', 'bad') : null,
        totalFixed ? badge(`誤り訂正 ${totalFixed} コード語`, 'warn') : null,
        r.formatInfo.distance ? badge(`形式情報 ${r.formatInfo.distance}bit 訂正`, 'warn') : null,
        r.mirrored ? badge('鏡像', 'warn') : null,
        r.remainderBitsValues.some((b) => b) ? badge('剰余ビット非ゼロ', 'warn') : null,
      ),
      h('div', { class: 'decoded' }, h('pre', { class: 'text' }, visibleText(r.text)), copyBtn),
      r.errors.length ? h('ul', { class: 'errors' }, r.errors.map((e) => h('li', null, e))) : null,
      r.warnings.length ? h('ul', { class: 'warnings' }, r.warnings.map((e) => h('li', null, e))) : null,
    );

    const trailCard = t
      ? card(
          '終端以降の解析',
          kv([
            ['終端パターン', t.implicitEnd ? `なし（容量いっぱいで暗黙終端, 残り ${t.terminatorLength} bit）` : `bit ${t.terminatorStart} から ${t.terminatorLength} bit`],
            ['バイト境界埋め', t.alignBits.length ? h('span', null, h('code', null, t.alignBits.join('')), t.alignBitsNonZero ? badge('非ゼロ', 'bad') : null) : 'なし'],
            ['埋め草開始', `コード語 ${t.padStartByte} (${t.padBytes.length} B)`],
            ['埋め草の判定', t.standardPadding ? badge('標準 (EC 11 交互)', 'ok') : badge(`非標準: ${t.deviatingBytes} B が不一致（先頭 +${t.firstDeviation}）`, 'bad')],
          ]),
          t.padBytes.length
            ? h('pre', { class: 'hex' }, Array.from(t.padBytes, (b, i) => h('span', { class: b === (i % 2 === 0 ? 0xec : 0x11) ? 'pad' : 'dev' }, b.toString(16).padStart(2, '0').toUpperCase() + ' ')))
            : null,
          t.suspiciousBytes.length
            ? h('div', { class: 'hidden-box' },
                h('h4', null, `不一致区間 (${t.suspiciousBytes.length} B)`),
                kv([
                  ['HEX', h('code', { class: 'wrap' }, toHex(t.suspiciousBytes))],
                  ['ASCII', h('code', { class: 'wrap' }, printable(t.suspiciousBytes))],
                  ['テキスト推定', h('code', { class: 'wrap' }, visibleText(t.suspiciousText))],
                ]),
              )
            : null,
          t.hiddenSegments.length
            ? h('div', { class: 'hidden-box' }, h('h4', null, '終端後をセグメントとして解釈した結果'), segTable(t.hiddenSegments))
            : null,
        )
      : null;

    const segCard = card('セグメント', segTable(r.segments));

    const symCard = card(
      'シンボル情報',
      kv([
        ['サンプリング', cand.method],
        ['バージョン', `${r.version} (${r.size}×${r.size})`],
        ['誤り訂正レベル', r.ec],
        ['マスク', `${r.mask}: ${MASK_FORMULAS[r.mask]}`],
        [
          '形式情報',
          h('span', null,
            h('code', null, r.formatInfo.raw[0].toString(2).padStart(15, '0')), ' / ',
            h('code', null, r.formatInfo.raw[1].toString(2).padStart(15, '0')),
            ` → コピー${r.formatInfo.usedCopy + 1} を採用、距離 ${r.formatInfo.distance}`,
          ),
        ],
        [
          '型番情報',
          r.versionInfo
            ? h('span', null, h('code', null, r.versionInfo.raw[0].toString(2).padStart(18, '0')), ` → v${r.versionInfo.decoded}, 距離 ${r.versionInfo.distance}`)
            : '— (v7 未満)',
        ],
        ['剰余ビット', r.remainderBitsValues.length ? h('code', null, r.remainderBitsValues.join('')) : 'なし'],
      ]),
    );

    const blkCard = card(
      'RS ブロック',
      h(
        'table',
        { class: 'tbl' },
        h('thead', null, h('tr', null, ['#', 'データ', 'EC', '訂正数', '状態'].map((x) => h('th', null, x)))),
        h(
          'tbody',
          null,
          r.blocks.map((b) =>
            h(
              'tr',
              null,
              h('td', null, b.index + 1),
              h('td', null, b.dataLength),
              h('td', null, b.eccLength),
              h('td', null, `${b.errorsCorrected} / ${Math.floor(b.eccLength / 2)}`),
              h('td', null, b.ok ? (b.errorsCorrected ? badge('訂正済', 'warn') : badge('OK', 'ok')) : badge(b.message ?? 'NG', 'bad')),
            ),
          ),
        ),
      ),
    );

    const cwCard = card(
      'コード語',
      h('h4', null, `データコード語 (${r.dataCodewords.length} B, 誤り訂正後)`),
      h('pre', { class: 'hex' }, toHex(r.dataCodewords)),
      h('h4', null, `読み取った全コード語 (${r.rawCodewords.length} B, インターリーブ状態)`),
      h('pre', { class: 'hex' }, toHex(r.rawCodewords)),
    );

    details.replaceChildren(verdict, trailCard ?? '', segCard, symCard, blkCard, cwCard);
  }

  function segTable(segs: DecodedSegment[]): HTMLElement {
    if (!segs.length) return h('p', { class: 'empty' }, 'セグメントなし');
    return h(
      'table',
      { class: 'tbl segs' },
      h('thead', null, h('tr', null, ['#', 'モード', 'bit 範囲', '文字数', '内容'].map((x) => h('th', null, x)))),
      h(
        'tbody',
        null,
        segs.map((s, i) =>
          h(
            'tr',
            { class: s.error ? 'bad' : '' },
            h('td', null, i + 1),
            h('td', null, s.modeName, s.charset ? h('small', null, ` ${s.charset}`) : null),
            h('td', null, `${s.startBit}–${s.endBit}`),
            h('td', null, s.count ?? ''),
            h(
              'td',
              null,
              h('div', { class: 'seg-text' }, visibleText(s.text ?? '')),
              s.bytes ? h('code', { class: 'wrap sub' }, toHex(s.bytes)) : null,
              s.nulThenData ? h('div', null, badge(`NUL @${s.nulThenData.nulIndex}, 後続 ${s.nulThenData.bytesAfter} B`, 'bad')) : null,
              s.error ? h('div', { class: 'error-inline' }, s.error) : null,
            ),
          ),
        ),
      ),
    );
  }

  // ---- inputs ----
  function loadImageSource(src: CanvasImageSource, w: number, hgt: number): void {
    const k = Math.min(1, MAX_DIM / Math.max(w, hgt));
    srcCanvas.width = Math.round(w * k);
    srcCanvas.height = Math.round(hgt * k);
    const ctx = srcCanvas.getContext('2d', { willReadFrequently: true })!;
    ctx.imageSmoothingEnabled = k < 1;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, srcCanvas.width, srcCanvas.height);
    ctx.drawImage(src, 0, 0, srcCanvas.width, srcCanvas.height);
    srcImage = ctx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
    process(srcImage);
  }

  async function loadBlob(blob: Blob): Promise<void> {
    try {
      const bmp = await createImageBitmap(blob);
      loadImageSource(bmp, bmp.width, bmp.height);
    } catch (e) {
      details.replaceChildren(h('div', { class: 'error' }, `画像を読み込めません: ${(e as Error).message}`));
    }
  }

  const drop = $('drop');
  const fileInput = $<HTMLInputElement>('file');
  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') fileInput.click();
  });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) loadBlob(f);
    fileInput.value = '';
  });
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = e.dataTransfer?.files?.[0];
    if (f) loadBlob(f);
  });
  window.addEventListener('paste', (e) => {
    if ($('tab-read').hidden) return;
    const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
    const f = item?.getAsFile();
    if (f) {
      e.preventDefault();
      loadBlob(f);
    }
  });

  candSel.addEventListener('change', () => select(attempts[Number(candSel.value)] ?? null));
  $('r-unmasked').addEventListener('change', drawMatrix);
  const ovBox = $('r-overlay');
  ovBox.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    overlay = b.dataset.v!;
    ovBox.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    drawMatrix();
  });

  // Text grid input
  $('grid-decode').addEventListener('click', () => {
    const lines = $<HTMLTextAreaElement>('grid-input')
      .value.split(/\r?\n/)
      .map((l) => l.replace(/\s+$/, ''))
      .filter((l) => l.length > 0);
    const rows = lines.map((l) => [...l].filter((c) => c !== ' ' || l.length > lines.length).map((c) => /[1#█Xx■]/.test(c)));
    const size = rows.length;
    if (!size || rows.some((r) => r.length !== size)) {
      details.replaceChildren(h('div', { class: 'error' }, `正方形になっていません（${size} 行, 各行の長さ: ${[...new Set(rows.map((r) => r.length))].join(', ')}）`));
      return;
    }
    srcImage = null;
    srcCanvas.width = srcCanvas.height = 0;
    const cand: GridCandidate = { grid: { size, get: (x, y) => rows[y][x] }, method: 'テキスト入力' };
    let a: Attempt;
    try {
      a = { cand, result: decodeGrid(cand.grid) };
    } catch (e) {
      a = { cand, error: (e as Error).message };
    }
    attempts = [a];
    $('cand-wrap').hidden = true;
    select(a);
  });

  // Camera
  const video = $<HTMLVideoElement>('video');
  let stream: MediaStream | null = null;
  let camTimer = 0;
  const camCanvas = document.createElement('canvas');
  $('camera-btn').addEventListener('click', async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    } catch (e) {
      details.replaceChildren(h('div', { class: 'error' }, `カメラを開けません: ${(e as Error).message}`));
      return;
    }
    video.srcObject = stream;
    video.hidden = false;
    $('camera-stop').hidden = false;
    $('camera-btn').hidden = true;
    await video.play();
    const tick = () => {
      if (!stream) return;
      if (video.videoWidth) {
        camCanvas.width = video.videoWidth;
        camCanvas.height = video.videoHeight;
        camCanvas.getContext('2d')!.drawImage(video, 0, 0);
        loadImageSource(camCanvas, camCanvas.width, camCanvas.height);
        if (current?.result?.ok) {
          stopCamera();
          return;
        }
      }
      camTimer = window.setTimeout(tick, 300);
    };
    tick();
  });
  function stopCamera(): void {
    clearTimeout(camTimer);
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    video.hidden = true;
    $('camera-stop').hidden = true;
    $('camera-btn').hidden = false;
  }
  $('camera-stop').addEventListener('click', stopCamera);

  return {
    loadCanvas(c) {
      loadImageSource(c, c.width, c.height);
    },
  };
}
