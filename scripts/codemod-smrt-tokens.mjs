#!/usr/bin/env node
/**
 * Single `--smrt-*` token vocabulary codemod (issue #3822).
 *
 * Rewrites every legacy custom-property reference under `packages/*\/src` to the
 * `--smrt-*` vocabulary:
 *   - GLOBAL_MAP: legacy design tokens (`--color-*`, `--spacing-*`, `--radius-*`,
 *     `--transition-*`, Material `--md-sys-*`) → the matching `--smrt-*` token.
 *   - Component-private names (`--cv-border`, `--_box`, `--toast-inset`, ...) →
 *     `--smrt-<component>-<name>`, derived from the file that owns the rule. Cross-file
 *     and shared names are pinned in OVERRIDES / SLUG_OVERRIDES.
 *
 * Only these forms are rewritten, so the codemod never touches prose or CLI flags:
 *   `var(--name`, `--name:` (declaration, inline style included), `style:--name`,
 *   and a quoted `'--name'` / `"--name"` (setProperty / getPropertyValue / JS keys).
 *
 * Idempotent: rewritten names start with `smrt-`, which the codemod never matches,
 * so a second run is a no-op. Re-run it after a rebase instead of hand-merging.
 *
 * Usage:
 *   node scripts/codemod-smrt-tokens.mjs            # rewrite in place, print the table
 *   node scripts/codemod-smrt-tokens.mjs --check    # exit 1 if any file would change
 *   node scripts/codemod-smrt-tokens.mjs --dry-run  # print the table, write nothing
 *
 * The lint gate lives in scripts/check-smrt-token-vocabulary.mjs.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = join(ROOT, 'packages');
const CHECK = process.argv.includes('--check');
const DRY = CHECK || process.argv.includes('--dry-run');

/** Files the codemod never rewrites (token definitions are maintained by hand). */
const SKIP_FILES = new Set(['packages/smrt-ui/src/styles/tokens.css']);

const SKIP_DIRS = new Set(['node_modules', 'dist', '.svelte-kit', 'build', '.turbo']);

/**
 * Legacy global vocabulary → `--smrt-<value>`. Keys are exact legacy names (without `--`).
 * `md-sys-*` is handled by pattern in `globalTarget`.
 */
export const GLOBAL_MAP = {
  'color-primary': 'color-primary',
  'color-primary-main': 'color-primary',
  'color-primary-dark': 'color-primary',
  'color-primary-light': 'color-primary-container',
  'color-neutral-white': 'color-surface',
  'color-neutral-gray100': 'color-surface-variant',
  'color-neutral-gray200': 'color-surface-container-high',
  'color-neutral-gray300': 'color-outline-variant',
  'color-neutral-gray400': 'color-outline',
  'color-text-primary': 'color-on-surface',
  'color-text-secondary': 'color-on-surface-variant',
  'color-text-muted': 'color-on-surface-variant',
  'color-surface': 'color-surface',
  'color-surface-muted': 'color-surface-variant',
  'color-border': 'color-outline-variant',
  'color-focus': 'color-primary',
  'color-error': 'color-error',
  'color-error-text': 'color-error',
  'color-error-surface': 'color-error-container',
  'color-semantic-error': 'color-error',
  'spacing-xs': 'spacing-xs',
  'spacing-sm': 'spacing-sm',
  'spacing-md': 'spacing-md',
  'spacing-lg': 'spacing-lg',
  'spacing-xl': 'spacing-xl',
  'spacing-2xl': 'spacing-2xl',
  'spacing-3xl': 'spacing-3xl',
  'radius-sm': 'radius-sm',
  'radius-md': 'radius-md',
  'radius-lg': 'radius-lg',
  'radius-xl': 'radius-xl',
  'radius-full': 'radius-full',
  'transition-fast': 'duration-fast',
};

/** Name-level pins for component-private names shared by several files or with
 *  a semantically cleaner target than the derived `smrt-<component>-<name>`. */
const OVERRIDES = {
  'alert-color': 'smrt-alert-color',
  'badge-bg': 'smrt-badge-bg',
  'badge-text': 'smrt-badge-text',
  'badge-color': 'smrt-send-status-badge-color',
  'bar-color': 'smrt-confidence-badge-bar-color',
  'band-column': 'smrt-admin-shell-band-column',
  'edge-columns': 'smrt-admin-shell-edge-columns',
  'sortable-header-padding': 'smrt-sortable-header-padding',
  'sortable-header-font-weight': 'smrt-sortable-header-font-weight',
  'activity-ticker-duration': 'smrt-activity-ticker-duration',
  'collection-divider': 'smrt-collection-list-divider',
  'data-table-caption-height': 'smrt-data-table-caption-height',
  span: 'smrt-overview-grid-span',
  progress: 'smrt-progress-value',
};

/** Per-component pins, keyed by the component file's kebab-case basename. */
const SLUG_OVERRIDES = {
  'meeting-view': {
    'view-bg': 'smrt-meeting-view-bg',
    'view-border': 'smrt-meeting-view-border',
  },
  'day-view': {
    'view-bg': 'smrt-day-view-bg',
    'view-border': 'smrt-day-view-border',
  },
};

const NAME = '[a-zA-Z_][\\w-]*';

/** Forms that name a custom property. Each captures the bare name in group `name`. */
const FORMS = {
  var: new RegExp(`(var\\(\\s*)--(?<name>${NAME})(?![\\w-])`, 'g'),
  decl: new RegExp(`(?<![\\w-])--(?<name>${NAME})(?![\\w-])(?=\\s*:)`, 'g'),
  dir: new RegExp(`(style:)--(?<name>${NAME})(?![\\w-])`, 'g'),
  str: new RegExp(`(['"\`])--(?<name>${NAME})\\1`, 'g'),
};

