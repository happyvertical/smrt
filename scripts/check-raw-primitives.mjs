#!/usr/bin/env node
/**
 * Raw UI-primitive ratchet for SMRT UI packages.
 *
 * Steers component authors to the shared primitives instead of re-rolling raw
 * interactive HTML. Per the formalized split (issue #1589, parent epic #1354):
 *
 *   - `@happyvertical/smrt-ui` owns domain-agnostic VISUAL primitives — Button,
 *     Card, Modal, Badge, Avatar, Chip, Dropdown, Tooltip, etc. — PLUS the
 *     Provider-free base FORM primitives (Form, Input, Select, Textarea, Toggle,
 *     FormGroup) under `./forms`, relocated to the leaf in #1589's deferred-forms
 *     phase.
 *   - `@happyvertical/smrt-svelte` owns the Provider-REQUIRED form primitives —
 *     CheckboxInput, the rich Form, TextInput, MoneyInput, and the specialized
 *     date/measurement/address/file inputs (they carry i18n + spoken-input
 *     logic). It re-exports the base primitives from smrt-ui.
 *   - Domain packages import visual + base form primitives from smrt-ui and the
 *     Provider-required form primitives from smrt-svelte. They should NOT
 *     hand-roll raw `<button>` / `<input>` /
 *     `<select>` / `<textarea>` / `<form>` markup — that re-introduces the
 *     inconsistent a11y / focus / disabled-state behavior the primitives fix.
 *
 * This ratchet flags raw occurrences of those five elements in `.svelte`
 * MARKUP. It deliberately does NOT flag `<a>` (navigation has no primitive) or
 * PascalCase component tags (`<Button>` is a primitive, not raw HTML).
 *
 * Phased rollout (Wave 0 = this baseline):
 *   - Every package is REPORT-ONLY (warn): occurrences are listed but do not
 *     fail. Packages migrate in Waves 1-5 of #1589; a package opts into STRICT
 *     enforcement once it is clean by declaring `"smrtRawPrimitives": "strict"`
 *     in ITS OWN package.json (read below). This per-package flag — rather than a
 *     central allowlist in this file — keeps each migration PR touching only its
 *     own package, so concurrent #1589 PRs never conflict on a shared line.
 *
 * What is allowed (never flagged):
 *   - PRIMITIVE-SOURCE files (PRIMITIVE_SOURCE_FRAGMENTS): smrt-ui's own
 *     components and smrt-svelte's form components DEFINE the primitives, so the
 *     raw elements inside them are the implementation, not a re-roll.
 *   - `<script>` / `<style>` blocks and `<!-- -->` comments are blanked before
 *     scanning, so an element name mentioned in JS, CSS, or a comment is never
 *     matched (line numbers are preserved).
 *   - `__tests__` directories — test fixtures are not shippable product UI.
 *   - An element immediately preceded by an escape-hatch annotation:
 *       <!-- raw-primitive-allow: <reason> -->
 *     for genuinely-structural / semantic controls that no primitive should own
 *     (e.g. a click-catching backdrop, a custom mic toggle). The reason is
 *     required so the exception is self-documenting and reviewable — the same
 *     spirit as the color ratchet's value-allowlist.
 *
 * Run: `node scripts/check-raw-primitives.mjs` or `pnpm check:raw-primitives`.
 * Exit code: 0 if no strict-package violations, 1 otherwise.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PACKAGES = join(ROOT, 'packages');

/**
 * Packages held to ERROR. A package opts in via `"smrtRawPrimitives"` in its own
 * package.json — so the strict list is DERIVED from the per-package flags rather
 * than maintained centrally here. Two modes:
 *
 *   - `"strict"`         → all five raw elements (button/input/select/textarea/
 *                          form) are errors. Full primitive adoption.
 *   - `"strict-buttons"` → only raw `<button>` is an error; the form elements
 *                          (`<input>`/`<select>`/`<textarea>`/`<form>`) are
 *                          DEFERRED, not flagged. This is the #1589 "buttons-only
 *                          now, forms later" mode: the form primitives currently
 *                          require a `<Provider>` and/or create a smrt-cli
 *                          build-graph cycle for packages in smrt-svelte's
 *                          closure, so real form adoption waits on relocating the
 *                          base form primitives down to smrt-ui (the leaf). A
 *                          package in this mode has migrated its buttons and will
 *                          flip to `"strict"` when that follow-up lands.
 *
 * Everything without the flag stays report-only (#1589 Wave 0 baseline).
 *
 * Why per-package instead of a central Set: every #1589 migration PR would
 * otherwise edit one shared line, so two PRs branched from a `main` lacking each
 * other's entry 3-way-conflict on it. Reading the flag from each package's own
 * package.json keeps every PR's footprint inside its own package, so they merge
 * independently in any order.
 */
function readStrictModes() {
  /** @type {Map<string, 'strict' | 'strict-buttons'>} */
  const modes = new Map();
  let entries;
  try {
    entries = readdirSync(PACKAGES, { withFileTypes: true });
  } catch {
    return modes;
  }
  // Sort so iteration order (and thus the printed strict-list) is deterministic
  // — `readdirSync` order is not guaranteed across OS/filesystems.
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let pkgJson;
    try {
      pkgJson = JSON.parse(
        readFileSync(join(PACKAGES, entry.name, 'package.json'), 'utf8'),
      );
    } catch {
      continue; // no/invalid package.json — not a publishable package
    }
    const mode = pkgJson.smrtRawPrimitives;
    if (mode === undefined) continue; // not opted in — report-only
    if (mode === 'strict' || mode === 'strict-buttons') {
      modes.set(entry.name, mode);
    } else {
      // Loud-fail on a typo'd/unknown value (e.g. "strict-button", true) — a
      // silently-ignored flag would leave the package unenforced, the exact
      // silent-leak this ratchet exists to prevent (PR #1615 review).
      invalid.push({ pkg: entry.name, value: mode });
    }
  }
  return modes;
}

