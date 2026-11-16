#!/usr/bin/env node
/**
 * Direct model construction guardrail (happyvertical/smrt#4931, policy rule 3).
 *
 * smrt's collections build the app's same-named subclass of a model
 * (`ObjectRegistry.getEffectiveClassByConstructor()` via the collection's
 * `resolveItemConstructor()`, #4939). A package source file that writes
 * `new Model(...)` for a registered model skips that lookup, so the app's class
 * and its rules never apply to the object.
 *
 * A "registered model" here is a class decorated with `@smrt(` in a package
 * `src/` tree, plus any class that extends one. The check flags `new Model(` in
 * non-test package sources when the file imports or declares that class.
 *
 * Fix the call: use the collection's `create()` (or `createUnsaved()`), or a
 * registry-resolved constructor where no collection fits. Do not add to the
 * baseline: `scripts/direct-model-construction-baseline.json` may only shrink,
 * and every entry states why the direct call must stay.
 *
 * Usage: node scripts/check-direct-model-construction.mjs [--root <dir>] [--list]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
const ROOT =
  rootIndex >= 0 ? args[rootIndex + 1] : join(import.meta.dirname, '..');
const LIST = args.includes('--list');
const baselineIndex = args.indexOf('--baseline');
const BASELINE_PATH =
  baselineIndex >= 0
    ? args[baselineIndex + 1]
    : join(import.meta.dirname, 'direct-model-construction-baseline.json');

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
const TEST_FILE = /\.(test|spec|e2e)\.[cm]?[jt]s$|\.d\.ts$/;

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out);
    } else if (/\.[cm]?ts$/.test(entry.name) && !TEST_FILE.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
}

/** Drop comments and string bodies so `new X(` inside prose is not counted. */
function stripNoise(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
}

const files = [];
const packagesDir = join(ROOT, 'packages');
for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const src = join(packagesDir, entry.name, 'src');
  try {
    if (statSync(src).isDirectory()) walk(src, files);
  } catch {
    // package without src/
  }
}

/** Blank string and template bodies so `new X(` inside text is not counted. */
function stripStrings(source) {
  return source.replace(
    /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g,
    (m) => m[0] + m.slice(1, -1).replace(/[^\n]/g, ' ') + m[m.length - 1],
  );
}

const sources = new Map(); // comments removed; imports still readable
const code = new Map(); // comments and string bodies removed
for (const file of files) {
  const text = stripNoise(readFileSync(file, 'utf8'));
  sources.set(file, text);
  code.set(file, stripStrings(text));
}

