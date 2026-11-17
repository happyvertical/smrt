#!/usr/bin/env node
/**
 * Write `surface-ledger.json` (happyvertical/smrt#5076). Idempotent.
 *
 * Every item in the working-tree inventory that has no entry is added as
 * `{ kind, name, grandfathered: true }`; existing entries (including full,
 * non-grandfathered ones) are kept untouched. Entries for items that no longer
 * exist are dropped (a removed item simply loses its entry). Output is sorted
 * by kind then name, so a second run is byte-identical.
 *
 * Usage: pnpm surface:ledger   (node scripts/generate-surface-ledger.mjs [--root DIR])
 */
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildInventory,
  itemKey,
  LEDGER_FILE,
  readLedger,
  sortItems,
} from './surface-ledger-lib.mjs';

const argv = process.argv.slice(2);
const rootFlag = argv.indexOf('--root');
const ROOT =
  rootFlag === -1
    ? join(dirname(fileURLToPath(import.meta.url)), '..')
    : argv[rootFlag + 1];

const file = join(ROOT, LEDGER_FILE);
let existing = [];
if (existsSync(file)) {
  const ledger = readLedger(ROOT);
  if (ledger.errors.length > 0) {
    console.error(`generate-surface-ledger: ${ledger.errors.join('; ')}`);
    process.exit(1);
  }
  existing = ledger.entries;
}

const inventory = buildInventory(ROOT);
const byKey = new Map(existing.map((e) => [itemKey(e.kind, e.name), e]));
const entries = inventory.map(
  (item) =>
    byKey.get(itemKey(item.kind, item.name)) ?? {
      kind: item.kind,
      name: item.name,
      grandfathered: true,
    },
);
const body = `${JSON.stringify(sortItems(entries), null, 2)}\n`;
writeFileSync(file, body);
console.log(`generate-surface-ledger: wrote ${entries.length} entries to ${LEDGER_FILE}.`);
