#!/usr/bin/env node
/**
 * Converts raw px values in `.svelte` style blocks to spacing and radius tokens
 * where the mapping is exact in every built-in preset (issue #3826).
 *
 * Deliberately narrow — a wrong mapping is a silent visual regression:
 *   - spacing (`padding*`, `margin*`, `gap`, `row-gap`, `column-gap`): 4/8/12/16/20/24/32/40/48px
 *     map to `--smrt-spacing-1/2/3/4/5/6/8/10/12`. The spacing scale is identical
 *     in every preset and is rem-based, so the value is exact at the default
 *     16px root font size.
 *   - radius (`border-radius` and its corner longhands): only 4px -> `--smrt-radius-sm`
 *     and 9999px -> `--smrt-radius-full`. Other radius steps (`md`, `lg`, `xl`, …) differ
 *     between presets (e.g. `md` is 0.375rem in some, 0.5rem in others), so they
 *     are NOT converted and remain allow-listed.
 *   - Everything else (`border`, `box-shadow`, `width`, `height`, `font-size`,
 *     `outline`, …) and any declaration containing `(` or `/` is left unchanged.
 *     Negative values and `0` are left unchanged.
 *
 * Idempotent: converted values are `var(...)`, which no pattern matches again.
 *
 * Usage:
 *   node scripts/codemod-smrt-px-tokens.mjs            # rewrite .svelte style blocks
 *   node scripts/codemod-smrt-px-tokens.mjs --dry-run  # report counts only
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { allPackageSrcDirs, listFiles } from './smrt-token-scan-lib.mjs';

const TEST_FILE = /__tests__|\.(test|spec)\./;
const STYLE_RE = /(<style[^>]*>)([\s\S]*?)(<\/style>)/g;

const SPACING_PX = {
  4: 'spacing-1',
  8: 'spacing-2',
  12: 'spacing-3',
  16: 'spacing-4',
  20: 'spacing-5',
  24: 'spacing-6',
  32: 'spacing-8',
  40: 'spacing-10',
  48: 'spacing-12',
};
const RADIUS_PX = {
  4: 'radius-sm',
  9999: 'radius-full',
};

const SPACING_PROP =
  /(?<![\w-])((?:padding|margin)(?:-(?:top|right|bottom|left|block|block-start|block-end|inline|inline-start|inline-end))?|gap|row-gap|column-gap)\s*:\s*([^;{}]+)/g;
const RADIUS_PROP =
  /(?<![\w-])(border-radius|border-(?:top|bottom)-(?:left|right)-radius|border-(?:start|end)-(?:start|end)-radius)\s*:\s*([^;{}]+)/g;

/** Rewrite one declaration value, token by token. Returns `{ value, count }`. */
function rewriteValue(value, table, counts) {
  // `var(--smrt-x)` segments are fine (no fallback literal left); any other
  // function, a fallback, or a slash-separated radius is not rewritten.
  const probe = value.replace(/var\(--smrt-[\w-]+\)/g, 'V');
  if (probe.includes('(') || probe.includes('/')) return { value, count: 0 };
  let count = 0;
  const out = value.replace(/(?<![\w.-])(\d+)px(?![\w.-])/g, (match, digits) => {
    const token = table[Number(digits)];
    if (!token) return match;
    count++;
    counts[token] = (counts[token] ?? 0) + 1;
    return `var(--smrt-${token})`;
  });
  return { value: out, count };
}

/** Convert one `<style>` block body. */
export function convertStyleBody(css, counts = {}) {
  let total = 0;
  const pass = (re, table) =>
    css.replace(re, (decl, prop, value) => {
      const { value: next, count } = rewriteValue(value, table, counts);
      if (count === 0) return decl;
      total += count;
      return decl.slice(0, decl.length - value.length) + next;
    });
  let out = pass(SPACING_PROP, SPACING_PX);
  out = out.replace(RADIUS_PROP, (decl, prop, value) => {
    const { value: next, count } = rewriteValue(value, RADIUS_PX, counts);
    if (count === 0) return decl;
    total += count;
    return decl.slice(0, decl.length - value.length) + next;
  });
  return { css: out, count: total };
}

/** Convert every `<style>` block in a `.svelte` source. */
export function convertSvelte(text, counts = {}) {
  let total = 0;
  const out = text.replace(STYLE_RE, (_, open, body, close) => {
    const converted = convertStyleBody(body, counts);
    total += converted.count;
    return `${open}${converted.css}${close}`;
  });
  return { text: out, count: total };
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const counts = {};
  let total = 0;
  let files = 0;
  for (const { dir } of allPackageSrcDirs()) {
    for (const file of listFiles(dir, ['.svelte'])) {
      if (TEST_FILE.test(file)) continue;
      const original = readFileSync(file, 'utf8');
      const { text, count } = convertSvelte(original, counts);
      if (count === 0) continue;
      total += count;
      files++;
      if (!dryRun) writeFileSync(file, text);
    }
  }
  const breakdown = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([token, n]) => `${token}=${n}`)
    .join(', ');
  console.log(
    `${dryRun ? 'would convert' : 'converted'} ${total} px value(s) in ${files} file(s): ${breakdown}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
