#!/usr/bin/env node
/**
 * Raw spacing-px ratchet for SMRT UI packages.
 *
 * Bans hardcoded `px` values in spacing properties (padding / margin / gap)
 * inside CSS contexts of `.svelte` and `.css` files, steering authors to the
 * centralized `--smrt-spacing-*` 4px-grid scale (issue #1373, parent epic
 * #1354). Policy: SNAP TO GRID — every spacing px should become its nearest
 * `--smrt-spacing-*` token (the migration rounds off-grid values; small <=2px
 * shifts are accepted for grid consistency).
 *
 * For each violation the check prints the suggested token so migration is
 * mechanical.
 *
 * What is allowed (never flagged):
 *   - `var(--smrt-spacing-*, <fallback>)` — already on the scale.
 *   - `0` (unitless), `auto`, `%`, `fr`, `em`/`rem`, negative values, and any
 *     `px` inside `calc(...)` (layout math, not a spacing token candidate).
 *   - `<script>` blocks + markup (only `<style>` is scanned), and comments.
 *
 * Scope is intentionally the spacing box-model properties only — NOT width /
 * height / inset / top-right-bottom-left (layout sizing/position), border-width,
 * border-radius (#1373 radius dimension), or font-size (typography dimension).
 *
 * Phased rollout: `packages/smrt-svelte` (reference library) is ERROR; every
 * other package is REPORT-ONLY (warn) until migrated. Add a package to
 * STRICT_PACKAGES once clean.
 *
 * Run: `node scripts/check-spacing.mjs` or `pnpm check:spacing`.
 * Exit code: 0 if no strict-package violations, 1 otherwise.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PACKAGES = join(ROOT, 'packages');

/** Packages held to ERROR. Everything else is report-only for now (#1373). */
const STRICT_PACKAGES = new Set(['smrt-svelte']);

/** Dev/playground hosts skipped entirely (matches the color/z-index ratchets). */
const SCOPE_EXCLUDED_PACKAGES = new Set(['smrt-playground']);

/**
 * The numeric `--smrt-spacing-*` scale as [px@16root, tokenName]. Gaps above 48
 * (no spacing-13/15/17/18/19/21/22/23) are intentional — snap picks the nearest
 * EXISTING token.
 */
const SPACING_TOKENS = [
  [0, '0'],
  [4, '1'],
  [8, '2'],
  [12, '3'],
  [16, '4'],
  [20, '5'],
  [24, '6'],
  [28, '7'],
  [32, '8'],
  [36, '9'],
  [40, '10'],
  [44, '11'],
  [48, '12'],
  [56, '14'],
  [64, '16'],
  [80, '20'],
  [96, '24'],
];

/** Snap a px value to the nearest spacing token (ties round up; keep tiny gaps). */
function snap(px) {
  let best = SPACING_TOKENS[0];
  let bestDist = Number.POSITIVE_INFINITY;
  for (const [value, name] of SPACING_TOKENS) {
    const dist = Math.abs(value - px);
    if (dist < bestDist || (dist === bestDist && value > best[0])) {
      best = [value, name];
      bestDist = dist;
    }
  }
  // Never collapse a positive gap to 0 — floor at spacing-1 (4px).
  if (px > 0 && best[1] === '0') best = [4, '1'];
  return `var(--smrt-spacing-${best[1]}, ${best[0]}px)`;
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

/** Keep only `<style>` block contents for `.svelte` (blank script + markup). */
function extractStyleBlocks(source) {
  const out = source.replace(/[^\n]/g, ' ').split('');
  const re = /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi;
  for (const m of source.matchAll(re)) {
    const innerStart = m.index + m[1].length;
    const inner = m[2];
    for (let k = 0; k < inner.length; k++) {
      out[innerStart + k] = inner[k];
    }
  }
  return out.join('');
}

/** Blank CSS block/line comments (newlines preserved). */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead) =>
      lead + ' '.repeat(m.length - lead.length),
    );
}

/** Blank `var(...)` and `calc(...)` calls so px inside them is never flagged. */
function stripAllowedCalls(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const isVar = source.startsWith('var(', i);
    const isCalc = source.startsWith('calc(', i);
    if (isVar || isCalc) {
      const start = i + (isVar ? 3 : 4); // index of '('
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

// Spacing box-model properties (NOT width/height/inset/border/font-size).
const SPACING_PROP_RE =
  /\b(?:margin|padding|gap|row-gap|column-gap|(?:margin|padding)-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)\s*:\s*([^;}]+)/gi;
// A positive px value not preceded by a digit/`-`/`.` (so it's a standalone number).
const PX_RE = /(?<![\d.\-])(\d+)px/gi;

/** Collect raw spacing-px violations in a single file's source. */
function findViolations(file, source) {
  let text = file.endsWith('.svelte') ? extractStyleBlocks(source) : source;
  text = stripComments(text);
  text = stripAllowedCalls(text);
  const lines = text.split('\n');
  const hits = [];
  lines.forEach((line, i) => {
    for (const decl of line.matchAll(SPACING_PROP_RE)) {
      const value = decl[1];
      for (const px of value.matchAll(PX_RE)) {
        const n = Number(px[1]);
        if (n <= 0) continue;
        hits.push({
          line: i + 1,
          value: `${px[0]} → ${snap(n)}`,
          snippet: line.trim().slice(0, 100),
        });
      }
    }
  });
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
  if (STRICT_PACKAGES.has(pkg)) {
    strictViolations.push({ file: relPath, hits });
  } else {
    reportOnly.set(pkg, (reportOnly.get(pkg) ?? 0) + hits.length);
  }
}

if (reportOnly.size > 0) {
  const total = [...reportOnly.values()].reduce((a, b) => a + b, 0);
  console.warn(
    `⚠ spacing-check: ${total} raw spacing-px value(s) in report-only ` +
      'package(s) (not failing — later phases of #1373):',
  );
  for (const [pkg, count] of [...reportOnly.entries()].sort(
    (a, b) => b[1] - a[1],
  )) {
    console.warn(`    ${pkg}: ${count}`);
  }
}

if (strictViolations.length > 0) {
  const total = strictViolations.reduce((n, v) => n + v.hits.length, 0);
  console.error(
    `\n✗ spacing-check: ${total} raw spacing-px value(s) in strict ` +
      `package(s): ${[...STRICT_PACKAGES].join(', ')}`,
  );
  for (const { file, hits } of strictViolations) {
    console.error(`  ${file}`);
    for (const h of hits) {
      console.error(`    L${h.line}: ${h.value}   | ${h.snippet}`);
    }
  }
  console.error('\nSnap each spacing px to the suggested --smrt-spacing-* token.');
  process.exit(1);
}

console.log(
  `✓ spacing-check: no raw spacing-px in strict package(s): ${[
    ...STRICT_PACKAGES,
  ].join(', ')}`,
);
