#!/usr/bin/env node
/**
 * Every relative import in a package's built `dist/svelte/**` must resolve to a
 * file that is actually in `dist`.
 *
 * `svelte-package` copies components verbatim, so a runtime import such as
 * `../../publish-policy.js` is only satisfied if the library (vite) build also
 * emitted that file. Vite inlines modules that are not an entry, which left
 * smrt-social 0.62.2 with a component importing a file that was never published.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TYPE_ONLY = /\b(?:import|export)\s+type\b[^;]*?\bfrom\s*(['"])[^'"]+\1\s*;?/gs;
const EXTENSIONS = ['', '.js', '.mjs', '.svelte', '.svelte.js', '.json', '/index.js'];
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]+)\1/g;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.(svelte|js)$/.test(name)) yield path;
  }
}

/** Relative specifiers in `file` that do not resolve to an existing file. */
export function unresolvedImports(file, source = readFileSync(file, 'utf8')) {
  const missing = [];
  // Type-only imports are erased before anything runs, so they need no file.
  const runtime = source.replace(TYPE_ONLY, '');
  for (const match of runtime.matchAll(SPECIFIER)) {
    const base = resolve(dirname(file), match[2].replace(/[?#].*$/, ''));
    const found = EXTENSIONS.some((ext) => existsSync(base + ext) && statSync(base + ext).isFile());
    if (!found) missing.push(match[2]);
  }
  return missing;
}

export function checkDistSvelte(distSvelteDir) {
  const problems = [];
  for (const file of walk(distSvelteDir)) {
    for (const specifier of unresolvedImports(file)) problems.push({ file, specifier });
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const packagesDir = join(ROOT, 'packages');
  const problems = [];
  let checked = 0;
  for (const name of readdirSync(packagesDir)) {
    const dir = join(packagesDir, name, 'dist', 'svelte');
    if (!existsSync(dir)) continue;
    checked += 1;
    problems.push(...checkDistSvelte(dir));
  }
  if (problems.length) {
    for (const { file, specifier } of problems) {
      console.error(`${file.replace(`${ROOT}/`, '')}: relative import "${specifier}" does not resolve inside dist`);
    }
    console.error('Add the module as a library build entry (vite `entries`) or import it from an emitted entry.');
    process.exit(1);
  }
  console.log(`check-svelte-dist-imports: ${checked} packages with dist/svelte, every relative import resolves.`);
}
