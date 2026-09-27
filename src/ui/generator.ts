import { encode, type EncodeOptions, type EncodeResult, type PaddingMode } from '../qr/encoder';
import { autoSegments, parseHex, toHex, type ByteEncoding, type Mode, type SegmentInput } from '../qr/segments';
import { blockInfo, MASK_FORMULAS, type EcLevel } from '../qr/tables';
import { $, badge, card, download, h, kv, seededRandom } from './dom';
import {
  codewordOverlay,
  drawToCanvas,
  KIND_COLORS,
  KIND_LABELS,
  kindOverlay,
  maskOverlay,
  moduleAt,
  REGION_COLORS,
  regionOverlay,
  toSvg,
  type RenderOptions,
} from './render';

const REGION_LABELS: Record<string, string> = {
  mode: 'モード指示子',
  count: '文字数指示子 / ECI',
  data: 'データ',
  terminator: '終端パターン',
  align: 'バイト境界埋め',
  hidden: '終端後データ',
  pad: '埋め草',
  ecc: '誤り訂正コード語',
};

interface ManualSeg {
  mode: Mode;
  text: string;
  encoding: ByteEncoding;
  count: string;
}

export interface GeneratorApi {
  current(): EncodeResult | null;
}

export function unescapeText(s: string): string {
  return s.replace(/\\(x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|[nrt0\\])/g, (_, e: string) => {
    switch (e[0]) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case '0': return '\0';
      case '\\': return '\\';
      case 'x': return String.fromCharCode(parseInt(e.slice(1), 16));
      case 'u': return String.fromCodePoint(parseInt(e.replace(/[u{}]/g, ''), 16));
      default: return e;
    }
  });
}

