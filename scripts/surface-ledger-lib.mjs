/**
 * Surface inventory and ledger validation shared by `check-new-surface.mjs`
 * and `generate-surface-ledger.mjs` (happyvertical/smrt#5076).
 *
 * The inventory is read from the working tree only (no build, no git history,
 * no node_modules), so it answers the same on a pull request and in the merge
 * queue. Four kinds of surface are inventoried:
 *
 * - `package`      every `packages/*\/package.json` name
 * - `entry-point`  every key of a package `exports` map, `<package>#<key>`
 * - `system-table` every `_smrt_*` table CREATEd in
 *                  `packages/core/src/system/schema.ts`
 * - `model`        every `@smrt()`-decorated class in package sources,
 *                  `<package>:<Class>`
 * - `export`       every name in a committed root export snapshot
 *                  (`packages/*\/api/*.exports.json`, the root entry `.` and
 *                  its browser condition), `<package>#.:<Name>`. Ledger-optional:
 *                  the export snapshot gate already shows every new name, so an
 *                  entry is recorded for a name added to an existing root and
 *                  validated like any other, but a name without one is not
 *                  reported missing.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { modelsInSource, sourceFiles } from './smrt-model-scan.mjs';

export const KINDS = ['package', 'entry-point', 'system-table', 'model', 'export'];
/** Kinds whose inventory items need no ledger entry (see `export` above). */
export const OPTIONAL_KINDS = ['export'];
export const LEDGER_FILE = 'surface-ledger.json';

/** Names in a package's committed root export snapshots. */
function exportsOfPackage(pkg) {
  const apiDir = join(pkg.dir, 'api');
  if (!existsSync(apiDir)) return [];
  const names = new Set();
  for (const file of readdirSync(apiDir).sort()) {
    if (!file.endsWith('.exports.json')) continue;
    let snapshot;
    try {
      snapshot = JSON.parse(readFileSync(join(apiDir, file), 'utf8'));
    } catch (error) {
      throw new Error(`${join(apiDir, file)} is not valid JSON: ${error.message}`);
    }
    for (const row of snapshot.exports ?? [])
      if (typeof row?.name === 'string') names.add(row.name);
  }
  return [...names];
}

const SCHEMA_FILE = join('packages', 'core', 'src', 'system', 'schema.ts');
export const itemKey = (kind, name) => `${kind}\u0000${name}`;

function readPackages(root) {
  const dir = join(root, 'packages');
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgPath = join(dir, entry.name, 'package.json');
    if (!existsSync(pkgPath)) continue;
    let json;
    try {
      json = JSON.parse(readFileSync(pkgPath, 'utf8'));
    } catch (error) {
      throw new Error(`${pkgPath} is not valid JSON: ${error.message}`);
    }
    if (typeof json.name !== 'string' || json.name === '') continue;
    found.push({ dir: join(dir, entry.name), json });
  }
  return found.sort((a, b) => a.json.name.localeCompare(b.json.name));
}

/** `_smrt_*` tables declared by `CREATE TABLE` statements in core's schema.ts. */
export function systemTables(root) {
  const file = join(root, SCHEMA_FILE);
  if (!existsSync(file)) return [];
  // Comments blanked so prose that mentions a CREATE TABLE is not a declaration;
  // the statement may start anywhere on a line (e.g. right after the backtick).
  const text = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\])(\/\/|--)[^\n]*/gm, (m, p) => p + ' '.repeat(m.length - p.length));
  const names = new Set();
  // Any SQL whitespace (newlines included) between keywords and name, any
  // keyword case, and an optionally quoted / schema-qualified name.
  for (const m of text.matchAll(
    /\bCREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:[A-Za-z_]\w*\s*\.\s*)?["`\[]?(_smrt_[A-Za-z0-9_]+)/gim,
  )) {
    names.add(m[1]);
  }
  return [...names];
}

function modelsOfPackage(pkg) {
  const srcDir = join(pkg.dir, 'src');
  if (!existsSync(srcDir)) return [];
  const names = new Set();
  for (const file of sourceFiles(srcDir)) {
    const src = readFileSync(file, 'utf8');
    if (!src.includes('smrt')) continue;
    try {
      for (const n of modelsInSource(src)) names.add(n);
    } catch (error) {
      throw new Error(`${file}: ${error.message}`);
    }
  }
  return [...names];
}

