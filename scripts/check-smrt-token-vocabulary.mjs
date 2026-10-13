#!/usr/bin/env node
/**
 * Lint gate for the single `--smrt-*` token vocabulary (issue #3822).
 *
 * Fails when any `packages/*\/src` source uses a custom property that is not in the
 * `--smrt-*` namespace, in any of these forms:
 *   - `var(--name` anywhere that CSS or markup can reach (.svelte, .css, .ts, .js)
 *   - a declaration `--name:` in `.svelte` / `.css` (style blocks and inline styles)
 *   - a `style:--name` directive in `.svelte`
 *   - `setProperty` / `getPropertyValue` / `removeProperty` on `'--name'`
 *
 * Deliberately not checked: bare `'--name'` strings (CLI flags such as `'--token'`),
 * prose, and test files (`__tests__/`, `*.test.*`, `*.spec.*`), whose CSS fixtures
 * exist to exercise other tooling. The legacy `--color-*` / `--spacing-*` families get a
 * dedicated message because they are the reintroduction risk this gate exists for.
 *
 * Fix a violation with `node scripts/codemod-smrt-tokens.mjs` for known legacy names, or
 * rename a component-private variable to `--smrt-<component>-<name>` and define it on
 * the component root.
 *
 * Exit code: 0 when clean, 1 with one line per violation.
 * Run: `node scripts/check-smrt-token-vocabulary.mjs` (wired into `pnpm lint`).
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = join(ROOT, 'packages');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.svelte-kit', 'build', '.turbo']);
const NAME = '[a-zA-Z_][\\w-]*';

const TEST_FILE = /(^|\/)(__tests__|__typecheck__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

/** Each rule: a regex with a `name` group, the file kinds it applies to, and a label. */
const RULES = [
  {
    label: 'var()',
    re: new RegExp(`var\\(\\s*--(?<name>${NAME})(?![\\w-])`, 'g'),
    kinds: ['svelte', 'css', 'script'],
  },
  {
    label: 'declaration',
    re: new RegExp(`(?<![\\w-])--(?<name>${NAME})(?![\\w-])(?=\\s*:)`, 'g'),
    kinds: ['svelte', 'css'],
  },
  {
    label: 'style: directive',
    re: new RegExp(`style:--(?<name>${NAME})(?![\\w-])`, 'g'),
    kinds: ['svelte'],
  },
  {
    label: 'setProperty()',
    re: new RegExp(
      `(?:setProperty|getPropertyValue|removeProperty)\\(\\s*['"\`]--(?<name>${NAME})['"\`]`,
      'g',
    ),
    kinds: ['svelte', 'script'],
  },
];

function kindOf(file) {
  if (file.endsWith('.svelte')) return 'svelte';
  if (file.endsWith('.css')) return 'css';
  return 'script';
}

