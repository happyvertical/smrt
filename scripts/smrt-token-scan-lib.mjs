/**
 * Shared scanner for `--smrt-*` custom properties across `packages/*\/src`.
 *
 * Used by `check-svelte-tokens.mjs` (emission contract) and
 * `generate-smrt-required-tokens.mjs` (theme-completeness list, issue #3826).
 * A token a component defines for itself (`--smrt-<component>-*` on its own
 * root, set in CSS or from script) is component-private: it satisfies consumers
 * only inside the defining package and is never a theme token.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..');
export const PACKAGES = join(ROOT, 'packages');

/** Generated/build output that mirrors src — never the source of truth. */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.svelte-kit', 'build', '.turbo']);

/** Recursively list files under `dir` whose name ends in one of `exts`. */
export function listFiles(dir, exts) {
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
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...listFiles(full, exts));
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

/** Every `packages/<pkg>/src` that exists, as `{ pkg, dir }`. */
export function allPackageSrcDirs() {
  const out = [];
  for (const entry of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(PACKAGES, entry.name, 'src');
    if (existsSync(dir)) out.push({ pkg: entry.name, dir });
  }
  return out;
}

const VAR_RE = /var\(\s*(--smrt-[a-z0-9_-]+)/gi;
const DEFINE_RE = /(--smrt-[a-z0-9_-]+)\s*:/gi;

/**
 * Tokens a component SETS from script or markup rather than declaring in CSS:
 * `style:--smrt-x={value}` directives, `'--smrt-x': value` object keys, and
 * `setProperty('--smrt-x', …)`.
 */
const SET_FROM_CODE_RE = [
  /style:(--smrt-[a-z0-9-]+)/g,
  /['"`](--smrt-[a-z0-9-]+)['"`]\s*:/g,
  /setProperty\(\s*['"`](--smrt-[a-z0-9-]+)['"`]/g,
];

/** Collect `--smrt-*` tokens referenced via var(), as token -> Set(pkg). */
export function collectConsumedByPackage({ exts = ['.svelte', '.ts', '.css'] } = {}) {
  const consumed = new Map(); // token -> count
  const byPackage = new Map(); // token -> Set(pkg)
  for (const { pkg, dir } of allPackageSrcDirs()) {
    for (const file of listFiles(dir, exts)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(VAR_RE)) {
        consumed.set(m[1], (consumed.get(m[1]) ?? 0) + 1);
        if (!byPackage.has(m[1])) byPackage.set(m[1], new Set());
        byPackage.get(m[1]).add(pkg);
      }
    }
  }
  return { consumed, byPackage };
}

/** Collect every `--smrt-*` token DEFINED (`--smrt-x: value`) in a CSS string. */
export function collectDefinedInCss(text, into) {
  for (const m of text.matchAll(DEFINE_RE)) into.add(m[1]);
}

export function collectSetFromCode(text, into) {
  for (const re of SET_FROM_CODE_RE) {
    for (const m of text.matchAll(re)) into.add(m[1]);
  }
}

/**
 * Per-package inline token definitions (`--smrt-x: value` in a package's own
 * component CSS, e.g. --smrt-ws-* / --smrt-role-color, plus script-set knobs).
 * They satisfy consumers only WITHIN the same package.
 */
export function collectInlineByPackage() {
  const byPkg = new Map(); // pkg -> Set(token)
  for (const { pkg, dir } of allPackageSrcDirs()) {
    const defined = new Set();
    for (const file of listFiles(dir, ['.svelte', '.css'])) {
      collectDefinedInCss(readFileSync(file, 'utf8'), defined);
    }
    for (const file of listFiles(dir, ['.svelte', '.ts'])) {
      // Tests may set tokens to exercise components; they must not satisfy consumers.
      if (/__tests__|\.(test|spec)\./.test(file)) continue;
      collectSetFromCode(readFileSync(file, 'utf8'), defined);
    }
    byPkg.set(pkg, defined);
  }
  return byPkg;
}

/**
 * Override hooks: tokens a component reads as `var(--smrt-x, <default>)` so an
 * app can set them once in its own theme layer. Deliberately not emitted by any
 * preset (unset, the component keeps its stock look), so they are optional, not
 * required theme tokens. Keep this list explicit: a typo must still fail a check.
 */
export const OVERRIDE_HOOKS = new Set([
  '--smrt-card-background',
  '--smrt-card-border',
  '--smrt-card-divider',
  '--smrt-card-shadow',
  '--smrt-content-editor-icon-size',
  '--smrt-admin-shell-background',
  '--smrt-admin-shell-scrollbar-thumb',
  '--smrt-admin-shell-scrollbar-thumb-hover',
  '--smrt-admin-shell-scrollbar-track',
  // AdminShell insets (#3457): unset keeps the spacing-token defaults.
  '--smrt-admin-shell-band-padding-inline',
  '--smrt-admin-shell-left-rail-padding',
  '--smrt-admin-shell-left-rail-padding-collapsed',
  '--smrt-admin-shell-tenant-gap',
  '--smrt-shell-title-font-family',
  '--smrt-control-hit-size',
  '--smrt-popover-panel-padding',
  '--smrt-popover-panel-width',
  // SortableHeader knobs: set by a parent (JobList in another package) or by the app.
  '--smrt-sortable-header-padding',
  '--smrt-sortable-header-font-weight',
]);