/** Every surface item in the working tree, sorted and de-duplicated. */
export function buildInventory(root, { models = true } = {}) {
  const items = new Map();
  const add = (kind, name) => items.set(itemKey(kind, name), { kind, name });
  const packages = readPackages(root);
  for (const pkg of packages) {
    const { name, exports } = pkg.json;
    add('package', name);
    const keys =
      exports && typeof exports === 'object' && !Array.isArray(exports)
        ? Object.keys(exports)
        : typeof exports === 'string' || Array.isArray(exports)
          ? ['.']
          : [];
    // A conditions-only map (`{ import, default }`) is the "." entry point.
    const isConditions = keys.length > 0 && keys.every((k) => !k.startsWith('.'));
    for (const key of isConditions ? ['.'] : keys) add('entry-point', `${name}#${key}`);
    if (models) for (const cls of modelsOfPackage(pkg)) add('model', `${name}:${cls}`);
    for (const exported of exportsOfPackage(pkg)) add('export', `${name}#.:${exported}`);
  }
  for (const table of systemTables(root)) add('system-table', table);
  return sortItems([...items.values()]);
}

export function sortItems(list) {
  const rank = (k) => KINDS.indexOf(k);
  return [...list].sort(
    (a, b) =>
      rank(a.kind) - rank(b.kind) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
}

/** Parse the ledger file; returns `{ entries, errors }`. */
export function readLedger(root) {
  const file = join(root, LEDGER_FILE);
  if (!existsSync(file)) return { entries: [], errors: [`${LEDGER_FILE} does not exist`] };
  let json;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return { entries: [], errors: [`${LEDGER_FILE} is not valid JSON: ${error.message}`] };
  }
  const list = Array.isArray(json) ? json : json?.entries;
  if (!Array.isArray(list))
    return { entries: [], errors: [`${LEDGER_FILE} must be an array or { "entries": [...] }`] };
  return { entries: list, errors: [] };
}

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/** Hint block printed under a missing-entry failure. */
export function template(item) {
  return JSON.stringify(
    {
      kind: item.kind,
      name: item.name,
      issue: 0,
      nearest: ['<existing ledger name you checked>'],
      reason: '<why the nearest surface was not extended>',
    },
    null,
    2,
  );
}

/** Validate ledger entries against the inventory. Returns problems as strings. */
export function validate(inventory, entries, { models = true } = {}) {
  const problems = [];
  const missing = [];
  const present = new Map();
  entries.forEach((entry, idx) => {
    const where = `entry #${idx + 1}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`${where} is not an object`);
      return;
    }
    if (!KINDS.includes(entry.kind)) {
      problems.push(`${where} has unknown kind ${JSON.stringify(entry.kind)} (name ${JSON.stringify(entry.name)})`);
      return;
    }
    if (!isNonEmptyString(entry.name)) {
      problems.push(`${where} (${entry.kind}) has no name`);
      return;
    }
    const key = itemKey(entry.kind, entry.name);
    if (present.has(key)) {
      problems.push(`duplicate ledger entry for ${entry.kind} ${entry.name}`);
      return;
    }
    present.set(key, entry);
  });

  const inventoryKeys = new Set(inventory.map((i) => itemKey(i.kind, i.name)));
  for (const item of inventory) {
    if (OPTIONAL_KINDS.includes(item.kind)) continue;
    if (!present.has(itemKey(item.kind, item.name))) missing.push(item);
  }
  for (const [key, entry] of present) {
    if (!models && entry.kind === 'model') continue;
    if (!inventoryKeys.has(key))
      problems.push(
        `stale ledger entry: ${entry.kind} ${entry.name} no longer exists; delete its entry`,
      );
  }
  const ledgerNames = new Set([...present.values()].map((e) => e.name));
  for (const entry of present.values()) {
    if (entry.grandfathered === true) continue;
    const id = `${entry.kind} ${entry.name}`;
    if (!Number.isInteger(entry.issue) || entry.issue <= 0)
      problems.push(`${id}: "issue" must be a positive integer`);
    if (!isNonEmptyString(entry.reason)) problems.push(`${id}: "reason" must be a non-empty string`);
    if (!Array.isArray(entry.nearest)) {
      problems.push(`${id}: "nearest" is required (an array of existing ledger names)`);
    } else if (entry.nearest.length === 0) {
      if (!isNonEmptyString(entry.noneBecause))
        problems.push(`${id}: empty "nearest" needs a non-empty "noneBecause"`);
    } else {
      for (const near of entry.nearest) {
        if (!isNonEmptyString(near) || !ledgerNames.has(near))
          problems.push(`${id}: "nearest" names ${JSON.stringify(near)}, which is not in the ledger`);
        else if (near === entry.name)
          problems.push(`${id}: "nearest" cannot name the item itself`);
      }
    }
  }
  return { problems, missing };
}
