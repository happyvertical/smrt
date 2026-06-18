#!/usr/bin/env node
/**
 * Hardcoded user-facing string ratchet for SMRT UI packages (Sweep S13 #1418).
 *
 * Flags prose string literals baked into `.svelte` markup so they can be routed
 * through the i18n layer (`useI18n().t` / `<Trans>`; see
 * docs/content/architecture/i18n.md). Two sources are checked, in the template
 * region only (`<script>` and `<style>` blocks are stripped):
 *
 *   1. Element text nodes that are multi-word prose ("No data available").
 *   2. The user-facing attributes placeholder / title / alt / aria-label with a
 *      static quoted value containing letters.
 *
 * Deliberately CONSERVATIVE to keep the report credible: single-word text nodes,
 * `{expression}` content, entities, and dynamic attribute values are ignored.
 * It will miss some strings — that is acceptable for a "flag new hardcoded
 * strings" gate; precision beats recall here.
 *
 * Rollout mirrors the design-token ratchets (#1373): report-only everywhere in
 * phase 1 (no package is fully extracted yet), strict for packages in
 * STRICT_PACKAGES once their extraction completes. Add a package there to flip
 * it to an error gate.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const PACKAGES = join(ROOT, 'packages');

// Packages enforced at ERROR. Empty in phase 1 — flip a package on once its
// user-facing strings are routed through the i18n layer.
const STRICT_PACKAGES = new Set();

// Dev/playground host, not a shippable library (consistent with the other ratchets).
const SCOPE_EXCLUDED_PACKAGES = new Set(['smrt-playground']);

const USER_FACING_ATTRS = ['placeholder', 'title', 'alt', 'aria-label'];

function listSvelteFiles(dir) {
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
      if (
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === '.svelte-kit' ||
        entry.name === '.turbo'
      ) {
        continue;
      }
      out.push(...listSvelteFiles(full));
    } else if (entry.name.endsWith('.svelte')) {
      out.push(full);
    }
  }
  return out;
}

// Replace a matched region with same-length whitespace (newlines preserved) so
// every offset into the returned string still maps to the original source line.
const blank = (m) => m.replace(/[^\n]/g, ' ');

/** Blank out `<script>` and `<style>` blocks, leaving only template markup. */
function extractMarkup(source) {
  return source
    .replace(/<script[\s\S]*?<\/script>/gi, blank)
    .replace(/<style[\s\S]*?<\/style>/gi, blank);
}

/** Blank `{...}` expressions and HTML comments (kept offset-stable). */
function blankExpressions(markup) {
  return markup
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/\{[\s\S]*?\}/g, blank);
}

const PROSE = /[A-Za-z][A-Za-z'’]*\s+[A-Za-z][A-Za-z'’]*/; // ≥ 2 letter-words
const lineOf = (source, index) => source.slice(0, index).split('\n').length;

function findViolations(source) {
  const markup = blankExpressions(extractMarkup(source));
  const violations = [];

  // 1. Text nodes: the gap after each `>` until the next `<` is a text node.
  let lastEnd = 0;
  const gaps = [];
  for (const tag of markup.matchAll(/<[^>]+>/g)) {
    if (tag.index > lastEnd) gaps.push([lastEnd, tag.index]);
    lastEnd = tag.index + tag[0].length;
  }
  if (lastEnd < markup.length) gaps.push([lastEnd, markup.length]);
  for (const [start, end] of gaps) {
    const text = markup.slice(start, end).replace(/&[a-z#0-9]+;/gi, ' ').trim();
    if (text && PROSE.test(text)) {
      violations.push({ line: lineOf(source, start), kind: 'text', text });
    }
  }

  // 2. User-facing attributes with a static quoted value containing letters.
  for (const attr of USER_FACING_ATTRS) {
    const re = new RegExp(`\\b${attr}\\s*=\\s*"([^"{}]*[A-Za-z][^"{}]*)"`, 'g');
    for (const a of markup.matchAll(re)) {
      violations.push({
        line: lineOf(source, a.index),
        kind: attr,
        text: a[1].trim(),
      });
    }
  }

  return violations;
}

function packageNameOf(relPath) {
  const parts = relPath.split(sep);
  return parts[0] === 'packages' ? parts[1] : null;
}

/** Only `packages/<pkg>/src/**` is shippable source (matches the other ratchets). */
function isInPackageSrc(relPath) {
  const parts = relPath.split(sep);
  return parts[0] === 'packages' && parts[2] === 'src';
}

const strictHits = [];
const reportHits = [];

for (const file of listSvelteFiles(PACKAGES)) {
  const rel = relative(ROOT, file);
  const pkg = packageNameOf(rel);
  if (!pkg || !isInPackageSrc(rel) || SCOPE_EXCLUDED_PACKAGES.has(pkg)) continue;
  const violations = findViolations(readFileSync(file, 'utf8'));
  if (violations.length === 0) continue;
  const bucket = STRICT_PACKAGES.has(pkg) ? strictHits : reportHits;
  for (const v of violations) bucket.push({ rel, ...v });
}

const fmt = (h) => `  ${h.rel}:${h.line}  [${h.kind}]  ${JSON.stringify(h.text)}`;
const showList = process.argv.includes('--list');

if (reportHits.length > 0) {
  const pkgs = new Set(reportHits.map((h) => packageNameOf(h.rel)));
  console.log(
    `\nℹ️  ${reportHits.length} hardcoded UI string(s) across ${pkgs.size} ` +
      `report-only package(s) — route through @happyvertical/smrt-svelte/i18n ` +
      `in later S13 phases (run \`pnpm check:hardcoded-strings --list\` for the list).`,
  );
  if (showList) for (const h of reportHits) console.log(fmt(h));
}

if (strictHits.length > 0) {
  console.error(
    `\n❌ ${strictHits.length} hardcoded UI string(s) in strict package(s) ` +
      `[${[...STRICT_PACKAGES].join(', ')}] — route them through ` +
      `useI18n().t / <Trans> (see docs/content/architecture/i18n.md):`,
  );
  for (const h of strictHits) console.error(fmt(h));
  process.exit(1);
}

if (reportHits.length === 0) {
  console.log('✓ check-hardcoded-strings: no hardcoded UI strings found.');
}
process.exit(0);
