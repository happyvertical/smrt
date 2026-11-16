#!/usr/bin/env node
/**
 * Runtime-managed database guardrail (happyvertical/smrt#4927).
 *
 * `declareRuntimeManagedDatabase(db, { owner, reason })` tells core's startup
 * check that a database handle builds its own schema, so the check does not
 * compare its migrate record with the build's stamp. That is an exemption from
 * a production safety check, so only the files listed below may use it. A new
 * caller is added here on purpose, with its reason, in the same change.
 *
 * The check fails when a package source file outside the list names
 * `declareRuntimeManagedDatabase` (a call, an import or an alias), and when a
 * listed file no longer does (a stale entry). Comments and string bodies are
 * ignored. Test files are not scanned: they exercise the API and never ship.
 *
 * Usage: node scripts/check-runtime-managed-databases.mjs [--root <dir>]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Files that may declare a runtime-managed database, each with its reason. */
export const ALLOWED_CALLERS = {
  'packages/app-shell/src/engine/app-runtime.ts':
    "The app-shell engine opens each app's app.db here (live, drafts, publish rehearsal, the read-only report worker) and builds its schema from the app definition; core's migrate never runs against it.",
};

/** Core's definition and its one re-export (the `/migrations` subpath); these name the API without using it. */
export const DEFINITION_FILES = new Set([
  'packages/core/src/migrations/runtime-managed-database.ts',
  'packages/core/src/migrations/index.ts',
]);

const NAME = 'declareRuntimeManagedDatabase';
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.svelte-kit',
  '.smrt',
  '__tests__',
  '__fixtures__',
  'fixtures',
  'test-support',
  'tests',
  'e2e',
]);
const SOURCE_FILE = /\.(?:[cm]?[jt]s|svelte)$/;
const TEST_FILE = /\.(test|spec|e2e)\.[cm]?[jt]s$|\.d\.ts$/;

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out);
    } else if (SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
}

/** Blank comments and string bodies so prose that names the API is not counted. */
export function stripNoise(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length))
    .replace(
      /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g,
      (m) => m[0] + m.slice(1, -1).replace(/[^\n]/g, ' ') + m[m.length - 1],
    );
}

/** Line numbers where the API is named in code. */
export function findUses(source) {
  const lines = [];
  const code = stripNoise(source);
  const re = new RegExp(`\\b${NAME}\\b`, 'g');
  for (const match of code.matchAll(re)) {
    lines.push(code.slice(0, match.index).split('\n').length);
  }
  return lines;
}

/** Every package source file that names the API, relative to `root`. */
export function scanPackages(root) {
  const files = [];
  const packagesDir = join(root, 'packages');
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkg = join(packagesDir, entry.name);
    for (const sub of ['src', 'bin', 'scripts']) {
      const dir = join(pkg, sub);
      try {
        if (statSync(dir).isDirectory()) walk(dir, files);
      } catch {
        // no such directory
      }
    }
  }
  const uses = new Map();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes(NAME)) continue;
    const lines = findUses(text);
    if (lines.length) uses.set(relative(root, file).split(sep).join('/'), lines);
  }
  return uses;
}

export function evaluate(uses, allowed = ALLOWED_CALLERS, definitions = DEFINITION_FILES) {
  const errors = [];
  for (const [file, lines] of uses) {
    if (definitions.has(file) || Object.hasOwn(allowed, file)) continue;
    for (const line of lines)
      errors.push(
        `${file}:${line} uses ${NAME}, which only the files listed in scripts/check-runtime-managed-databases.mjs may call. ` +
          'A database smrt migrates must not be declared runtime-managed; if this one builds its own schema, add the file to ALLOWED_CALLERS with its reason.',
      );
  }
  for (const file of Object.keys(allowed)) {
    if (!uses.has(file))
      errors.push(
        `${file} is allowed to use ${NAME} but no longer does; remove it from ALLOWED_CALLERS.`,
      );
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf('--root');
  const root = rootIndex >= 0 ? args[rootIndex + 1] : join(import.meta.dirname, '..');
  const errors = evaluate(scanPackages(root));
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exit(1);
  }
  console.log(
    `runtime-managed databases: ${Object.keys(ALLOWED_CALLERS).length} allowed caller(s), no others.`,
  );
}