function kebab(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase();
}

/** Global legacy name → smrt token name (no `--`), or null if not a legacy global. */
function globalTarget(name) {
  const md = /^md-sys-color-(.+)$/.exec(name);
  if (md) return `color-${md[1]}`;
  const elevation = /^md-sys-elevation-level(\d)$/.exec(name);
  if (elevation) return `elevation-${elevation[1]}`;
  const typescale = /^md-sys-typescale-(.+)$/.exec(name);
  if (typescale) return `typography-${typescale[1]}`;
  return Object.hasOwn(GLOBAL_MAP, name) ? GLOBAL_MAP[name] : null;
}

/** Component-private name → `smrt-<component>-<name>` for a `.svelte` file. */
function localTarget(file, name) {
  if (Object.hasOwn(OVERRIDES, name)) return OVERRIDES[name];
  const slug = kebab(basename(file, extname(file)));
  const pinned = SLUG_OVERRIDES[slug];
  if (pinned && Object.hasOwn(pinned, name)) return pinned[name];
  const base = name.replace(/^_+/, '');
  if (base.startsWith('cv-')) return `smrt-calendar-view-${base.slice(3)}`;
  if (base.startsWith(`${slug}-`)) return `smrt-${base}`;
  const segments = slug.split('-');
  for (let k = segments.length - 1; k >= 1; k--) {
    const prefix = segments.slice(0, k).join('-');
    if (base.startsWith(`${prefix}-`)) {
      return `smrt-${slug}-${base.slice(prefix.length + 1)}`;
    }
  }
  return `smrt-${slug}-${base}`;
}

function listFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, out);
    else if (/\.(svelte|css|ts|js|mjs|md)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function sourceFiles() {
  const files = [];
  if (!existsSync(PACKAGES)) return files;
  for (const pkg of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    // Package sources plus in-repo playgrounds, which demo the vocabulary to consumers.
    for (const root of ['src', 'playground/src']) {
      const dir = join(PACKAGES, pkg.name, root);
      if (existsSync(dir)) listFiles(dir, files);
    }
  }
  return files.filter((f) => !SKIP_FILES.has(relative(ROOT, f)));
}

const isComponent = (file) => /\.(svelte|css)$/.test(file);

/**
 * Pass A: which non-global, non-smrt names are component-private, and what does each
 * `.svelte`/`.css` file rename them to? A name that resolves to different targets in
 * different files cannot be rewritten in `.ts`/`.js` (the codemod leaves those alone).
 */
function collectLocalTargets(files) {
  const perName = new Map();
  for (const file of files) {
    if (!isComponent(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const re of Object.values(FORMS)) {
      for (const match of text.matchAll(re)) {
        const name = match.groups.name;
        if (name.startsWith('smrt-') || globalTarget(name) !== null) continue;
        if (!perName.has(name)) perName.set(name, new Map());
        perName.get(name).set(relative(ROOT, file), localTarget(file, name));
      }
    }
  }
  const consistent = new Map();
  for (const [name, byFile] of perName) {
    const targets = new Set(byFile.values());
    if (targets.size === 1) consistent.set(name, [...targets][0]);
  }
  return { perName, consistent };
}

/** Resolve a legacy name seen in `file`, or null if it must be left as-is. */
function resolveName(file, name, locals) {
  if (name.startsWith('smrt-')) return null;
  const global = globalTarget(name);
  if (global !== null) return `smrt-${global}`;
  if (extname(file) === '.md') return null;
  if (!locals.perName.has(name)) return null;
  if (isComponent(file)) return localTarget(file, name);
  // `.ts` / `.js` cannot know which component owns a name; only rewrite when every
  // component that declares it agrees on the target.
  return locals.consistent.get(name) ?? null;
}

/** Rewrite one file's text. Returns the new text and the (old → new) pairs applied. */
function rewriteText(file, text, locals) {
  const applied = [];
  const markdown = extname(file) === '.md';
  let out = text;
  for (const [kind, re] of Object.entries(FORMS)) {
    // Markdown prose only carries `var(--…)` examples for the global vocabulary.
    if (markdown && kind !== 'var') continue;
    out = out.replace(re, (...args) => {
      const groups = args.at(-1);
      const name = groups.name;
      const target = resolveName(file, name, locals);
      if (target === null || target === name) return args[0];
      applied.push([name, target]);
      const whole = args[0];
      const start = whole.indexOf(`--${name}`);
      return whole.slice(0, start) + `--${target}` + whole.slice(start + 2 + name.length);
    });
  }
  return { out, applied };
}

function main() {
  const files = sourceFiles();
  const locals = collectLocalTargets(files);
  const table = new Map();
  let changedFiles = 0;
  let changedRefs = 0;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const { out, applied } = rewriteText(file, text, locals);
    if (out === text) continue;
    changedFiles += 1;
    changedRefs += applied.length;
    for (const [from, to] of applied) {
      const key = `${from} → ${to}`;
      table.set(key, (table.get(key) ?? 0) + 1);
    }
    if (!DRY) writeFileSync(file, out);
    console.log(`${DRY ? 'would rewrite' : 'rewrote'} ${relative(ROOT, file)} (${applied.length})`);
  }
  const rows = [...table].sort((a, b) => b[1] - a[1]);
  console.log('\nMapping (refs rewritten):');
  for (const [key, count] of rows) console.log(`  ${String(count).padStart(4)}  ${key}`);
  console.log(`\n${changedRefs} references in ${changedFiles} files${DRY ? ' (dry run)' : ''}.`);
  if (CHECK && changedFiles > 0) {
    console.error('smrt token vocabulary is not up to date: run node scripts/codemod-smrt-tokens.mjs');
    process.exit(1);
  }
}

main();
