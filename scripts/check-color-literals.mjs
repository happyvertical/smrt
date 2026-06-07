#!/usr/bin/env node
/**
 * Raw color-literal ratchet for SMRT UI packages.
 *
 * Bans hardcoded color literals (hex / `rgb(a)` / `hsl(a)`) inside CSS contexts
 * of `.svelte` and `.css` files, steering authors to the semantic
 * `--smrt-color-*` design tokens (issue #1373, parent epic #1354). Component
 * colors should be themeable across the material / glass / studio presets and
 * light/dark schemes; raw literals freeze them.
 *
 * Phased rollout (S1 phase 1):
 *   - `packages/smrt-svelte` is the reference library and is held to ERROR:
 *     any raw literal there fails the check (exit 1).
 *   - Every other package is REPORT-ONLY (warn): literals are listed but do not
 *     fail. Those packages migrate in later phases of #1373; flipping a package
 *     to strict means removing it from REPORT_ONLY once it is clean.
 *
 * What is allowed (never flagged):
 *   - `var(--token, #fallback)` fallbacks — the literal is only a fallback for
 *     an emitted token, which the svelte-token-check already guards.
 *   - Theme-definition / token-source files (THEME_DEFINITION_GLOBS) that
 *     legitimately hold literal values: the `--smrt-*` preset CSS, the simple
 *     ThemeProvider token map, the shared scales, the css-generator, and the
 *     legacy `--color-*` token sheet.
 *   - `<script>` / `<script module>` blocks in `.svelte` files — color literals
 *     there are JS values (e.g. a Material-3 palette seed), not CSS styling.
 *   - `transparent`, `currentColor`, `inherit` and other CSS-wide keywords are
 *     not literals and are never matched.
 *
 * Run: `node scripts/check-color-literals.mjs` or `pnpm check:color-literals`.
 * Exit code: 0 if no strict-package violations, 1 otherwise.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PACKAGES = join(ROOT, 'packages');

/** Packages held to ERROR. Everything else is report-only for now (#1373). */
const STRICT_PACKAGES = new Set(['smrt-svelte']);

/**
 * Path fragments (POSIX `/` separators) for token-source / theme-definition
 * files that legitimately contain raw color literals. Matched as substrings of
 * the package-relative path.
 */
const THEME_DEFINITION_FRAGMENTS = [
  'src/themes/styles/', // --smrt-* preset CSS (material/glass/studio/all)
  'src/theme/tokens.ts', // simple ThemeProvider token map
  'src/themes/shared.ts', // shared spacing/radius/duration scales
  'src/themes/css-generator.ts', // JS theme generator
  'src/styles/tokens.css', // legacy --color-* token sheet
];

/**
 * Only scan each package's published-source tree. Demo/playground apps,
 * generated theme copies under `static/`, and other dev-only assets are out of
 * scope: the contract is about the shippable component library, which is what
 * `svelte-check` / `svelte-package` build from `src/`.
 */
function isInPackageSrc(relPath) {
  // relPath like "smrt-svelte/src/components/ui/Badge.svelte"
  const parts = toPosix(relPath).split('/');
  return parts.length > 1 && parts[1] === 'src';
}

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

const HEX_RE = /#[0-9a-fA-F]{3}\b|#[0-9a-fA-F]{4}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{8}\b/g;
const FUNC_RE = /\b(?:rgba?|hsla?)\([^)]*\)/gi;

/**
 * Strip `<script>` / `<script module>` blocks from a `.svelte` source so color
 * literals that are JS values are not treated as CSS. Replaces each block with
 * blank lines to keep line numbers stable.
 */
function stripScriptBlocks(source) {
  return source.replace(
    /<script\b[^>]*>[\s\S]*?<\/script>/gi,
    (block) => block.replace(/[^\n]/g, ' '),
  );
}