/** Packages whose `smrtRawPrimitives` value is set but not a recognized mode. */
const invalid = [];
const STRICT_MODES = readStrictModes();
if (invalid.length > 0) {
  console.error(
    '✗ raw-primitive-check: unrecognized "smrtRawPrimitives" value(s) — use ' +
      '"strict" or "strict-buttons":',
  );
  for (const { pkg, value } of invalid) {
    console.error(`    ${pkg}: ${JSON.stringify(value)}`);
  }
  process.exit(1);
}
const STRICT_PACKAGES = new Set(STRICT_MODES.keys());

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
/** The subset flagged in `strict-buttons` mode (form elements are deferred). */
const BUTTON_ELEMENTS = ['button'];
// Build an opening-tag regex for a set of lowercase HTML elements, terminated by
// whitespace, `>` or `/`. Lowercase-only so PascalCase Svelte components
// (`<Button>`) never match. Cached per element-set so we compile each once.
const RAW_ELEMENT_RES = new Map();
function rawElementRe(elements) {
  const key = elements.join('|');
  let re = RAW_ELEMENT_RES.get(key);
  if (!re) {
    re = new RegExp(`<(${key})(\\s|>|/)`, 'g');
    RAW_ELEMENT_RES.set(key, re);
  }
  re.lastIndex = 0;
  return re;
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
      // Skip dependency, build/cache, and test-fixture trees. `.svelte-kit`
      // holds generated `__package__` copies of every component; `__tests__`
      // holds test fixtures — neither is authored, shippable product UI.
      if (
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === '.svelte-kit' ||
        entry.name === '.turbo' ||
        entry.name === '__tests__'
      )
        continue;
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
 * Escape-hatch annotation: `<!-- raw-primitive-allow: <reason> -->`.
 *
 * A `:` followed by a non-empty reason is REQUIRED (the `:\s*\S`) — a bare
 * `<!-- raw-primitive-allow -->` does NOT match, so the exemption is never
 * silent: the author must say why the raw element is justified.
 */
const ALLOW_RE = /<!--\s*raw-primitive-allow:\s*\S[^>]*?-->/gi;

/**
 * Collect raw-primitive violations in a single `.svelte` file's source.
 *
 * Matches against the whole markup (NOT line-by-line) so a multi-line opening
 * tag — `<button\n  class="...">`, where the terminating whitespace is the
 * newline — is still caught; line numbers are derived from the match index.
 *
 * An element is exempt when a `raw-primitive-allow` annotation sits immediately
 * before it (only whitespace between the annotation and the element). The
 * annotations are read from the ORIGINAL source — `markupOnly` blanks comments
 * but preserves character positions, so indices line up.
 */
function findViolations(source, elements = RAW_ELEMENTS) {
  const text = markupOnly(source);
  const allowEnds = [...source.matchAll(ALLOW_RE)].map(
    (m) => m.index + m[0].length,
  );
  const hits = [];
  for (const m of text.matchAll(rawElementRe(elements))) {
    const idx = m.index;
    // Exempt if an allow annotation immediately precedes this element.
    if (
      allowEnds.some(
        (end) => end <= idx && /^\s*$/.test(source.slice(end, idx)),
      )
    ) {
      continue;
    }
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
  // `strict-buttons` packages only flag raw <button>; their form elements are
  // deferred (see readStrictModes). Report-only + full `strict` flag all five.
  const mode = STRICT_MODES.get(pkg);
  const elements = mode === 'strict-buttons' ? BUTTON_ELEMENTS : RAW_ELEMENTS;
  const hits = findViolations(readFileSync(file, 'utf8'), elements);
  if (hits.length === 0) continue;
  if (mode) {
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
  if (STRICT_MODES.size > 0) {
    const full = [...STRICT_MODES]
      .filter(([, m]) => m === 'strict')
      .map(([p]) => p);
    const buttonsOnly = [...STRICT_MODES]
      .filter(([, m]) => m === 'strict-buttons')
      .map(([p]) => p);
    if (full.length > 0) {
      console.log(
        `✓ raw-primitive-check: no raw interactive elements in strict package(s): ${full.join(', ')}`,
      );
    }
    if (buttonsOnly.length > 0) {
      console.log(
        `✓ raw-primitive-check: no raw <button> in buttons-only package(s) (forms deferred, #1589): ${buttonsOnly.join(', ')}`,
      );
    }
  } else {
    console.log(
      '✓ raw-primitive-check: no strict packages yet (#1589 Wave 0 baseline — report-only).',
    );
  }
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
    '  <button>  → Button         (@happyvertical/smrt-ui/ui; pass `class` for custom styling)\n' +
    '  <input>/<textarea>/<select>/<form> → Input/Textarea/Select/Form\n' +
    '                              (@happyvertical/smrt-ui/forms — Provider-free base primitives)\n' +
    'For a genuinely-structural control no primitive should own (backdrop, custom\n' +
    'toggle), annotate it: <!-- raw-primitive-allow: <reason> --> on the line above.\n' +
    'Primitive-source files (smrt-ui/src, smrt-svelte/src/components/forms) are\n' +
    'exempt — see PRIMITIVE_SOURCE_FRAGMENTS in this script.',
);
process.exit(1);
