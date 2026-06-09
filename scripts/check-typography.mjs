#!/usr/bin/env node
/**
 * Raw typography ratchet for SMRT UI packages.
 *
 * Bans hardcoded `font-size`, `font-weight`, and `font-family` inside CSS
 * contexts of `.svelte`/`.css` files, steering authors to the Material-3
 * `--smrt-typography-*` role scale (issue #1373, parent epic #1354). Policy
 * (user's call): FULL SEMANTIC PASS — every text element maps to its proper
 * role variant (display/headline/title/body/label × large/medium/small), using
 * the per-variant tokens with the original value preserved as the var()
 * fallback. line-height + letter-spacing are migrated *with* an element's role
 * (its `-line-height`/`-tracking`) but are NOT independently flagged here: raw
 * line-height is frequently a layout reset (`1`, `normal`, `0`) and is
 * ambiguous without an assigned role, so enforcing it standalone is noise.
 *
 * The same size often maps to several roles (e.g. `0.875rem` = title-small AND
 * body-medium AND label-large), so font-size CANNOT be snapped deterministically
 * — the check SUGGESTS the candidate roles and the author picks by semantics.
 * font-weight maps cleanly to `--smrt-typography-weight-{normal|medium|semibold|
 * bold}`; font-family to `--smrt-font-family` (or `-mono`).
 *
 * Allowed (never flagged): `var(--smrt-typography-*)` / `var(--smrt-font-family*)`,
 * the `inherit`/`unset`/`initial` keywords, `font-size` in `em`/`%` (relative,
 * usually icon-sizing) or `0`, and `<script>`/markup/comments.
 *
 * Phased rollout: strict (ERROR) for STRICT_PACKAGES; report-only elsewhere.
 * Run: `node scripts/check-typography.mjs` or `pnpm check:typography`. Exit 0/1.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PACKAGES = join(ROOT, 'packages');

/** Packages held to ERROR. Everything else is report-only for now (#1373). */
const STRICT_PACKAGES = new Set([
  'smrt-svelte',
]);

/** Dev/playground hosts skipped entirely (matches the other token ratchets). */
const SCOPE_EXCLUDED_PACKAGES = new Set(['smrt-playground']);

/** Theme/token source files — they DEFINE the scale, so they emit raw values. */
function isTokenSourceFile(relPath) {
  const p = relPath.split(sep).join('/');
  return (
    p.includes('/src/theme/tokens.') ||
    p.includes('/src/themes/shared.') ||
    p.includes('/src/themes/css-generator.') ||
    p.includes('/src/themes/styles/') ||
    p.includes('/src/themes/create-theme.')
  );
}

const ROOT_PX = 16;

/** Canonical M3 size (rem) → candidate role-size variants (ties are real). */
const SIZE_TO_ROLES = new Map([
  ['3.5rem', ['display-large']],
  ['2.75rem', ['display-medium']],
  ['2.25rem', ['display-small']],
  ['2rem', ['headline-large']],
  ['1.75rem', ['headline-medium']],
  ['1.5rem', ['headline-small']],
  ['1.375rem', ['title-large']],
  ['1rem', ['title-medium', 'body-large']],
  ['0.875rem', ['title-small', 'body-medium', 'label-large']],
  ['0.75rem', ['body-small', 'label-medium']],
  ['0.6875rem', ['label-small']],
]);
/** Numeric rem of each canonical size, for nearest-match on off-scale values. */
const SIZE_REMS = [...SIZE_TO_ROLES.keys()].map((k) => ({
  rem: Number.parseFloat(k),
  key: k,
}));

/** Parse a font-size token to rem (px ÷ 16); null if not an absolute length. */
function fontSizeToRem(token) {
  const t = token.trim();
  let m = t.match(/^(\d*\.?\d+)rem$/i);
  if (m) return Number(m[1]);
  m = t.match(/^(\d*\.?\d+)px$/i);
  if (m) return Number(m[1]) / ROOT_PX;
  return null; // em/%/keyword/0 → not on the absolute rem scale
}

/** Suggest role tokens for a raw font-size. */
function suggestSize(token) {
  const rem = fontSizeToRem(token);
  if (rem === null) return null;
  const key = `${rem}rem`;
  if (SIZE_TO_ROLES.has(key)) {
    const roles = SIZE_TO_ROLES.get(key);
    return `${roles.map((r) => `--smrt-typography-${r}-size`).join(' | ')}`;
  }
  // Off-scale: nearest canonical size, flag as approximate.
  let best = SIZE_REMS[0];
  let bestDist = Number.POSITIVE_INFINITY;
  for (const s of SIZE_REMS) {
    const d = Math.abs(s.rem - rem);
    if (d < bestDist) {
      best = s;
      bestDist = d;
    }
  }
  const roles = SIZE_TO_ROLES.get(best.key);
  return `~${roles.map((r) => `--smrt-typography-${r}-size`).join(' | ')} (nearest ${best.key})`;
}

/** font-weight number/keyword → named weight token. */
function suggestWeight(token) {
  const t = token.trim().toLowerCase();
  const map = { normal: 400, bold: 700, lighter: 300, bolder: 700 };
  const n = t in map ? map[t] : Number.parseInt(t, 10);
  if (Number.isNaN(n)) return null;
  let name;
  if (n <= 400) name = 'normal';
  else if (n <= 500) name = 'medium';
  else if (n <= 600) name = 'semibold';
  else name = 'bold';
  return `--smrt-typography-weight-${name}`;
}

