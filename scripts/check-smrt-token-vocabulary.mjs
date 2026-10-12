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

import { readFileSync, readdirSync } from 'node:fs';
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

const violations = main();
if (violations.length === 0) {
  console.log('smrt token vocabulary: clean (every custom property uses --smrt-*).');
  process.exit(0);
}

for (const v of violations) {
  const legacy = /^(color|spacing)-/.test(v.name) ? ' (legacy vocabulary)' : '';
  console.error(
    `${v.file}:${v.line}: ${v.label} uses --${v.name}${legacy}; use a --smrt-* token or --smrt-<component>-<name>`,
  );
}
console.error(
  `\n${violations.length} non-smrt custom propert${violations.length === 1 ? 'y' : 'ies'}. ` +
    'Run `node scripts/codemod-smrt-tokens.mjs` for legacy names.',
);
process.exit(1);
