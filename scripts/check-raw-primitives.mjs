#!/usr/bin/env node
/**
 * Raw UI-primitive ratchet for SMRT UI packages.
 *
 * Steers component authors to the shared primitives instead of re-rolling raw
 * interactive HTML. Per the formalized split (issue #1589, parent epic #1354):
 *
 *   - `@happyvertical/smrt-ui` owns domain-agnostic VISUAL primitives — Button,
 *     Card, Modal, Badge, Avatar, Chip, Dropdown, Tooltip, etc.
 *   - `@happyvertical/smrt-svelte` owns the FORM primitives — Input, Textarea,
 *     Select, Checkbox/Toggle, Form, and the specialized date/measurement/
 *     address/file inputs (they carry i18n + spoken-input logic).
 *   - Domain packages import visual primitives from smrt-ui and form primitives
 *     from smrt-svelte. They should NOT hand-roll raw `<button>` / `<input>` /
 *     `<select>` / `<textarea>` / `<form>` markup — that re-introduces the
 *     inconsistent a11y / focus / disabled-state behavior the primitives fix.
 *
 * This ratchet flags raw occurrences of those five elements in `.svelte`
 * MARKUP. It deliberately does NOT flag `<a>` (navigation has no primitive) or
 * PascalCase component tags (`<Button>` is a primitive, not raw HTML).
 *
 * Phased rollout (Wave 0 = this baseline):
 *   - Every package is REPORT-ONLY (warn): occurrences are listed but do not
 *     fail. Packages migrate in Waves 1-5 of #1589; flipping a package to strict
 *     means adding it to STRICT_PACKAGES once it is clean.
 *
 * What is allowed (never flagged):
 *   - PRIMITIVE-SOURCE files (PRIMITIVE_SOURCE_FRAGMENTS): smrt-ui's own
 *     components and smrt-svelte's form components DEFINE the primitives, so the
 *     raw elements inside them are the implementation, not a re-roll.
 *   - `<script>` / `<style>` blocks and `<!-- -->` comments are blanked before
 *     scanning, so an element name mentioned in JS, CSS, or a comment is never
 *     matched (line numbers are preserved).
 *
 * Run: `node scripts/check-raw-primitives.mjs` or `pnpm check:raw-primitives`.
 * Exit code: 0 if no strict-package violations, 1 otherwise.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PACKAGES = join(ROOT, 'packages');

/**
 * Packages held to ERROR. Everything else is report-only for now (#1589 Wave 0
 * establishes the baseline; later waves flip packages strict as they migrate).
 */
const STRICT_PACKAGES = new Set([]);

/**
 * Packages skipped entirely — dev/playground hosts, not shippable product
 * component libraries (the ratchet's contract), matching the other UI ratchets.
 */
const SCOPE_EXCLUDED_PACKAGES = new Set(['smrt-playground']);

/**
 * Path fragments (POSIX `/` separators) for primitive-SOURCE files that
 * legitimately contain raw interactive elements because they DEFINE the
 * primitives. Matched as substrings of the package-relative path.
 */
const PRIMITIVE_SOURCE_FRAGMENTS = [
  // smrt-ui is the visual-primitive HOME — every component there is a primitive
  // (or a first-party widget composing them), so raw elements are the
  // implementation, never a domain re-roll. Exempt the whole src tree.
  'smrt-ui/src/',
  // smrt-svelte OWNS the form primitives but is otherwise an integration layer
  // that should adopt smrt-ui visual primitives — exempt only its form dir, so
  // its shell/composites are still held to "use Button, not <button>".
  'smrt-svelte/src/components/forms/',
];

/** Raw interactive elements that have a shared primitive and must not be re-rolled. */
const RAW_ELEMENTS = ['button', 'input', 'select', 'textarea', 'form'];
// Opening tag for a lowercase HTML element, terminated by whitespace, `>` or
// `/`. Lowercase-only so PascalCase Svelte components (`<Button>`) never match.
const RAW_ELEMENT_RE = new RegExp(`<(${RAW_ELEMENTS.join('|')})(\\s|>|/)`, 'g');

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

