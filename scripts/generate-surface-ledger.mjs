#!/usr/bin/env node
/**
 * Maintain `surface-ledger.json` (happyvertical/smrt#5076). Idempotent.
 *
 * - No ledger file (bootstrap): writes every inventory item as
 *   `{ kind, name, grandfathered: true }`.
 * - Existing ledger: NEVER adds an entry. It drops entries for items that no
 *   longer exist, re-sorts, and for each unrecorded item prints the full entry
 *   to fill in by hand, then exits 1. New surface needs a full entry; it cannot
 *   be grandfathered.
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
  template,
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
const exists = new Set(inventory.map((i) => itemKey(i.kind, i.name)));
const bootstrap = !existsSync(file);
const byKey = new Map(existing.map((e) => [itemKey(e.kind, e.name), e]));
const missing = bootstrap
  ? []
  : inventory.filter((i) => !byKey.has(itemKey(i.kind, i.name)));
const entries = bootstrap
  ? inventory.map((i) => ({ kind: i.kind, name: i.name, grandfathered: true }))
  : existing.filter((e) => exists.has(itemKey(e.kind, e.name)));
writeFileSync(file, `${JSON.stringify(sortItems(entries), null, 2)}\n`);
console.log(
  `generate-surface-ledger: wrote ${entries.length} entries to ${LEDGER_FILE}${bootstrap ? ' (bootstrap, grandfathered)' : ''}.`,
);
if (missing.length > 0) {
  console.error(
    `\ngenerate-surface-ledger: ${missing.length} item(s) are not in the ledger. New surface needs a full entry; add each by hand (search for existing surface first):`,
  );
  for (const item of missing) console.error(`\n${template(item)}`);
  process.exit(1);
}
