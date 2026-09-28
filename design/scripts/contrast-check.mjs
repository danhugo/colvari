// WCAG contrast audit for design/tokens.css (t_c42012a8).
// Parses the light (:root) and dark ([data-theme="dark"]) scopes, resolves
// var() chains and color-mix(..., transparent) composited over a background,
// then checks a declared pair matrix: text >= 4.5:1, non-text >= 3:1.
// Usage: node design/scripts/contrast-check.mjs [--md]
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.join(__dirname, '..', 'tokens.css'), 'utf8');

function scope(block) {
  const map = {};
  for (const m of block.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) map[m[1]] = m[2].trim();
  return map;
}
const lightBlock = css.slice(0, css.indexOf('[data-theme="dark"] {'));
const darkBlock = css.slice(css.indexOf('[data-theme="dark"] {'));
const scopes = { light: scope(lightBlock), dark: scope(darkBlock) };

function parseColour(str) {
  str = str.trim();
  if (str === 'white') return [255, 255, 255];
  if (str === 'black') return [0, 0, 0];
  let m = str.match(/^#([0-9a-f]{6})$/i);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
  m = str.match(/^#([0-9a-f]{3})$/i);
  if (m) return m[1].split('').map((c) => parseInt(c + c, 16));
  m = str.match(/^rgba?\(([^)]+)\)$/i);
  if (m) return m[1].split(',').slice(0, 3).map((n) => parseFloat(n));
  return null;
}

function resolve(name, scopeName) {
  let v = scopes[scopeName][name] ?? scopes.light[name]; // custom props cascade: dark inherits :root
  if (v === undefined) throw new Error(`--${name} missing in ${scopeName}`);
  const ref = v.match(/^var\(--([\w-]+)\)$/);
  if (ref) return resolve(ref[1], scopeName);
  return v;
}

// "color-mix(in srgb, var(--x) 40%, transparent)" composited over bg
function composite(value, bg, scopeName) {
  const mix = value.match(/color-mix\(in srgb,\s*var\(--([\w-]+)\)\s*(\d+)%,\s*transparent\)/);
  if (mix) {
    const c = parseColour(resolve(mix[1], scopeName));
    const bgc = parseColour(bg);
    const p = parseInt(mix[2]) / 100;
    return `rgb(${c.map((ch, i) => Math.round(ch * p + bgc[i] * (1 - p))).join(',')})`;
  }
  return value;
}

function lum(rgb) {
  const [r, g, b] = rgb.map((c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function ratio(fg, bg) {
  const l1 = lum(parseColour(fg));
  const l2 = lum(parseColour(bg));
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
function pair(fgVar, bgVar, scopeName) {
  const bg = resolve(bgVar, scopeName);
  let fgRaw;
  try { fgRaw = resolve(fgVar, scopeName); } catch { fgRaw = fgVar; } // literals like 'white' allowed
  const fg = composite(fgRaw, bg, scopeName);
  if (!parseColour(fg) || !parseColour(bg)) throw new Error(`unparseable pair --${fgVar}=${JSON.stringify(fg)} on --${bgVar}=${JSON.stringify(bg)} (${scopeName})`);
  return { fg, bg, r: ratio(fg, bg) };
}

// ---- pair matrix -----------------------------------------------------------
// [kind, fgVar, bgVar, label]
const AGENTS = [1, 2, 3, 4, 5, 6, 7, 8];
function matrix() {
  const rows = [
    ['text', 'fg-primary', 'bg-app', 'body text / chat bg'],
    ['text', 'fg-primary', 'bg-surface', 'body text / cards, surface'],
    ['text', 'fg-secondary', 'bg-app', 'secondary text / chat bg'],
    ['text', 'fg-secondary', 'bg-sidebar', 'sidebar item labels'],
    ['text', 'fg-secondary', 'bg-surface', 'secondary text / surface'],
    ['text', 'fg-secondary', 'bg-code', 'tool chip text'],
    ['text', 'fg-muted', 'bg-app', 'timestamps, hint / chat bg'],
    ['text', 'fg-muted', 'bg-sidebar', 'status text ("working / idle")'],
    ['text', 'fg-muted', 'bg-surface', 'muted text / surface'],
    ['text', 'fg-muted', 'bg-hover', 'role chip text'],
    ['text', 'fg-on-accent', 'accent', 'white on accent (send, badge)'],
    ['text', 'fg-on-accent', 'accent-text', 'YOU tag'],
    ['text', 'accent-text', 'accent-soft', '@mention chip, in-progress chip'],
    ['text', 'accent-text', 'bg-surface', 'human name on surface'],
    ['text', 'success-text', 'success-soft', 'done chip'],
    ['text', 'success-text', 'bg-code', 'tool ✓'],
    ['text', 'warning-text', 'warning-soft', 'review chip, "Your turn" bar'],
    ['text', 'warning-text', 'bg-app', 'needs-you ref in feed'],
    ['text', 'warning-text', 'bg-sidebar', '"needs you" in sidebar'],
    ['text', 'fg-on-accent', 'warning-strong', 'inbox badge "1", turn counter'],
  ];
  for (const n of AGENTS) rows.push(['text', `agent-${n}-text`, 'bg-app', `agent ${n} name / chat bg`]);
  for (const n of AGENTS) rows.push(['text', `agent-${n}-text`, 'bg-surface', `agent ${n} name / surface`]);
  rows.push(['non-text', 'edge', 'bg-app', 'graph edges']);
  rows.push(['non-text', 'accent', 'bg-surface', 'accent button on surface']);
  rows.push(['non-text', 'success', 'bg-sidebar', 'working dot on sidebar']);
  rows.push(['non-text', 'warning-strong', 'bg-sidebar', '"!" dot on sidebar']);
  for (const n of AGENTS) rows.push(['non-text', `agent-${n}-text`, 'bg-hover', `agent ${n} progress fill`]);
  return rows;
}

// pre-fix values from critique.md (light only — dark already passed);
// agent names used the bright avatar colours before the -text variants existed
const BEFORE = {
  light: {
    'fg-muted': '#7d8394', 'accent-text': '#4f5bff', 'success-text': '#12a150',
    'warning-text': '#d98a00', 'warning-strong': '#d98a00',
    ...Object.fromEntries(AGENTS.map((n) => [`agent-${n}-text`, resolve(`agent-${n}`, 'light')])),
  },
};

const md = process.argv.includes('--md');
let fails = 0;
const lines = [];
for (const theme of ['light', 'dark']) {
  lines.push(`\n### ${theme}\n`);
  lines.push(md ? '| Pair (text or UI indicator) | Before | After | AA |' : 'Pair'.padEnd(38) + 'before -> after (ratio)');
  if (md) lines.push('|---|---|---|---|');
  for (const [kind, fgv, bgv, label] of matrix()) {
    const after = pair(fgv, bgv, theme);
    const need = kind === 'text' ? 4.5 : 3;
    const beforeRaw = BEFORE[theme]?.[fgv];
    const before = beforeRaw ? ratio(composite(beforeRaw, resolve(bgv, theme), theme), resolve(bgv, theme)) : null;
    const ok = after.r >= need;
    if (!ok) fails++;
    const name = `${label} (${theme})`;
    if (md) {
      lines.push(`| ${label} | ${before ? before.toFixed(2) + ':1' : '—'} | ${after.r.toFixed(2)}:1 | ${ok ? 'PASS' : '**FAIL**'} |`);
    } else {
      lines.push(`${name.padEnd(44)} ${before ? before.toFixed(2) : ' --'} -> ${after.r.toFixed(2)} (need ${need}) ${ok ? 'PASS' : 'FAIL  <-- ' + after.fg + ' on ' + after.bg}`);
    }
  }
}
console.log(lines.join('\n'));
if (fails) { console.error(`\n${fails} failing pair(s)`); process.exit(1); }
console.error('\nAll pairs pass');
