#!/usr/bin/env node
/** Strict structure/theme and owned-class gate. No ratchet debt is permitted. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { componentFiles, hasStructure, internalClasses, layerViolations,
  parseComponent, relativeFile, ROOT, TODO_MARKER } from './smrt-sort-layers-lib.mjs';

export function inspectFiles(files) {
  const errors = [];
  for (const [file, source] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    try {
      const ast = parseComponent(source);
      const styled = !!ast.css?.children.some((node) => node.block);
      const unsorted = styled && !hasStructure(ast.css);
      if (unsorted) errors.push(`${file}: unsorted component; add smrt.structure and sort declarations`);
      for (const name of internalClasses(ast, file)) errors.push(`${file}: un-namespaced owned class ${name}`);
      for (const error of layerViolations(source, ast)) errors.push(`${file}: ${error}`);
      if (ast.css?.comments.some((comment) => source.slice(comment.start, comment.end).includes(TODO_MARKER))) {
        errors.push(`${file}: unresolved ${TODO_MARKER} comments; finish role review before passing the gate`);
      }
    } catch (error) { errors.push(`${file}: ${error.message}`); }
  }
  return { errors };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== '--check')) throw new Error('Usage: node scripts/check-smrt-sort-layers.mjs [--check]');
  const files = Object.fromEntries(componentFiles().map((file) => [relativeFile(file), readFileSync(file, 'utf8')]));
  const { errors } = inspectFiles(files);
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log(`smrt sort: ${Object.keys(files).length} components; 0 unsorted; 0 un-namespaced owned classes outside documented exceptions`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
