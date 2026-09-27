import './style.css';
import { $ } from './ui/dom';
import { initGenerator } from './ui/generator';
import { initReader } from './ui/reader';
import { drawToCanvas } from './ui/render';

function showTab(name: string): void {
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $('tab-gen').hidden = name !== 'gen';
  $('tab-read').hidden = name !== 'read';
  try {
    history.replaceState(null, '', `#${name}`);
  } catch {
    // ignore
  }
}

document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab!)));

// Theme
const root = document.documentElement;
const THEME_KEY = 'qrdev-theme';
try {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved) root.dataset.theme = saved;
} catch {
  // ignore
}
$('theme-toggle').addEventListener('click', () => {
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try {
    localStorage.setItem(THEME_KEY, root.dataset.theme);
  } catch {
    // ignore
  }
});

const reader = initReader();
initGenerator((r) => {
  // Round-trip through a rendered image so the full reader pipeline is exercised.
  const c = document.createElement('canvas');
  drawToCanvas(c, r.matrix, { scale: 8, quiet: 4, fg: '#000', bg: '#fff' });
  showTab('read');
  reader.loadCanvas(c);
});

if (location.hash === '#read') showTab('read');
