#!/usr/bin/env node
/**
 * Rule 2 check (happyvertical/smrt#4930, policy #4920): shape is declared only
 * in what an app registers with smrt, never in the live database. A package
 * that creates, alters or drops a table with hand-written SQL declares shape
 * somewhere else.
 *
 * What this script does:
 *   - Reads `packages/<pkg>/src/**\/*.{ts,tsx,js,mjs}` (tests and generated
 *     files excluded), ignores comments, and finds `CREATE TABLE`,
 *     `ALTER TABLE` and `DROP TABLE` statements.
 *   - Skips the migrator and schema code (MIGRATOR_PATHS) and core's
 *     hand-written `_smrt_*` system tables (SYSTEM_TABLE_PATHS). Both lists
 *     are in this file, each with its reason, so growing one shows in review.
 *   - Fails on any other statement that is not in
 *     `scripts/hand-written-ddl-baseline.json`, naming the file and line.
 *   - The baseline lists today's occurrences, per file and statement. It may
 *     only shrink: an entry with nothing behind it is stale and fails until
 *     `--prune` removes it. Nothing here ever adds an entry.
 *   - `--against <git ref>` also fails when the baseline holds more than the
 *     ref's baseline.
 *
 * Usage: node scripts/check-hand-written-ddl.mjs [--prune | --init]
 *        [--against <ref>] [--root <repo root>]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileAtRef, maskComments, matchBracket, walk } from './lib/source-scan.mjs';

const BASELINE_PATH = 'scripts/hand-written-ddl-baseline.json';

/** Code whose job is to change the schema: the migrator and the schema generator. */
export const MIGRATOR_PATHS = [
  ['packages/core/src/migrations/', 'the migrator'],
  ['packages/core/src/schema/', 'the schema generator and schema manager'],
  ['packages/core/src/registry/schema-builder.ts', 'builds the schema the migrator applies'],
  ['packages/core/src/runtime-model.ts', 'plans run-time model statements (planRuntimeModelDDL)'],
  ['packages/cli/src/commands/db-', 'the db:* commands'],
  ['packages/cli/src/commands/utilities.ts', 'the db:migrate command'],
];

/** Core's hand-written `_smrt_*` system tables, the known legitimate case. */
export const SYSTEM_TABLE_PATHS = [
  ['packages/core/src/system/', 'hand-written _smrt_* system tables and their compatibility checks'],
];

const STATEMENT =
  /\b(CREATE|ALTER|DROP)\s+(?:(?:GLOBAL\s+|LOCAL\s+)?(?:TEMP|TEMPORARY)\s+|VIRTUAL\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:ONLY\s+)?/gi;

/** The table token after the verb: a quoted name, a `${...}` expression, or a bare name. */
function tableToken(src, at) {
  let i = at;
  let token = '';
  for (;;) {
    // `\"name\"`: a quoted name inside a double-quoted JS string.
    if (src[i] === '\\' && src[i + 1] === '"' && (token === '' || token.endsWith('.'))) {
      const close = src.indexOf('\\"', i + 2);
      if (close === -1) break;
      token += `"${src.slice(i + 2, close)}"`;
      i = close + 2;
      continue;
    }
    const c = src[i];
    if (c === '$' && src[i + 1] === '{') {
      const close = matchBracket(src, i + 1);
      if (close === -1) break;
      token += src.slice(i, close + 1);
      i = close + 1;
    } else if (c === '"' && (token === '' || token.endsWith('.'))) {
      const close = src.indexOf('"', i + 1);
      if (close === -1) break;
      token += src.slice(i, close + 1);
      i = close + 1;
    } else if (c !== undefined && /[\w.]/.test(c)) {
      token += c;
      i++;
    } else break;
    if (token.length > 80) break;
  }
  return token.replace(/\s+/g, ' ') || '?';
}

/** `{ verb, table, line }` for each statement in `source`. */
export function findStatements(source) {
  const src = maskComments(source);
  const found = [];
  STATEMENT.lastIndex = 0;
  for (let m = STATEMENT.exec(src); m; m = STATEMENT.exec(src)) {
    const table = tableToken(src, m.index + m[0].length);
    // No table name follows: prose such as "failed to create table 'x'".
    if (table === '?') continue;
    found.push({
      verb: m[1].toUpperCase(),
      table,
      line: source.slice(0, m.index).split('\n').length,
    });
  }
  return found;
}

function isGenerated(source) {
  return /DO NOT EDIT|Auto-generated|@generated/.test(source.slice(0, 600));
}

function isScanned(rel, pkg) {
  const inPkg = rel.slice(`packages/${pkg}/`.length);
  return (
    /\.(?:ts|tsx|js|mjs)$/.test(inPkg) &&
    !inPkg.endsWith('.d.ts') &&
    !/(?:^|\/)(?:node_modules|dist|__tests__|__mocks__|__test-[^/]*|fixtures|test-fixtures)\//.test(inPkg) &&
    !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(inPkg) &&
    !/\.(?:optional\.test)\.[jt]s$/.test(inPkg)
  );
}

function exemption(rel) {
  for (const [prefix] of [...MIGRATOR_PATHS, ...SYSTEM_TABLE_PATHS]) {
    if (rel === prefix || rel.startsWith(prefix)) return prefix;
  }
  return undefined;
}

