#!/usr/bin/env node
/**
 * Raw border-radius ratchet for SMRT UI packages.
 *
 * Bans hardcoded `px`/`%` values in `border-radius` (and its longhands) inside
 * CSS contexts of `.svelte` and `.css` files, steering authors to the named
 * `--smrt-radius-*` scale (issue #1373, parent epic #1354). Policy: SNAP TO
 * SCALE — every radius maps to its nearest `--smrt-radius-*` token. Pill/circle
 * values (`%`, or large px like `999px`/`9999px`) map to `--smrt-radius-full`.
 *
 * Scale (px @16px root): none=0, sm=4, md=8, lg=12, xl=16, 2xl=24, 3xl=32,
 * full=9999 (pill/circle). For each violation the check prints the suggested
 * token so migration is mechanical.
 *
 * Allowed (never flagged): `var(--smrt-radius-*, <fallback>)`, `0` (unitless),
 * any value inside `calc(...)`, and `<script>`/markup/comments.
 *
 * Phased rollout: strict (ERROR) for STRICT_PACKAGES; report-only elsewhere.
 * Run: `node scripts/check-radius.mjs` or `pnpm check:radius`.  Exit 0/1.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PACKAGES = join(ROOT, 'packages');

/** Packages held to ERROR. Everything else is report-only for now (#1373). */
const STRICT_PACKAGES = new Set([
  'smrt-svelte',
  'content',
  'messages',
  'products',
  'images',
  'chat',
  'assets',
  'users',
  'tenancy',
  'social',
  'analytics',
  'subscriptions',
  'events',
  'agents',
]);

/** Dev/playground hosts skipped entirely (matches the other token ratchets). */
const SCOPE_EXCLUDED_PACKAGES = new Set(['smrt-playground']);

/** Named radius scale as [px@16root, name]; `full` handled separately. */
const RADIUS_TOKENS = [
  [0, 'none'],
  [4, 'sm'],
  [8, 'md'],
  [12, 'lg'],
  [16, 'xl'],
  [24, '2xl'],
  [32, '3xl'],
];
/** px at/above this (or any `%`) is a pill/circle → `full`. */
const FULL_THRESHOLD = 40;

/** Snap a radius value (e.g. "8px", "50%", "999px") to a --smrt-radius-* token. */
function snap(raw) {
  if (raw.endsWith('%')) return 'var(--smrt-radius-full, 9999px)';
  const px = Number.parseInt(raw, 10);
  if (px >= FULL_THRESHOLD) return 'var(--smrt-radius-full, 9999px)';
  let best = RADIUS_TOKENS[0];
  let bestDist = Number.POSITIVE_INFINITY;
  for (const [v, n] of RADIUS_TOKENS) {
    const d = Math.abs(v - px);
    if (d < bestDist || (d === bestDist && v > best[0])) {
      best = [v, n];
      bestDist = d;
    }
  }
  if (px > 0 && best[1] === 'none') best = [4, 'sm']; // keep a small radius
  return `var(--smrt-radius-${best[1]}, ${best[0]}px)`;
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

/** Blank `calc(...)` and `var(--smrt-radius-*, ...)`; NOT other var() (bypass). */
function stripAllowedCalls(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const isCalc = source.startsWith('calc(', i);
    const isRadiusVar = /^var\(\s*--smrt-radius-/.test(source.slice(i, i + 22));
    if (isCalc || isRadiusVar) {
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

const RADIUS_PROP_RE =
  /\bborder(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius\s*:\s*([^;}]+)/gi;
const VAL_RE = /(?<![\d.\-])(\d+(?:px)?%?|\d+px)/gi;

function findViolations(file, source) {
  let text = file.endsWith('.svelte') ? extractStyleBlocks(source) : source;
  text = stripComments(text);
  text = stripAllowedCalls(text);
  const lines = text.split('\n');
  const hits = [];
  lines.forEach((line, i) => {
    for (const decl of line.matchAll(RADIUS_PROP_RE)) {
      const value = decl[1];
      for (const v of value.matchAll(/(?<![\d.\-])(\d+)(px|%)/gi)) {
        const n = Number(v[1]);
        if (v[2] === 'px' && n === 0) continue;
        hits.push({
          line: i + 1,
          value: `${v[0]} → ${snap(v[0])}`,
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
  if (STRICT_PACKAGES.has(pkg)) strictViolations.push({ file: relPath, hits });
  else reportOnly.set(pkg, (reportOnly.get(pkg) ?? 0) + hits.length);
}

if (reportOnly.size > 0) {
  const total = [...reportOnly.values()].reduce((a, b) => a + b, 0);
  console.warn(
    `⚠ radius-check: ${total} raw border-radius value(s) in report-only ` +
      'package(s) (not failing — later phases of #1373):',
  );
  for (const [pkg, count] of [...reportOnly.entries()].sort((a, b) => b[1] - a[1])) {
    console.warn(`    ${pkg}: ${count}`);
  }
}

if (strictViolations.length > 0) {
  const total = strictViolations.reduce((n, v) => n + v.hits.length, 0);
  console.error(
    `\n✗ radius-check: ${total} raw border-radius value(s) in strict ` +
      `package(s): ${[...STRICT_PACKAGES].join(', ')}`,
  );
  for (const { file, hits } of strictViolations) {
    console.error(`  ${file}`);
    for (const h of hits) console.error(`    L${h.line}: ${h.value}   | ${h.snippet}`);
  }
  console.error('\nSnap each radius to the suggested --smrt-radius-* token.');
  process.exit(1);
}

console.log(
  `✓ radius-check: no raw border-radius in strict package(s): ${[
    ...STRICT_PACKAGES,
  ].join(', ')}`,
);
