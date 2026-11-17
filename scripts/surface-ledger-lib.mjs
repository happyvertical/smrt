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
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const KINDS = ['package', 'entry-point', 'system-table', 'model'];
export const LEDGER_FILE = 'surface-ledger.json';

const SCHEMA_FILE = join('packages', 'core', 'src', 'system', 'schema.ts');
const SKIPPED_DIRS = new Set([
  'node_modules',
  'dist',
  '.svelte-kit',
  '__tests__',
  '__fixtures__',
  'fixtures',
  'tests',
  'test',
]);

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
  const text = readFileSync(file, 'utf8');
  const names = new Set();
  for (const m of text.matchAll(
    /^[ \t]*CREATE TABLE(?: IF NOT EXISTS)?[ \t]+(_smrt_[A-Za-z0-9_]+)/gm,
  )) {
    names.add(m[1]);
  }
  return [...names];
}

/**
 * Blank comments, string literals and template-literal text (keeping newlines
 * and length) so a decorator mentioned in prose or generated-code text is never
 * mistaken for a real one.
 */
export function blankNonCode(src) {
  const out = src.split('');
  const n = src.length;
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  let prev = ''; // last significant (non-space) code character
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
      prev = c;
    } else if (c === '`') {
      let j = i + 1;
      let depth = 0;
      while (j < n) {
        if (src[j] === '\\') j += 2;
        else if (depth === 0 && src[j] === '`') break;
        else if (src[j] === '$' && src[j + 1] === '{') {
          depth++;
          j += 2;
        } else if (depth > 0 && src[j] === '}') {
          depth--;
          j++;
        } else j++;
      }
      blank(i + 1, j);
      i = j + 1;
      prev = '`';
    } else if (c === '/' && (prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev))) {
      // Regex literal: blank so quotes inside do not open a string.
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') j += 2;
        else if (src[j] === '[') {
          inClass = true;
          j++;
        } else if (src[j] === ']') {
          inClass = false;
          j++;
        } else if (src[j] === '/' && !inClass) break;
        else j++;
      }
      blank(i + 1, j);
      i = j + 1;
      prev = '/';
    } else {
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  }
  return out.join('');
}

/** Local names `smrt` is imported under (`import { smrt as x }`), plus `smrt`. */
function decoratorNames(code) {
  const names = new Set(['smrt']);
  for (const m of code.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from/g)) {
    for (const part of m[1].split(',')) {
      const am = part.trim().match(/^smrt\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (am) names.add(am[1]);
    }
  }
  return names;
}

/** Index just past the `)` closing the `(` at `open` (code is blanked). */
function skipParens(code, open) {
  let depth = 0;
  for (let k = open; k < code.length; k++) {
    if (code[k] === '(') depth++;
    else if (code[k] === ')' && --depth === 0) return k + 1;
  }
  return -1;
}

/** Class names carrying an `@smrt` decorator in one source file. */
export function modelsInSource(src) {
  const code = blankNonCode(src);
  const names = decoratorNames(code);
  const alt = [...names].map((s) => s.replace(/\$/g, '\\$')).join('|');
  const found = [];
  const re = new RegExp(`@(?:${alt})(?![\\w$])`, 'g');
  for (const m of code.matchAll(re)) {
    let k = m.index + m[0].length;
    const skipWs = () => {
      while (k < code.length && /\s/.test(code[k])) k++;
    };
    skipWs();
    if (code[k] === '(') {
      k = skipParens(code, k);
      if (k === -1) continue;
    }
    // Further stacked decorators, then modifiers, then the class name.
    for (;;) {
      skipWs();
      const dm = /^@[A-Za-z_$][\w$.]*/.exec(code.slice(k, k + 200));
      if (!dm) break;
      k += dm[0].length;
      skipWs();
      if (code[k] === '(') {
        k = skipParens(code, k);
        if (k === -1) break;
      }
    }
    if (k === -1) continue;
    const cm = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:declare\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(
      code.slice(k, k + 300),
    );
    if (cm) found.push(cm[1]);
    else
      throw new Error(
        `@smrt decorator at offset ${m.index} is not followed by a class declaration`,
      );
  }
  return found;
}

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      yield* sourceFiles(join(dir, entry.name));
    } else if (
      /\.(ts|mts|tsx)$/.test(entry.name) &&
      !/\.(d|test|spec)\.(ts|mts|tsx)$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts')
    ) {
      yield join(dir, entry.name);
    }
  }
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