/** All statements outside the exempt code, grouped by baseline key. */
export function scanPackages(root) {
  const byKey = new Map();
  const packagesDir = join(root, 'packages');
  for (const pkg of readdirSync(packagesDir).sort()) {
    const srcDir = join(packagesDir, pkg, 'src');
    if (!existsSync(srcDir)) continue;
    for (const file of [...walk(srcDir)].sort()) {
      const rel = relative(root, file).split(sep).join('/');
      if (!isScanned(rel, pkg) || exemption(rel)) continue;
      const text = readFileSync(file, 'utf8');
      if (!/table/i.test(text) || isGenerated(text)) continue;
      for (const s of findStatements(text)) {
        const key = `${rel}::${s.verb} TABLE ${s.table}`;
        const entry = byKey.get(key) ?? { key, file: rel, lines: [] };
        entry.lines.push(s.line);
        byKey.set(key, entry);
      }
    }
  }
  return byKey;
}

function readBaseline(root) {
  const path = join(root, BASELINE_PATH);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')).statements ?? {};
}

function writeBaseline(root, statements) {
  const sorted = Object.fromEntries(Object.entries(statements).sort(([a], [b]) => a.localeCompare(b)));
  mkdirSync(dirname(join(root, BASELINE_PATH)), { recursive: true });
  writeFileSync(
    join(root, BASELINE_PATH),
    `${JSON.stringify(
      {
        comment:
          'Hand-written CREATE/ALTER/DROP TABLE statements in smrt packages outside the migrator and the system tables (#4930). ' +
          'Key: file::statement; value: how many. This list may only shrink: remove the statement, then run ' +
          '`node scripts/check-hand-written-ddl.mjs --prune`.',
        statements: sorted,
      },
      null,
      2,
    )}\n`,
  );
}

/** Pure. `found` is the scan map; `baseline` and `previous` are key -> count objects. */
export function evaluate(found, baseline, previous) {
  const errors = [];
  const stale = [];
  for (const entry of found.values()) {
    const allowed = baseline[entry.key] ?? 0;
    if (entry.lines.length > allowed) {
      const extra = entry.lines.slice(allowed);
      errors.push(
        `${entry.file}:${extra.join(',')} hand-written ${entry.key.split('::')[1]}. ` +
          'Declare the shape on a model and let the migrator create it (rule 2), or move the statement into the migrator.',
      );
    }
  }
  for (const [key, count] of Object.entries(baseline)) {
    const have = found.get(key)?.lines.length ?? 0;
    if (have < count) {
      stale.push(key);
      errors.push(
        `Stale baseline entry ${key}: baseline says ${count}, source has ${have}. Run node scripts/check-hand-written-ddl.mjs --prune.`,
      );
    }
  }
  if (previous) {
    for (const [key, count] of Object.entries(baseline)) {
      if (count > (previous[key] ?? 0)) {
        errors.push(`Baseline grew: ${key} (${count}, base ${previous[key] ?? 0}). The baseline may only shrink.`);
      }
    }
  }
  return { errors, stale };
}

function main(argv) {
  const args = [...argv];
  const take = (flag) => {
    const i = args.indexOf(flag);
    if (i === -1) return undefined;
    const [, value] = args.splice(i, 2);
    return value;
  };
  const against = take('--against');
  const rootArg = take('--root');
  const root = resolve(rootArg ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
  const found = scanPackages(root);

  if (args.includes('--init')) {
    if (existsSync(join(root, BASELINE_PATH))) {
      console.error('check-hand-written-ddl: a baseline already exists; it may only shrink (--prune).');
      process.exit(1);
    }
    writeBaseline(root, Object.fromEntries([...found.values()].map((e) => [e.key, e.lines.length])));
    console.log('check-hand-written-ddl: wrote the initial baseline.');
    return;
  }

  const baseline = readBaseline(root);
  const previousText = against ? fileAtRef(root, against, BASELINE_PATH) : null;
  const previous = previousText ? (JSON.parse(previousText).statements ?? {}) : undefined;
  const result = evaluate(found, baseline, previous);

  if (args.includes('--prune')) {
    const next = {};
    for (const [key, count] of Object.entries(baseline)) {
      const have = found.get(key)?.lines.length ?? 0;
      if (have > 0) next[key] = Math.min(count, have);
    }
    writeBaseline(root, next);
    console.log(`check-hand-written-ddl: pruned ${result.stale.length} stale baseline entr${result.stale.length === 1 ? 'y' : 'ies'}.`);
    result.errors = result.errors.filter((e) => !e.startsWith('Stale baseline entry'));
  }
  if (result.errors.length > 0) {
    console.error(`check-hand-written-ddl: ${result.errors.length} problem(s) (#4930).`);
    for (const e of result.errors.slice(0, 40)) console.error(`  ${e}`);
    if (result.errors.length > 40) console.error(`  ... and ${result.errors.length - 40} more`);
    process.exit(1);
  }
  const total = [...found.values()].reduce((n, e) => n + e.lines.length, 0);
  console.log(`check-hand-written-ddl: ${total} hand-written table statement(s) outside the migrator, all in the baseline.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