/**
 * Blank `<script>`/`<style>` block contents and `<!-- -->` comments, preserving
 * newlines so reported line numbers stay accurate. Element names in JS, CSS, or
 * comments are then never mistaken for raw markup.
 */
function markupOnly(source) {
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  return source
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, blank)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, blank)
    .replace(/<!--[\s\S]*?-->/g, blank);
}

/**
 * Collect raw-primitive violations in a single `.svelte` file's source.
 *
 * Matches against the whole markup (NOT line-by-line) so a multi-line opening
 * tag — `<button\n  class="...">`, where the terminating whitespace is the
 * newline — is still caught; line numbers are derived from the match index.
 */
function findViolations(source) {
  const text = markupOnly(source);
  const hits = [];
  for (const m of text.matchAll(RAW_ELEMENT_RE)) {
    const idx = m.index;
    const line = text.slice(0, idx).split('\n').length;
    const lineStart = text.lastIndexOf('\n', idx - 1) + 1;
    const nl = text.indexOf('\n', idx);
    const snippet = text
      .slice(lineStart, nl === -1 ? text.length : nl)
      .trim()
      .slice(0, 100);
    hits.push({ line, element: m[1], snippet });
  }
  return hits;
}

function toPosix(p) {
  return p.split(sep).join('/');
}

function packageNameOf(relPath) {
  return relPath.split(sep)[0];
}

/** Only scan each package's published-source tree (`<pkg>/src/...`). */
function isInPackageSrc(relPath) {
  const parts = toPosix(relPath).split('/');
  return parts.length > 1 && parts[1] === 'src';
}

function isPrimitiveSource(relPath) {
  const posix = toPosix(relPath);
  return PRIMITIVE_SOURCE_FRAGMENTS.some((frag) => posix.includes(frag));
}

const files = listFiles(PACKAGES, ['.svelte']);

const strictViolations = []; // { file, hits }
const reportOnly = new Map(); // package -> count

for (const file of files) {
  const relPath = relative(PACKAGES, file);
  if (!isInPackageSrc(relPath)) continue;
  const pkg = packageNameOf(relPath);
  if (SCOPE_EXCLUDED_PACKAGES.has(pkg)) continue;
  if (isPrimitiveSource(relPath)) continue;
  const hits = findViolations(readFileSync(file, 'utf8'));
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
    `⚠ raw-primitive-check: ${total} raw interactive element(s) in ` +
      'report-only package(s) (not failing — migrates in later waves of #1589):',
  );
  for (const [pkg, count] of [...reportOnly].sort((a, b) => b[1] - a[1])) {
    console.warn(`    ${pkg}: ${count}`);
  }
  console.warn('');
}

if (strictViolations.length === 0) {
  const strict = [...STRICT_PACKAGES];
  console.log(
    strict.length > 0
      ? `✓ raw-primitive-check: no raw interactive elements in strict package(s): ${strict.join(', ')}`
      : '✓ raw-primitive-check: no strict packages yet (#1589 Wave 0 baseline — report-only).',
  );
  process.exit(0);
}

const total = strictViolations.reduce((a, v) => a + v.hits.length, 0);
console.error(
  `✗ raw-primitive-check: ${total} raw interactive element(s) in strict ` +
    `package(s): ${[...STRICT_PACKAGES].join(', ')}\n`,
);
for (const { file, hits } of strictViolations.sort((a, b) =>
  a.file.localeCompare(b.file),
)) {
  console.error(`  ${file}`);
  for (const h of hits) {
    console.error(`    L${h.line}: <${h.element}>   | ${h.snippet}`);
  }
}
console.error(
  '\nReplace raw interactive elements with the shared primitives so components\n' +
    'get consistent a11y / focus / disabled-state behavior (#1589):\n' +
    '  <button>  → Button         (@happyvertical/smrt-ui)\n' +
    '  <input>/<textarea>/<select>/<form> → Input/Textarea/Select/Form\n' +
    '                              (@happyvertical/smrt-svelte)\n' +
    'Primitive-source files (smrt-ui/src/components, smrt-svelte/src/components/\n' +
    'forms) are exempt — see PRIMITIVE_SOURCE_FRAGMENTS in this script.',
);
process.exit(1);
