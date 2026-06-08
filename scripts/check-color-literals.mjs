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
 *     to strict means adding it to STRICT_PACKAGES once it is clean.
 *
 * What is allowed (never flagged):
 *   - `var(--token, #fallback)` fallbacks — the literal is only a fallback for
 *     an emitted token, which the svelte-token-check already guards.
 *   - Theme-definition / token-source files (THEME_DEFINITION_FRAGMENTS) that
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
const STRICT_PACKAGES = new Set([
  'smrt-svelte',
  'content',
  'products',
  'assets',
  'chat',
  'images',
  'subscriptions',
  'projects',
  'users',
  'messages',
]);

/**
 * Packages skipped entirely — dev/playground hosts, not shippable product
 * component libraries (the ratchet's contract). Their chrome is dev tooling,
 * not themeable product UI, so raw literals there are out of scope (#1373).
 */
const SCOPE_EXCLUDED_PACKAGES = new Set(['smrt-playground']);

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
 * Intentional brand / 3rd-party fixed color literals that must NOT be tokenized
 * (theming them would break recognition). Scoped to specific files AND specific
 * values: only these exact literals are exempt, so any OTHER raw literal
 * introduced in the same file is still caught.
 */
const BRAND_LITERAL_ALLOWLIST = [
  {
    // Channel-brand avatar colors (Slack purple, Twitter blue) kept for
    // at-a-glance recognition; the generic email avatar is tokenized.
    fragment: 'messages/src/svelte/components/AccountAvatar.svelte',
    values: new Set(['#e8def8', '#4a1175', '#d3e8fd', '#0c4a6e']),
  },
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
 * For a `.svelte` source, keep ONLY the contents of `<style>` blocks and blank
 * everything else (script + markup), preserving newlines so reported line
 * numbers stay accurate.
 *
 * Scanning real CSS only (rather than "everything but <script>") avoids false
 * matches from markup — notably a `/*` inside an attribute like
 * `accept="image/*"`, which would otherwise make the CSS block-comment scanner
 * swallow every literal up to the next `*​/` and silently hide them (#1373).
 * Inline `style="..."` attributes are intentionally not scanned; component CSS
 * lives in `<style>` blocks.
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

/**
 * Blank out whole `var(...)` calls — balanced parens, across multiple lines —
 * so literals used as `var(--token, #fallback)` fallbacks are never flagged,
 * regardless of how the call is wrapped by the formatter. Newlines are
 * preserved so reported line numbers stay accurate.
 */
function stripVarCalls(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    if (source.startsWith('var(', i)) {
      let depth = 0;
      let j = i + 3; // points at the '('
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

/**
 * Blank out numeric HTML character references (`&#9662;`, `&#x25BC;`) so markup
 * glyphs — e.g. a chevron `&#9662;` or gear `&#9881;` icon — are not mistaken
 * for a 3/4-digit hex color literal. Newlines are preserved so line numbers stay
 * accurate.
 */
function stripHtmlEntities(source) {
  return source.replace(/&#x?[0-9a-fA-F]+;/g, (m) => ' '.repeat(m.length));
}

/** Collect raw color-literal violations in a single file's source. */
function findViolations(file, source) {
  let text = file.endsWith('.svelte') ? extractStyleBlocks(source) : source;
  if (file.endsWith('.svelte')) text = stripHtmlEntities(text);
  text = stripComments(text);
  // Blank out var(...) calls (multi-line aware) so allowed `var(--token,
  // #fallback)` fallbacks are never flagged, however the call is wrapped.
  text = stripVarCalls(text);
  const lines = text.split('\n');
  const hits = [];
  lines.forEach((line, i) => {
    for (const re of [HEX_RE, FUNC_RE]) {
      for (const m of line.matchAll(re)) {
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
  const pkg = packageNameOf(relPath);
  if (SCOPE_EXCLUDED_PACKAGES.has(pkg)) continue;
  if (isThemeDefinition(relPath)) continue;
  let hits = findViolations(file, readFileSync(file, 'utf8'));
  // Drop only the explicitly allow-listed brand literals (by value) so the file
  // stays scanned — any other raw literal in it is still caught.
  const allow = BRAND_LITERAL_ALLOWLIST.find((b) =>
    toPosix(relPath).includes(b.fragment),
  );
  if (allow) {
    hits = hits.filter((h) => !allow.values.has(h.value.toLowerCase()));
  }
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