/** font-family → sans or mono token. */
function suggestFamily(token) {
  return /\bmono(space)?\b|"SF Mono"|Consolas|Menlo|Courier/i.test(token)
    ? '--smrt-font-family-mono'
    : '--smrt-font-family';
}

function listFiles(dir, exts) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...listFiles(full, exts));
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

function toPosix(p) {
  return p.split(sep).join('/');
}
function packageNameOf(relPath) {
  return relPath.split(sep)[0];
}
function isInPackageSrc(relPath) {
  const parts = toPosix(relPath).split('/');
  return parts.length > 1 && parts[1] === 'src';
}

function extractStyleBlocks(source) {
  const out = source.replace(/[^\n]/g, ' ').split('');
  const re = /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi;
  for (const m of source.matchAll(re)) {
    const innerStart = m.index + m[1].length;
    const inner = m[2];
    for (let k = 0; k < inner.length; k++) out[innerStart + k] = inner[k];
  }
  return out.join('');
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead) =>
      lead + ' '.repeat(m.length - lead.length),
    );
}

/** Blank `var(--smrt-typography-*)` / `var(--smrt-font-family*)` so they pass. */
function stripTokenVars(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const isTokenVar = /^var\(\s*--smrt-(typography|font-family)/.test(
      source.slice(i, i + 30),
    );
    if (isTokenVar) {
      const start = source.indexOf('(', i);
      let depth = 0;
      let j = start;
      for (; j < source.length; j++) {
        const ch = source[j];
        if (ch === '(') depth++;
        else if (ch === ')') {
          depth--;
          if (depth === 0) {
            j++;
            break;
          }
        }
      }
      out += source.slice(i, j).replace(/[^\n]/g, ' ');
      i = j;
    } else {
      out += source[i];
      i += 1;
    }
  }
  return out;
}

const KEYWORD_VALUES = new Set(['inherit', 'unset', 'initial', 'revert']);

const PROP_RE = /\b(font-size|font-weight|font-family)\s*:\s*([^;}{]+)/gi;

function findViolations(file, source) {
  let text = file.endsWith('.svelte') ? extractStyleBlocks(source) : source;
  text = stripComments(text);
  text = stripTokenVars(text);
  const hits = [];
  for (const m of text.matchAll(PROP_RE)) {
    const prop = m[1].toLowerCase();
    const value = m[2].replace(/\s+/g, ' ').trim();
    if (!value || KEYWORD_VALUES.has(value.toLowerCase())) continue;
    // Anything still containing a token var() was a multi-part value we keep.
    if (/var\(\s*--smrt-(typography|font-family)/.test(value)) continue;
    let suggestion = null;
    if (prop === 'font-size') {
      // skip relative/zero/keyword sizes (em/%/0/larger/smaller)
      if (fontSizeToRem(value) === null) continue;
      suggestion = suggestSize(value);
    } else if (prop === 'font-weight') {
      suggestion = suggestWeight(value);
      if (!suggestion) continue;
    } else if (prop === 'font-family') {
      suggestion = suggestFamily(value);
    }
    const line = text.slice(0, m.index).split('\n').length;
    hits.push({
      line,
      prop,
      value: value.slice(0, 40),
      suggestion,
    });
  }
  return hits;
}

const files = listFiles(PACKAGES, ['.svelte', '.css']);
const strictViolations = [];
const reportOnly = new Map();

for (const file of files) {
  const relPath = relative(PACKAGES, file);
  if (!isInPackageSrc(relPath)) continue;
  const pkg = packageNameOf(relPath);
  if (SCOPE_EXCLUDED_PACKAGES.has(pkg)) continue;
  if (isTokenSourceFile(relPath)) continue;
  const hits = findViolations(file, readFileSync(file, 'utf8'));
  if (hits.length === 0) continue;
  if (STRICT_PACKAGES.has(pkg)) strictViolations.push({ file: relPath, hits });
  else reportOnly.set(pkg, (reportOnly.get(pkg) ?? 0) + hits.length);
}

if (reportOnly.size > 0) {
  const total = [...reportOnly.values()].reduce((a, b) => a + b, 0);
  console.warn(
    `⚠ typography-check: ${total} raw font-size/weight/family value(s) in ` +
      'report-only package(s) (not failing — later phases of #1373):',
  );
  for (const [pkg, count] of [...reportOnly.entries()].sort((a, b) => b[1] - a[1])) {
    console.warn(`    ${pkg}: ${count}`);
  }
}

if (strictViolations.length > 0) {
  const total = strictViolations.reduce((n, v) => n + v.hits.length, 0);
  console.error(
    `\n✗ typography-check: ${total} raw typography value(s) in strict ` +
      `package(s): ${[...STRICT_PACKAGES].join(', ')}`,
  );
  for (const { file, hits } of strictViolations) {
    console.error(`  ${file}`);
    for (const h of hits) {
      console.error(`    L${h.line}: ${h.prop}: ${h.value} → ${h.suggestion}`);
    }
  }
  console.error(
    '\nMap each text element to its M3 role: font-size →' +
      ' var(--smrt-typography-<role>-<size>-size, <orig>), and apply the same' +
      " role's -line-height/-weight/-tracking. font-weight →" +
      ' var(--smrt-typography-weight-<name>, <orig>); font-family →' +
      ' var(--smrt-font-family[-mono], <orig>).',
  );
  process.exit(1);
}

console.log(
  `✓ typography-check: no raw font-size/weight/family in strict package(s): ${[
    ...STRICT_PACKAGES,
  ].join(', ')}`,
);