// Pass 1: registered models (decorated with @smrt) and their subclasses.
const classRe = /\bclass\s+([A-Z]\w*)(?:\s*<[^{]*?>)?(?:\s+extends\s+([A-Z]\w*))?/g;
function addDeclaration(name, file) {
  if (!modelFiles.has(name)) modelFiles.set(name, new Set());
  modelFiles.get(name).add(file);
}
const models = new Set();
const modelFiles = new Map(); // name -> files declaring a model of that name
const parents = [];
for (const [file, text] of code) {
  for (const match of text.matchAll(classRe)) {
    const [, name, parent] = match;
    const before = text.slice(0, match.index);
    const boundary = Math.max(before.lastIndexOf('\n}\n'), before.lastIndexOf(';\n'));
    if (/@smrt\s*\(/.test(before.slice(boundary < 0 ? 0 : boundary))) {
      models.add(name);
      addDeclaration(name, file);
    } else if (parent) {
      parents.push([name, parent, file]);
    }
  }
}
for (let changed = true; changed; ) {
  changed = false;
  for (const [name, parent, file] of parents) {
    if (models.has(parent) && !modelFiles.get(name)?.has(file)) {
      models.add(name);
      addDeclaration(name, file);
      changed = true;
    }
  }
}

/**
 * A relative import counts when the module it resolves to declares a model of
 * that name, or declares nothing of that name (a re-export barrel). A module
 * that declares a plain class of the same name is a different class.
 */
function relativeImportIsModel(specifier, name, fromFile) {
  const base = resolve(dirname(fromFile), specifier.replace(/\.[cm]?js$/, ''));
  for (const candidate of [
    `${base}.ts`,
    `${base}.svelte.ts`,
    join(base, 'index.ts'),
    base,
  ]) {
    const text = code.get(candidate);
    if (text === undefined) continue;
    if (new RegExp(`\\bclass\\s+${name}\\b`).test(text)) {
      return modelFiles.get(name)?.has(candidate) === true;
    }
    return true;
  }
  return true;
}

/**
 * True when `name` is declared here or imported from a smrt/relative module.
 * An import from a third-party package (for example undici's `Agent`) is not
 * the registered model even when the names match.
 */
function isModelSpecifier(specifier, name, file) {
  if (specifier.startsWith('.')) return relativeImportIsModel(specifier, name, file);
  return /^\$lib\/|^@happyvertical\/smrt-/.test(specifier);
}

function importsOrDeclares(text, name, file) {
  if (new RegExp(`\\bclass\\s+${name}\\b`).test(text)) {
    return modelFiles.get(name)?.has(file) === true;
  }
  const dynamicRe = new RegExp(
    `\\{[^}]*\\b${name}\\b[^}]*\\}\\s*=\\s*await\\s+import\\(\\s*['"]([^'"]+)['"]`,
    'g',
  );
  for (const match of text.matchAll(dynamicRe)) {
    if (isModelSpecifier(match[1], name, file)) return true;
  }
  const importRe = /\bimport\s+(?:type\s+)?([^;]*?)\s+from\s+['"]([^'"]+)['"]/g;
  for (const match of text.matchAll(importRe)) {
    const [, clause, specifier] = match;
    if (!new RegExp(`\\b${name}\\b`).test(clause)) continue;
    if (isModelSpecifier(specifier, name, file)) return true;
  }
  return false;
}

// Pass 2: `new Model(` where the file imports or declares Model.
const found = new Map(); // "file|Model" -> count
const newRe = /\bnew\s+([A-Z]\w*)\s*(?:<[^()]*?>)?\s*\(/g;
for (const [file, text] of code) {
  const rel = relative(ROOT, file).split('\\').join('/');
  for (const match of text.matchAll(newRe)) {
    const name = match[1];
    if (!models.has(name)) continue;
    if (!importsOrDeclares(sources.get(file), name, file)) continue;
    const key = `${rel}|${name}`;
    found.set(key, (found.get(key) ?? 0) + 1);
  }
}

if (LIST) {
  for (const [key, count] of [...found].sort()) console.log(`${count}\t${key}`);
  process.exit(0);
}

let baseline = [];
try {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).entries ?? [];
} catch {
  baseline = [];
}
const allowed = new Map(baseline.map((e) => [`${e.file}|${e.model}`, e]));

const problems = [];
for (const [key, count] of found) {
  const entry = allowed.get(key);
  const [file, model] = key.split('|');
  if (!entry) {
    problems.push(
      `${file}: new ${model}(...) x${count} builds the model directly. Use the collection's create(), or a registry-resolved constructor.`,
    );
  } else if (count > entry.count) {
    problems.push(
      `${file}: new ${model}(...) went from ${entry.count} to ${count}. The baseline may only shrink.`,
    );
  }
}
for (const [key, entry] of allowed) {
  const actual = found.get(key) ?? 0;
  if (!entry.reason || String(entry.reason).trim() === '') {
    problems.push(`baseline entry ${key} has no reason.`);
  }
  if (actual < entry.count) {
    problems.push(
      `baseline entry ${key} says ${entry.count} but only ${actual} remain. Lower it in scripts/direct-model-construction-baseline.json.`,
    );
  }
}

if (problems.length > 0) {
  console.error('Direct model construction check failed (#4931):\n');
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    '\nSmrt collections build the app subclass of a model. A direct `new Model(...)` skips that. Fix the call; do not grow the baseline.',
  );
  process.exit(1);
}
const total = [...found.values()].reduce((a, b) => a + b, 0);
console.log(
  `check-direct-model-construction: ok (${models.size} models, ${total} baselined direct call(s)).`,
);
