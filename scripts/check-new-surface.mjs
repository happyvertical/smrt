#!/usr/bin/env node
/**
 * New-surface gate (happyvertical/smrt#5076).
 *
 * Fails when smrt's public surface (a package, an `exports` key, a `_smrt_*`
 * system table, or an `@smrt()` model) exists in the working tree without a
 * `surface-ledger.json` entry recording what it was checked against. Compares
 * the tree to the ledger, never to a git base, so the pull request and the
 * merge queue get the same answer. Node-only: no build, no node_modules.
 *
 * Usage: node scripts/check-new-surface.mjs [--root DIR]
 * Regenerate the ledger: pnpm surface:ledger (docs/content/standards.md).
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildInventory,
  LEDGER_FILE,
  readLedger,
  template,
  validate,
} from './surface-ledger-lib.mjs';

const argv = process.argv.slice(2);
const rootFlag = argv.indexOf('--root');
const ROOT =
  rootFlag === -1
    ? join(dirname(fileURLToPath(import.meta.url)), '..')
    : argv[rootFlag + 1];

const ledger = readLedger(ROOT);
const failures = [...ledger.errors];
let missing = [];

if (ledger.errors.length === 0) {
  let inventory;
  try {
    inventory = buildInventory(ROOT);
  } catch (error) {
    console.error(`check-new-surface: cannot build the inventory: ${error.message}`);
    process.exit(1);
  }
  const result = validate(inventory, ledger.entries);
  failures.push(...result.problems);
  missing = result.missing;
}

if (missing.length === 0 && failures.length === 0) {
  console.log('check-new-surface: every package, entry point, system table and model is in the ledger.');
  process.exit(0);
}

console.error('check-new-surface: FAIL');
for (const item of missing)
  console.error(`\n  unrecorded ${item.kind}: ${item.name}\n  add this to ${LEDGER_FILE} and fill it in:\n${template(item).replace(/^/gm, '    ')}`);
for (const failure of failures) console.error(`\n  ${failure}`);
console.error(`
Before adding an entry, search for existing surface you could extend:
  node packages/smrt-dev-mcp/dist/index.js review --directory <pkg> --format summary
  rg -n "<noun>" ${LEDGER_FILE}
"nearest" must name entries already in the ledger; "reason" says why none was extended.`);
process.exit(1);