/**
 * Whether the literal at `index` on `line` sits inside a `var(..., literal)`
 * fallback. We look back to the nearest unbalanced `var(` and require a comma
 * after it — i.e. the literal is the fallback argument.
 */
function isVarFallback(line, index) {
  const before = line.slice(0, index);
  const lastVar = before.lastIndexOf('var(');
  if (lastVar === -1) return false;
  const seg = before.slice(lastVar);
  const opens = (seg.match(/\(/g) || []).length;
  const closes = (seg.match(/\)/g) || []).length;
  return opens > closes && seg.includes(',');
}

/**
 * Blank out CSS `/* *​/` block comments (including multi-line ones) and `//`
 * line comments so literals inside them — e.g. an issue reference like `#1431`
 * that looks like a 4-digit hex — are not flagged. Newlines are preserved so
 * line numbers stay accurate.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead) =>
      lead + ' '.repeat(m.length - lead.length),
    );
}

/** Collect raw color-literal violations in a single file's source. */
function findViolations(file, source) {
  let text = file.endsWith('.svelte') ? stripScriptBlocks(source) : source;
  text = stripComments(text);
  const lines = text.split('\n');
  const hits = [];
  lines.forEach((line, i) => {
    for (const re of [HEX_RE, FUNC_RE]) {
      for (const m of line.matchAll(re)) {
        if (isVarFallback(line, m.index)) continue;
        hits.push({ line: i + 1, value: m[0], snippet: line.trim().slice(0, 100) });
      }
    }
  });
  return hits;
}

function packageNameOf(relPath) {
  // relPath like "smrt-svelte/src/components/ui/Badge.svelte"
  return relPath.split(sep)[0];
}

function toPosix(p) {
  return p.split(sep).join('/');
}

function isThemeDefinition(relPath) {
  const posix = toPosix(relPath);
  return THEME_DEFINITION_FRAGMENTS.some((frag) => posix.includes(frag));
}

const files = listFiles(PACKAGES, ['.svelte', '.css']);

const strictViolations = []; // { file, hits }
const reportOnly = new Map(); // package -> count

for (const file of files) {
  const relPath = relative(PACKAGES, file);
  if (!isInPackageSrc(relPath)) continue;
  if (isThemeDefinition(relPath)) continue;
  const pkg = packageNameOf(relPath);
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
    `⚠ color-literal-check: ${total} raw color literal(s) in report-only ` +
      'package(s) (not failing — later phases of #1373):',
  );
  for (const [pkg, count] of [...reportOnly].sort((a, b) => b[1] - a[1])) {
    console.warn(`    ${pkg}: ${count}`);
  }
  console.warn('');
}

if (strictViolations.length === 0) {
  console.log(
    `✓ color-literal-check: no raw color literals in strict package(s): ${[
      ...STRICT_PACKAGES,
    ].join(', ')}`,
  );
  process.exit(0);
}

const total = strictViolations.reduce((a, v) => a + v.hits.length, 0);
console.error(
  `✗ color-literal-check: ${total} raw color literal(s) in strict ` +
    `package(s): ${[...STRICT_PACKAGES].join(', ')}\n`,
);
for (const { file, hits } of strictViolations.sort((a, b) =>
  a.file.localeCompare(b.file),
)) {
  console.error(`  ${file}`);
  for (const h of hits) {
    console.error(`    L${h.line}: ${h.value}   | ${h.snippet}`);
  }
}
console.error(
  '\nReplace raw color literals with semantic --smrt-color-* tokens so\n' +
    'components stay themeable across material/glass/studio + light/dark.\n' +
    'Map by ROLE not hue (error→--smrt-color-error, surface→--smrt-color-surface,\n' +
    'backdrops→--smrt-color-scrim, shadows→color-mix(... var(--smrt-color-shadow))).\n' +
    'A var(--token, #fallback) fallback is allowed; token-source files are exempt\n' +
    '(see THEME_DEFINITION_FRAGMENTS in scripts/check-color-literals.mjs).',
);
process.exit(1);