function listSources(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listSources(full, out);
    else if (['.svelte', '.css', '.ts', '.js', '.mjs'].includes(extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

function violationsIn(file) {
  const rel = relative(ROOT, file);
  if (TEST_FILE.test(rel)) return [];
  const kind = kindOf(file);
  const text = readFileSync(file, 'utf8');
  const found = [];
  for (const rule of RULES) {
    if (!rule.kinds.includes(kind)) continue;
    for (const match of text.matchAll(rule.re)) {
      const name = match.groups.name;
      if (name.startsWith('smrt-')) continue;
      found.push({
        file: rel,
        line: lineOf(text, match.index),
        name,
        label: rule.label,
      });
    }
  }
  return found;
}

function main() {
  const violations = [];
  for (const pkg of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    for (const root of ['src', 'playground/src']) {
      const dir = join(PACKAGES, pkg.name, root);
      try {
        readdirSync(dir);
      } catch {
        continue;
      }
      for (const file of listSources(dir)) violations.push(...violationsIn(file));
    }
  }
  return violations;
}

/**
 * Style-literal ratchet (issue #3826). Scans `.svelte` `<style>` blocks, with CSS
 * comments removed, for bare colour literals and raw px lengths, and compares the
 * per-file counts with `smrt-style-literal-allowlist.json`. Counts must match
 * exactly: a new literal fails, and an allow-list entry the source no longer
 * needs also fails so the list stays honest. `1px` (hairlines) and `0` are
 * allowed everywhere; theme-required `var(--smrt-*, literal)` fallbacks are
 * removed by `scripts/codemod-smrt-fallbacks.mjs`.
 */
const ALLOWLIST_PATH = join(ROOT, 'scripts', 'smrt-style-literal-allowlist.json');
const STYLE_BLOCK_RE = /<style[^>]*>([\s\S]*?)<\/style>/g;
const CSS_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
// Colour literals only: `#1589` in a comment is an issue reference, and `url(#id)`
// is an SVG reference. Both are excluded.
const HEX_RE =
  /(?<![\w&-])(?<!url\()#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![\w-])/g;
const PX_RE = /(?<![\w.-])-?\d*\.?\d+px\b/g;
const GLOBAL_PX = new Set(['0px', '1px']);

/** `{ hex: { file: { literal: n } }, px: { file: n } }` for component style blocks. */
function collectStyleLiterals() {
  const hex = {};
  const px = {};
  for (const pkg of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    for (const file of listSources(join(PACKAGES, pkg.name, 'src'))) {
      if (!file.endsWith('.svelte')) continue;
      const rel = relative(ROOT, file);
      if (TEST_FILE.test(rel)) continue;
      const text = readFileSync(file, 'utf8');
      const hexCounts = new Map();
      let pxCount = 0;
      for (const block of text.matchAll(STYLE_BLOCK_RE)) {
        const css = block[1].replace(CSS_COMMENT_RE, '');
        for (const m of css.matchAll(HEX_RE)) {
          const key = m[0].toLowerCase();
          hexCounts.set(key, (hexCounts.get(key) ?? 0) + 1);
        }
        for (const m of css.matchAll(PX_RE)) {
          if (!GLOBAL_PX.has(m[0])) pxCount++;
        }
      }
      if (hexCounts.size > 0) hex[rel] = Object.fromEntries([...hexCounts].sort());
      if (pxCount > 0) px[rel] = pxCount;
    }
  }
  return { hex, px };
}

function readAllowlist() {
  if (!existsSync(ALLOWLIST_PATH)) return { hex: {}, px: {} };
  return JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
}

/** Literal violations: actual counts must equal the allow-list exactly. */
function literalViolations(literals) {
  const allow = readAllowlist();
  const out = [];
  const files = new Set([
    ...Object.keys(literals.hex),
    ...Object.keys(allow.hex ?? {}),
    ...Object.keys(literals.px),
    ...Object.keys(allow.px ?? {}),
  ]);
  for (const file of [...files].sort()) {
    const actualHex = literals.hex[file] ?? {};
    const allowedHex = allow.hex?.[file] ?? {};
    const values = new Set([...Object.keys(actualHex), ...Object.keys(allowedHex)]);
    for (const value of [...values].sort()) {
      const actual = actualHex[value] ?? 0;
      const allowed = allowedHex[value] ?? 0;
      if (actual === allowed) continue;
      out.push(
        actual > allowed
          ? `${file}: bare colour ${value} x${actual} (allow-listed ${allowed}); use a --smrt-color-* token or allow-list it in scripts/smrt-style-literal-allowlist.json`
          : `${file}: allow-list entry ${value} x${allowed} is stale (actual ${actual}); regenerate with --write-allowlist`,
      );
    }
    const actualPx = literals.px[file] ?? 0;
    const allowedPx = allow.px?.[file] ?? 0;
    if (actualPx === allowedPx) continue;
    out.push(
      actualPx > allowedPx
        ? `${file}: ${actualPx} raw px value(s) (allow-listed ${allowedPx}); use a --smrt-spacing-*/--smrt-radius-* token where one fits, or allow-list it`
        : `${file}: px allow-list entry ${allowedPx} is stale (actual ${actualPx}); regenerate with --write-allowlist`,
    );
  }
  return out;
}

const violations = main();
const literals = collectStyleLiterals();

if (process.argv.includes('--write-allowlist')) {
  const body = {
    $comment:
      'Per-file counts of bare colour literals and raw px lengths in component <style> blocks. Regenerate with `node scripts/check-smrt-token-vocabulary.mjs --write-allowlist`; shrink it when a literal is converted.',
    hex: literals.hex,
    px: literals.px,
  };
  writeFileSync(ALLOWLIST_PATH, `${JSON.stringify(body, null, 2)}\n`);
  console.log(
    `wrote ${ALLOWLIST_PATH.replace(ROOT + '/', '')}: ${Object.keys(literals.hex).length} hex file(s), ${Object.keys(literals.px).length} px file(s).`,
  );
  process.exit(0);
}

const literalFailures = literalViolations(literals);

if (violations.length === 0 && literalFailures.length === 0) {
  console.log(
    'smrt token vocabulary: clean (every custom property uses --smrt-*; style literals match the allow-list).',
  );
  process.exit(0);
}

for (const v of violations) {
  const legacy = /^(color|spacing)-/.test(v.name) ? ' (legacy vocabulary)' : '';
  console.error(
    `${v.file}:${v.line}: ${v.label} uses --${v.name}${legacy}; use a --smrt-* token or --smrt-<component>-<name>`,
  );
}
if (violations.length > 0) {
  console.error(
    `\n${violations.length} non-smrt custom propert${violations.length === 1 ? 'y' : 'ies'}. ` +
      'Run `node scripts/codemod-smrt-tokens.mjs` for legacy names.',
  );
}
for (const message of literalFailures) console.error(message);
process.exit(1);
