#!/usr/bin/env node
/**
 * Raw z-index ratchet for SMRT UI packages.
 *
 * Bans hardcoded *global-layer* z-index values (>= THRESHOLD) in CSS contexts of
 * `.svelte` and `.css` files, steering authors to the centralized
 * `--smrt-z-index-*` scale (issue #1373, parent epic #1354):
 *
 *   dropdown 1000 / sticky 1100 / overlay 1200 / modal|dialog 1300 /
 *   popover 1400 / toast 1500 / tooltip 1600
 *
 * A shared scale prevents cross-component z-index wars (today: 9999 in forms,
 * 1000 in chat, 65/70 in ToolsDock — no system).
 *
 * What is allowed (never flagged):
 *   - `z-index: var(--smrt-z-index-*, <fallback>)` — already on the scale.
 *   - Small LOCAL values (`< THRESHOLD`): component-internal stacking (e.g. a
 *     label over a pseudo-element, a sticky cell within a table) is not part of
 *     the global layering system and stays a plain number.
 *   - `<script>` blocks and markup in `.svelte` files (only `<style>` is scanned).
 *   - Comments.
 *
 * Phased rollout: `packages/smrt-svelte` (the reference library) is held to ERROR;
 * every other package is REPORT-ONLY (warn) until migrated. Flip a package to
 * strict by adding it to STRICT_PACKAGES once clean.
 *
 * Run: `node scripts/check-z-index.mjs` or `pnpm check:z-index`.
 * Exit code: 0 if no strict-package violations, 1 otherwise.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PACKAGES = join(ROOT, 'packages');

/** z-index values at or above this are global layers and must use a token. */
const THRESHOLD = 50;

/** Packages held to ERROR. Everything else is report-only for now (#1373). */
const STRICT_PACKAGES = new Set(['smrt-svelte']);

/**
 * Packages skipped entirely — dev/playground hosts, not shippable product
 * component libraries (matches the color ratchet's scope contract).
 */
const SCOPE_EXCLUDED_PACKAGES = new Set(['smrt-playground']);

/** Recursively list files with one of `exts` under `dir` (skips node_modules/dist). */
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

/** Only scan each package's published-source tree. */
function isInPackageSrc(relPath) {
  const parts = toPosix(relPath).split('/');
  return parts.length > 1 && parts[1] === 'src';
}

/**
 * For a `.svelte` source, keep ONLY the contents of `<style>` blocks and blank
 * everything else (script + markup), preserving newlines so reported line
 * numbers stay accurate. Scanning real CSS only avoids false matches from
 * markup / script (mirrors scripts/check-color-literals.mjs).
 */
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

// Matches a `z-index:` declaration's value up to the statement / rule end.
const ZINDEX_DECL_RE = /z-index:\s*([^;}]+)/gi;

/**
 * Collect raw global-layer z-index violations. A declaration is allowed ONLY
 * when it references the centralized scale (`var(--smrt-z-index-*)`). Otherwise
 * any numeric value >= THRESHOLD is flagged — including a numeric fallback inside
 * a NON-token `var(...)` such as `z-index: var(--local, 9999)`, which would
 * otherwise be an easy bypass.
 */
function findViolations(file, source) {
  let text = file.endsWith('.svelte') ? extractStyleBlocks(source) : source;
  text = stripComments(text);
  const lines = text.split('\n');
  const hits = [];
  lines.forEach((line, i) => {
    for (const m of line.matchAll(ZINDEX_DECL_RE)) {
      const value = m[1].trim();
      if (/var\(\s*--smrt-z-index-/.test(value)) continue;
      const nums = value.match(/\d+/g) || [];
      if (nums.some((n) => Number(n) >= THRESHOLD)) {
        hits.push({
          line: i + 1,
          value: `z-index: ${value}`,
          snippet: line.trim().slice(0, 100),
        });
      }
    }
  });
  return hits;
}

const files = listFiles(PACKAGES, ['.svelte', '.css']);

const strictViolations = []; // { file, hits }
const reportOnly = new Map(); // package -> count

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
    `⚠ z-index-check: ${total} raw global-layer z-index value(s) in ` +
      'report-only package(s) (not failing — later phases of #1373):',
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
    `\n✗ z-index-check: ${total} raw global-layer z-index value(s) in ` +
      `strict package(s): ${[...STRICT_PACKAGES].join(', ')}`,
  );
  for (const { file, hits } of strictViolations) {
    console.error(`  ${file}`);
    for (const h of hits) {
      console.error(`    L${h.line}: ${h.value}   | ${h.snippet}`);
    }
  }
  console.error(
    '\nUse the centralized scale: z-index: var(--smrt-z-index-<layer>, <fallback>)',
  );
  console.error(
    'Layers: dropdown sticky overlay modal dialog popover toast tooltip.',
  );
  console.error(
    `Small local stacking (< ${THRESHOLD}) is allowed as a plain number.`,
  );
  process.exit(1);
}

console.log(
  `✓ z-index-check: no raw global-layer z-index in strict package(s): ${[
    ...STRICT_PACKAGES,
  ].join(', ')}`,
);
