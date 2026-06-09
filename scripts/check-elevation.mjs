#!/usr/bin/env node
/**
 * Raw box-shadow (elevation) ratchet for SMRT UI packages.
 *
 * Bans hardcoded DROP-SHADOW box-shadows inside CSS contexts of `.svelte`/`.css`
 * files, steering authors to the `--smrt-elevation-{1..5}` depth scale (issue
 * #1373, parent epic #1354). Policy: map each drop-shadow to its nearest
 * elevation level (by depth), preserving the original as the var() fallback.
 *
 * IMPORTANT — only standard downward, neutral depth shadows are flagged. The
 * `--smrt-elevation-*` scale is downward-only (zero X offset, positive Y) and
 * neutral-colored, so the following are legitimately bespoke and NOT flagged:
 *   - Focus rings (`0 0 0 Npx <color>` — zero blur): a focus indicator, not
 *     elevation. These belong to the color/focus surface, not the depth scale.
 *   - `inset` shadows (inner borders/grooves) — not elevation.
 *   - Directional shadows: nonzero X offset (e.g. a `-24px 0 40px` drawer cast)
 *     or non-positive Y offset (e.g. a `0 -2px 12px` upward toast cast) — these
 *     cast sideways/upward and cannot map to the downward scale.
 *   - Accent-colored glows (e.g. `... --smrt-color-primary 40%`): a brand-tinted
 *     hover effect, a different design intent than neutral depth.
 *   - `box-shadow: none`, and values already using `var(--smrt-elevation-*)`.
 *
 * For each violation the check prints the suggested level so migration is
 * mechanical: `box-shadow: var(--smrt-elevation-<n>, <original>)`.
 *
 * Phased rollout: strict (ERROR) for STRICT_PACKAGES; report-only elsewhere.
 * Run: `node scripts/check-elevation.mjs` or `pnpm check:elevation`.  Exit 0/1.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PACKAGES = join(ROOT, 'packages');

/** Packages held to ERROR. Everything else is report-only for now (#1373). */
const STRICT_PACKAGES = new Set([
  'smrt-svelte',
  'content',
  'products',
  'assets',
  'chat',
  'images',
  'users',
  'subscriptions',
  'projects',
  'messages',
  'agents',
]);

/** Dev/playground hosts skipped entirely (matches the other token ratchets). */
const SCOPE_EXCLUDED_PACKAGES = new Set(['smrt-playground']);

/** Map a drop-shadow value to var(--smrt-elevation-<n>, <original>) by depth. */
function snap(value) {
  const v = value.trim();
  const pxs = [...v.matchAll(/(\d+)px/g)].map((m) => Number(m[1]));
  const max = pxs.length ? Math.max(...pxs) : 0;
  let lvl;
  if (max <= 3) lvl = 1;
  else if (max <= 6) lvl = 2;
  else if (max <= 12) lvl = 3;
  else if (max <= 24) lvl = 4;
  else lvl = 5;
  return `var(--smrt-elevation-${lvl}, ${v})`;
}

/** Parse a CSS length token (`0`, `12px`, `-2px`) to a number; NaN if unknown. */
function lengthToPx(token) {
  if (/^0(?:px)?$/.test(token)) return 0;
  const m = token.match(/^(-?\d+)px$/);
  return m ? Number(m[1]) : Number.NaN;
}

/** Accent/brand color roles — a tinted glow, not neutral depth. */
const ACCENT_COLOR_RE =
  /--smrt-color-(?:primary|secondary|tertiary|accent|error|danger|success|warning|info)\b/;

/**
 * True iff `value` is a standard downward, neutral elevation drop-shadow that
 * maps onto the `--smrt-elevation-*` scale. Excludes focus rings, insets,
 * already-tokenized values, directional casts, and accent-colored glows.
 */
function isDropShadow(value) {
  const v = value.trim();
  if (/^none$/i.test(v)) return false;
  if (/^inset\b/i.test(v)) return false;
  if (/var\(\s*--smrt-elevation-/.test(v)) return false;
  if (ACCENT_COLOR_RE.test(v)) return false; // brand-tinted glow, not depth
  // First layer: offsetX offsetY blur [spread] color.
  const m = v.match(/^(0|-?\d+px)\s+(0|-?\d+px)\s+(0|\d+px)/);
  if (!m) return false; // not a plain shadow (e.g. a bare var()/keyword)
  const x = lengthToPx(m[1]);
  const y = lengthToPx(m[2]);
  const blur = lengthToPx(m[3]);
  if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(blur)) return false;
  if (x !== 0) return false; // directional (sideways cast) — not the scale
  if (y <= 0) return false; // upward/flat cast — not downward depth
  return blur > 0; // blur > 0 → real downward drop shadow
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

const SHADOW_RE = /box-shadow\s*:\s*([^;}]+)/gi;

function findViolations(file, source) {
  let text = file.endsWith('.svelte') ? extractStyleBlocks(source) : source;
  text = stripComments(text);
  const hits = [];
  for (const m of text.matchAll(SHADOW_RE)) {
    const value = m[1].replace(/\s+/g, ' ').trim();
    if (!isDropShadow(value)) continue;
    const line = text.slice(0, m.index).split('\n').length;
    hits.push({
      line,
      value: `${value.slice(0, 60)} → ${snap(value).split(',')[0]}, …)`,
      snippet: value.slice(0, 90),
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
  const hits = findViolations(file, readFileSync(file, 'utf8'));
  if (hits.length === 0) continue;
  if (STRICT_PACKAGES.has(pkg)) strictViolations.push({ file: relPath, hits });
  else reportOnly.set(pkg, (reportOnly.get(pkg) ?? 0) + hits.length);
}

if (reportOnly.size > 0) {
  const total = [...reportOnly.values()].reduce((a, b) => a + b, 0);
  console.warn(
    `⚠ elevation-check: ${total} raw drop-shadow(s) in report-only ` +
      'package(s) (not failing — later phases of #1373):',
  );
  for (const [pkg, count] of [...reportOnly.entries()].sort((a, b) => b[1] - a[1])) {
    console.warn(`    ${pkg}: ${count}`);
  }
}

if (strictViolations.length > 0) {
  const total = strictViolations.reduce((n, v) => n + v.hits.length, 0);
  console.error(
    `\n✗ elevation-check: ${total} raw drop-shadow(s) in strict ` +
      `package(s): ${[...STRICT_PACKAGES].join(', ')}`,
  );
  for (const { file, hits } of strictViolations) {
    console.error(`  ${file}`);
    for (const h of hits) console.error(`    L${h.line}: ${h.value}`);
  }
  console.error(
    '\nMap drop-shadows to var(--smrt-elevation-<n>, <original>) by depth.',
  );
  console.error('Focus rings (0 0 0 Npx) and inset shadows are not elevation.');
  process.exit(1);
}

console.log(
  `✓ elevation-check: no raw drop-shadows in strict package(s): ${[
    ...STRICT_PACKAGES,
  ].join(', ')}`,
);