export function initGenerator(onVerify: (r: EncodeResult) => void): GeneratorApi {
  const canvas = $<HTMLCanvasElement>('gen-canvas');
  const errBox = $('gen-error');
  const warnList = $('gen-warnings');
  const details = $('gen-details');
  const legend = $('legend');

  const versionSel = $<HTMLSelectElement>('version');
  versionSel.append(h('option', { value: 'auto' }, '自動'));
  for (let v = 1; v <= 40; v++) versionSel.append(h('option', { value: v }, `${v} (${v * 4 + 17}×${v * 4 + 17})`));

  const manualSegs: ManualSeg[] = [
    { mode: 'alphanumeric', text: 'HELLO', encoding: 'utf-8', count: '' },
    { mode: 'byte', text: ' 世界', encoding: 'utf-8', count: '' },
  ];
  const flips = new Set<string>();
  let seed = 12345;
  let overlay = 'none';
  let result: EncodeResult | null = null;
  let renderOpts: RenderOptions = { scale: 8, quiet: 4, fg: '#000', bg: '#fff' };

  const val = (id: string) => $<HTMLInputElement>(id).value;
  const checked = (id: string) => $<HTMLInputElement>(id).checked;
  const radio = (name: string) => (document.querySelector(`input[name="${name}"]:checked`) as HTMLInputElement).value;

  // ---- manual segment editor ----
  const segBox = $('segments');
  function renderSegEditor(): void {
    segBox.replaceChildren(
      ...manualSegs.map((s, i) => {
        const modeSel = h(
          'select',
          { 'aria-label': 'モード' },
          (['numeric', 'alphanumeric', 'byte', 'kanji', 'eci'] as Mode[]).map((m) =>
            h('option', { value: m, selected: m === s.mode }, { numeric: '数字', alphanumeric: '英数字', byte: 'バイト', kanji: '漢字', eci: 'ECI' }[m]),
          ),
        );
        modeSel.addEventListener('change', () => {
          s.mode = modeSel.value as Mode;
          renderSegEditor();
          update();
        });
        const text = h('input', { type: 'text', value: s.text, spellcheck: 'false', placeholder: s.mode === 'eci' ? 'ECI 番号 (例: 26)' : 'データ' });
        text.addEventListener('input', () => {
          s.text = text.value;
          update();
        });
        const enc = h(
          'select',
          { 'aria-label': '文字コード', hidden: s.mode !== 'byte' },
          (['utf-8', 'shift_jis', 'iso-8859-1', 'hex'] as ByteEncoding[]).map((e) => h('option', { value: e, selected: e === s.encoding }, e === 'hex' ? '16進' : e)),
        );
        enc.addEventListener('change', () => {
          s.encoding = enc.value as ByteEncoding;
          update();
        });
        const count = h('input', { type: 'number', min: 0, value: s.count, placeholder: '文字数上書き', title: '文字数指示子を上書き (不正なコードのテスト用)', hidden: s.mode === 'eci' });
        count.addEventListener('input', () => {
          s.count = count.value;
          update();
        });
        const up = h('button', { class: 'small ghost', title: '上へ', disabled: i === 0 }, '↑');
        up.addEventListener('click', () => {
          [manualSegs[i - 1], manualSegs[i]] = [manualSegs[i], manualSegs[i - 1]];
          renderSegEditor();
          update();
        });
        const del = h('button', { class: 'small ghost', title: '削除' }, '✕');
        del.addEventListener('click', () => {
          manualSegs.splice(i, 1);
          renderSegEditor();
          update();
        });
        return h('div', { class: 'seg-row' }, h('span', { class: 'seg-idx' }, `#${i + 1}`), modeSel, text, enc, count, up, del);
      }),
    );
  }
  renderSegEditor();
  $('add-seg').addEventListener('click', () => {
    manualSegs.push({ mode: 'byte', text: '', encoding: 'utf-8', count: '' });
    renderSegEditor();
    update();
  });

  // ---- option collection ----
  function collect(): EncodeOptions {
    let segments: SegmentInput[];
    if (radio('seg-mode') === 'auto') {
      let text = val('text');
      if (checked('unescape')) text = unescapeText(text);
      const encSel = val('auto-encoding') as ByteEncoding;
      segments = encSel === 'hex' ? [{ mode: 'byte', text, encoding: 'hex' }] : autoSegments(text, encSel);
      const eci = val('auto-eci');
      if (eci) segments.unshift({ mode: 'eci', text: eci });
    } else {
      segments = manualSegs.map((s) => ({
        mode: s.mode,
        text: s.mode === 'byte' && s.encoding !== 'hex' && checked('unescape') ? unescapeText(s.text) : s.text,
        encoding: s.encoding,
        countOverride: s.count === '' ? undefined : Number(s.count),
      }));
    }
    const maskV = val('mask');
    const verV = val('version');
    const hiddenText = val('hidden-data');
    const hiddenEnc = radio('hidden-enc');
    const fo = val('format-override').trim();
    let formatBitsOverride: number | undefined;
    if (fo) {
      formatBitsOverride = fo.startsWith('0x') ? parseInt(fo, 16) : parseInt(fo.replace(/\s/g, ''), 2);
      if (Number.isNaN(formatBitsOverride) || formatBitsOverride >= 1 << 15) throw new Error('形式情報は 15bit の2進数か 0x 付き16進数で指定してください');
    }
    const raw = val('raw-data').trim();
    const corrupt = val('corrupt-cw')
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isInteger(n));
    return {
      segments,
      ec: val('ec') as EcLevel,
      boostEc: checked('boost-ec'),
      version: verV === 'auto' ? 'auto' : Number(verV),
      minVersion: Math.min(40, Math.max(1, Number(val('min-version')) || 1)),
      mask: maskV === 'auto' ? 'auto' : maskV === 'none' ? 'none' : Number(maskV),
      maskFormatAs: Number(val('mask-format-as')) & 7,
      terminatorBits: val('terminator') === 'auto' ? 'auto' : Number(val('terminator')),
      padding: val('padding') as PaddingMode,
      customPad: val('padding') === 'custom' ? parseHex(val('custom-pad')) : undefined,
      hiddenData: hiddenText ? (hiddenEnc === 'hex' ? parseHex(hiddenText) : new TextEncoder().encode(hiddenText)) : undefined,
      rawDataCodewords: raw ? parseHex(raw) : undefined,
      formatBitsOverride,
      corruptCodewords: corrupt,
    };
  }

  function randomFlips(r: EncodeResult): [number, number][] {
    const n = Number(val('random-flips')) || 0;
    if (n <= 0) return [];
    const rnd = seededRandom(seed);
    const out: [number, number][] = [];
    const used = new Set<number>();
    const order = r.matrix.dataModuleOrder();
    while (out.length < Math.min(n, order.length)) {
      const i = Math.floor(rnd() * order.length);
      if (used.has(i)) continue;
      used.add(i);
      out.push(order[i]);
    }
    return out;
  }

  // ---- main update ----
  let timer = 0;
  function update(): void {
    clearTimeout(timer);
    timer = window.setTimeout(run, 30);
  }

  function run(): void {
    $('mask-format-as-wrap').hidden = val('mask') !== 'none';
    $('custom-pad-wrap').hidden = val('padding') !== 'custom';
    $('auto-input').hidden = radio('seg-mode') !== 'auto';
    $('manual-input').hidden = radio('seg-mode') !== 'manual';
    try {
      const opts = collect();
      let r = encode(opts);
      const rf = randomFlips(r);
      const manual = [...flips].map((k) => k.split(',').map(Number) as [number, number]);
      if (rf.length || manual.length) r = encode({ ...opts, version: r.version, ec: r.ec, boostEc: false, mask: opts.mask === 'auto' ? r.mask : opts.mask, flips: [...rf, ...manual] });
      result = r;
      errBox.hidden = true;
      warnList.replaceChildren(...r.warnings.map((w) => h('li', null, w)));
      draw();
      renderDetails(r, opts);
    } catch (e) {
      errBox.hidden = false;
      errBox.textContent = (e as Error).message;
    }
    $('flip-count').textContent = String(flips.size);
  }

  function draw(): void {
    if (!result) return;
    const r = result;
    renderOpts = {
      scale: Math.max(1, Math.min(40, Number(val('scale')) || 8)),
      quiet: Math.max(0, Number(val('quiet')) || 0),
      fg: val('fg'),
      bg: val('bg'),
      gridLines: checked('grid-lines'),
    };
    let ov: (string | null)[] | undefined;
    let legendItems: [string, string][] = [];
    if (overlay === 'kind') {
      ov = kindOverlay(r.matrix);
      legendItems = (Object.keys(KIND_COLORS) as (keyof typeof KIND_COLORS)[]).filter((k) => KIND_COLORS[k]).map((k) => [KIND_COLORS[k], KIND_LABELS[k]]);
    } else if (overlay === 'region') {
      ov = regionOverlay(r.matrix, r.ec, r.bitBuffer.spans);
      const kinds = new Set(r.bitBuffer.spans.map((s) => s.kind));
      kinds.add('ecc');
      legendItems = [...kinds].map((k) => [REGION_COLORS[k], REGION_LABELS[k] ?? k]);
    } else if (overlay === 'codeword') {
      ov = codewordOverlay(r.matrix, r.ec);
      legendItems = [['hsl(0 85% 60%)', 'データ (ブロック毎に色分け)'], ['hsl(0 45% 34%)', '誤り訂正 (濃色)']];
    } else if (overlay === 'mask') {
      ov = maskOverlay(r.matrix, r.mask);
      legendItems = [['#ffb224', `マスク ${r.mask} で反転されるモジュール`]];
    }
    const highlight = new Set([...flips].map((k) => {
      const [x, y] = k.split(',').map(Number);
      return y * r.size + x;
    }));
    // Export-quality draw uses no overlay; the preview canvas shows it.
    drawToCanvas(canvas, r.matrix, { ...renderOpts, overlay: ov, highlight });
    legend.replaceChildren(...legendItems.map(([c, l]) => h('span', null, h('i', { style: `background:${c}` }), l)));
  }

  function renderDetails(r: EncodeResult, opts: EncodeOptions): void {
    const info = blockInfo(r.version, r.ec);
    const usedBits = r.segmentBits;
    const pct = (usedBits / r.capacityBits) * 100;
    const summary = card(
      '概要',
      kv([
        ['バージョン', `${r.version} (${r.size}×${r.size})`],
        ['誤り訂正', `${r.ec}${r.ec !== opts.ec ? `（${opts.ec} から引き上げ）` : ''}`],
        ['マスク', r.maskApplied ? `${r.mask}: ${MASK_FORMULAS[r.mask]}` : `未適用（形式情報上は ${r.mask}）`],
        ['データ容量', h('span', null, `${usedBits} / ${r.capacityBits} bit (${pct.toFixed(1)}%)`, h('div', { class: 'meter' }, h('i', { style: `width:${Math.min(100, pct)}%` })))],
        ['コード語', `全 ${info.totalCodewords} = データ ${info.dataCodewords} + EC ${info.eccPerBlock * info.numBlocks}`],
        ['ブロック構成', `${info.numBlocks} ブロック（${info.numShortBlocks}×${info.shortBlockDataLen}${info.numBlocks > info.numShortBlocks ? ` + ${info.numBlocks - info.numShortBlocks}×${info.shortBlockDataLen + 1}` : ''} データ）、各 EC ${info.eccPerBlock}`],
        ['終端 / 埋め草', `${r.terminatorBits} bit / ${r.padBytes} B${r.hiddenBytes ? `（終端後データ ${r.hiddenBytes} B）` : ''}`],
        ['形式情報', h('code', null, r.formatBits.toString(2).padStart(15, '0'))],
        ['型番情報', r.versionBits === null ? '— (v7 未満)' : h('code', null, r.versionBits.toString(2).padStart(18, '0'))],
      ]),
    );

    const best = r.penalties.reduce((b, p, i) => (p.total < r.penalties[b].total ? i : b), 0);
    const penaltyTable = card(
      'マスク評価（クリックで選択）',
      h(
        'table',
        { class: 'tbl clickable' },
        h('thead', null, h('tr', null, ['マスク', 'N1', 'N2', 'N3', 'N4', '合計'].map((t) => h('th', null, t)))),
        h(
          'tbody',
          null,
          r.penalties.map((p, i) => {
            const tr = h(
              'tr',
              { class: [i === r.mask ? 'sel' : '', i === best ? 'best' : ''].join(' ') },
              h('td', null, `${i}${i === best ? ' ★' : ''}`),
              h('td', null, p.n1),
              h('td', null, p.n2),
              h('td', null, p.n3),
              h('td', null, p.n4),
              h('td', null, h('b', null, p.total)),
            );
            tr.addEventListener('click', () => {
              $<HTMLSelectElement>('mask').value = String(i);
              update();
            });
            return tr;
          }),
        ),
      ),
    );

    const bits = r.bitBuffer.bits;
    const spans = r.bitBuffer.spans.filter((s) => s.length > 0);
    const bitCard = card(
      'ビット列',
      h(
        'div',
        { class: 'bitstream' },
        spans.map((s) => {
          const str = bits.slice(s.start, s.start + s.length).join('');
          const shown = str.length > 96 ? `${str.slice(0, 96)}… (${str.length} bit)` : str;
          return h(
            'div',
            { class: 'bitspan' },
            h('i', { style: `background:${REGION_COLORS[s.kind] ?? REGION_COLORS.data}` }),
            h('span', { class: 'lbl' }, s.label),
            h('span', { class: 'pos' }, `@${s.start}+${s.length}`),
            h('code', null, shown),
          );
        }),
      ),
    );

    const cwCard = card(
      'コード語',
      h('h4', null, 'データコード語（RS 前）'),
      h('pre', { class: 'hex' }, toHex(r.dataCodewords)),
      r.blocks.map((b, i) =>
        h('div', { class: 'block' }, h('h4', null, `ブロック ${i + 1}`), h('pre', { class: 'hex' }, h('span', { class: 'd' }, toHex(b.data)), '\n', h('span', { class: 'e' }, toHex(b.ecc)))),
      ),
      h('h4', null, '最終コード語列（インターリーブ後）'),
      h('pre', { class: 'hex' }, toHex(r.finalCodewords)),
    );
    const badges = h(
      'div',
      { class: 'badges' },
      r.hiddenBytes ? badge(`終端後データ ${r.hiddenBytes}B`, 'warn') : null,
      opts.padding && opts.padding !== 'standard' ? badge('非標準の埋め草', 'warn') : null,
      !r.maskApplied ? badge('マスクなし', 'bad') : null,
      opts.formatBitsOverride !== undefined ? badge('形式情報上書き', 'bad') : null,
      opts.rawDataCodewords ? badge('生データ', 'info') : null,
    );
    details.replaceChildren(badges, summary, penaltyTable, bitCard, cwCard);
  }

  // ---- events ----
  document.querySelectorAll('#tab-gen .controls input, #tab-gen .controls select, #tab-gen .controls textarea, #grid-lines').forEach((el) => {
    el.addEventListener('input', update);
    el.addEventListener('change', update);
  });
  const ovBox = $('overlay');
  ovBox.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    overlay = b.dataset.v!;
    ovBox.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    draw();
  });
  canvas.addEventListener('click', (ev) => {
    if (!result) return;
    const p = moduleAt(canvas, ev, result.size, renderOpts);
    if (!p) return;
    const key = `${p[0]},${p[1]}`;
    if (flips.has(key)) flips.delete(key);
    else flips.add(key);
    run();
  });
  $('clear-flips').addEventListener('click', () => {
    flips.clear();
    run();
  });
  $('reseed').addEventListener('click', () => {
    seed = (Math.random() * 2 ** 32) >>> 0;
    run();
  });

  const exportCanvas = (): HTMLCanvasElement => {
    const c = document.createElement('canvas');
    drawToCanvas(c, result!.matrix, { ...renderOpts, overlay: undefined, highlight: undefined, gridLines: false });
    return c;
  };
  const fileBase = () => `qr-v${result!.version}-${result!.ec}-m${result!.mask}`;
  $('dl-png').addEventListener('click', () => {
    if (!result) return;
    exportCanvas().toBlob((b) => b && download(`${fileBase()}.png`, b));
  });
  $('dl-svg').addEventListener('click', () => {
    if (!result) return;
    download(`${fileBase()}.svg`, new Blob([toSvg(result.matrix, renderOpts)], { type: 'image/svg+xml' }));
  });
  $('copy-png').addEventListener('click', async (ev) => {
    if (!result) return;
    const btn = ev.currentTarget as HTMLButtonElement;
    try {
      const blob = await new Promise<Blob>((res, rej) => exportCanvas().toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed')))));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      flash(btn, 'コピーしました');
    } catch {
      flash(btn, 'コピー失敗');
    }
  });
  $('copy-ascii').addEventListener('click', async (ev) => {
    if (!result) return;
    const m = result.matrix;
    const lines: string[] = [];
    for (let y = 0; y < m.size; y++) {
      let s = '';
      for (let x = 0; x < m.size; x++) s += m.get(x, y) ? '#' : '.';
      lines.push(s);
    }
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      flash(ev.currentTarget as HTMLButtonElement, 'コピーしました');
    } catch {
      flash(ev.currentTarget as HTMLButtonElement, 'コピー失敗');
    }
  });
  $('to-reader').addEventListener('click', () => result && onVerify(result));

  run();
  return { current: () => result };
}

function flash(btn: HTMLButtonElement, msg: string): void {
  const orig = btn.textContent;
  btn.textContent = msg;
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = orig;
    btn.disabled = false;
  }, 1200);
}
