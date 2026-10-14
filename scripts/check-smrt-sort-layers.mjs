#!/usr/bin/env node
/** Structure/theme and owned-class ratchet. --write permits shrinking only. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { componentFiles, hasStructure, internalClasses, layerViolations,
  parseComponent, relativeFile, ROOT, TODO_MARKER } from './smrt-sort-layers-lib.mjs';

export const RATCHET = resolve(ROOT, 'scripts/smrt-sort-ratchet.json');

export function inspectFiles(files) {
  const entries = {};
  const errors = [];
  for (const [file, source] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    try {
      const ast = parseComponent(source);
      const styled = !!ast.css?.children.some((node) => node.block);
      const unsorted = styled && !hasStructure(ast.css);
      const count = internalClasses(ast).length;
      if (unsorted || count) entries[file] = { unsorted, internalClasses: count };
      for (const error of layerViolations(source, ast)) errors.push(`${file}: ${error}`);
      if (ast.css?.comments.some((comment) => source.slice(comment.start, comment.end).includes(TODO_MARKER))) {
        errors.push(`${file}: unresolved ${TODO_MARKER} comments; finish the TODO report before updating the ratchet`);
      }
    } catch (error) { errors.push(`${file}: ${error.message}`); }
  }
  return { snapshot: { version: 1, files: entries }, errors };
}

export function compareRatchet(current, baseline, { write = false } = {}) {
  if (baseline.version !== 1 || !baseline.files || Array.isArray(baseline.files)) return ['Invalid sort ratchet schema'];
  const errors = [];
  for (const [file, entry] of Object.entries(baseline.files)) {
    if (typeof entry.unsorted !== 'boolean' || !Number.isSafeInteger(entry.internalClasses) || entry.internalClasses < 0) {
      errors.push(`${file}: invalid ratchet entry`);
    }
  }
  for (const file of new Set([...Object.keys(current.files), ...Object.keys(baseline.files)])) {
    const now = current.files[file] ?? { unsorted: false, internalClasses: 0 };
    const old = baseline.files[file] ?? { unsorted: false, internalClasses: 0 };
    if (now.unsorted && !old.unsorted) errors.push(`${file}: sorted/new component regressed to unsorted`);
    if (now.internalClasses > old.internalClasses) errors.push(`${file}: un-namespaced internal classes grew (${old.internalClasses} -> ${now.internalClasses})`);
    if (!write && (now.unsorted !== old.unsorted || now.internalClasses !== old.internalClasses
      || !!current.files[file] !== !!baseline.files[file])) errors.push(`${file}: stale sort ratchet; run node scripts/check-smrt-sort-layers.mjs --write`);
  }
  return errors;
}

function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => !['--write', '--check'].includes(arg)) || (args.includes('--write') && args.includes('--check'))) {
    throw new Error('Usage: node scripts/check-smrt-sort-layers.mjs [--check | --write]');
  }
  const write = args.includes('--write');
  const files = Object.fromEntries(componentFiles().map((file) => [relativeFile(file), readFileSync(file, 'utf8')]));
  const { snapshot, errors } = inspectFiles(files);
  if (existsSync(RATCHET)) errors.push(...compareRatchet(snapshot, JSON.parse(readFileSync(RATCHET, 'utf8')), { write }));
  else if (!write) errors.push('Missing sort ratchet; run with --write to initialize it');
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
    return;
  }
  if (write) writeFileSync(RATCHET, `${JSON.stringify(snapshot, null, 2)}\n`);
  const entries = Object.values(snapshot.files);
  console.log(`smrt sort: ${Object.keys(files).length} components; ${entries.filter((entry) => entry.unsorted).length} unsorted; ${entries.reduce((sum, entry) => sum + entry.internalClasses, 0)} distinct un-namespaced owned classes; ratchet ${write ? 'written' : 'current'}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
