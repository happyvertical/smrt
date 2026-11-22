#!/usr/bin/env node

/**
 * Migration script for Issue #198: DuckDB DATETIME Compatibility
 *
 * This script migrates an existing SQLite database file from DATETIME to
 * TIMESTAMP column types and from `datetime('now')` to `current_timestamp`
 * column defaults.
 *
 * Usage:
 *   npx tsx scripts/migrate-datetime-to-timestamp.ts <database-path>
 *
 * Example:
 *   npx tsx scripts/migrate-datetime-to-timestamp.ts ./data/my-database.db
 *
 * What it does:
 * 1. Backs up the database with `VACUUM INTO` (a consistent snapshot that
 *    includes committed data still in the WAL; a file copy would not).
 * 2. Inside ONE `BEGIN EXCLUSIVE` transaction for the whole run, with foreign
 *    keys off (so no other connection writes in between, `DROP TABLE` fires
 *    no `ON DELETE` action, and a failure or a crash leaves every table as it
 *    was), for each table with DATETIME columns (generated ones included):
 *    - creates a new table from the table's own `CREATE TABLE` text in
 *      `sqlite_master`, with only the declared DATETIME types (`DATETIME`,
 *      `DATETIME(6)`) and `datetime('now')` column defaults rewritten, never
 *      names, constraint expressions, string literals or comments, so
 *      `UNIQUE`, `CHECK`, foreign keys and table options survive;
 *    - copies every row with its rowid (a rowid table keeps its implicit
 *      rowids; one whose three rowid aliases are all column names is
 *      refused), checks the count, drops the old table and renames the new
 *      one into its place;
 *    - restores the table's `AUTOINCREMENT` high-water mark;
 *    - replays the table's indexes and triggers exactly as they were written.
 * 3. Runs `PRAGMA foreign_key_check` and commits only when it is clean.
 *
 * The backup file is the way back.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

interface MigrationOptions {
  databasePath: string;
  dryRun?: boolean;
  backup?: boolean;
}

type Row = Record<string, unknown>;

/** A token of SQLite text: what it is, and where. */
interface SqlToken {
  kind: 'word' | 'string' | 'quoted' | 'punct' | 'space' | 'comment';
  text: string;
}

/** Split SQLite text into tokens, keeping every character. */
function tokenize(sql: string): SqlToken[] {
  const out: SqlToken[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    let j = i + 1;
    let kind: SqlToken['kind'] = 'punct';
    if (/\s/.test(c)) {
      while (j < sql.length && /\s/.test(sql[j])) j += 1;
      kind = 'space';
    } else if (c === '-' && next === '-') {
      while (j < sql.length && sql[j] !== '\n') j += 1;
      kind = 'comment';
    } else if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      j = end === -1 ? sql.length : end + 2;
      kind = 'comment';
    } else if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      for (;;) {
        if (j >= sql.length) break;
        if (sql[j] === close) {
          if (close !== ']' && sql[j + 1] === close) {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      kind = c === "'" ? 'string' : 'quoted';
    } else if (/[A-Za-z_]/.test(c)) {
      while (j < sql.length && /[A-Za-z0-9_$]/.test(sql[j])) j += 1;
      kind = 'word';
    }
    out.push({ kind, text: sql.slice(i, j) });
    i = j;
  }
  return out;
}

const TYPE_ENDS = new Set([
  'CONSTRAINT',
  'PRIMARY',
  'NOT',
  'NULL',
  'UNIQUE',
  'CHECK',
  'DEFAULT',
  'COLLATE',
  'REFERENCES',
  'GENERATED',
  'AS',
]);
const TABLE_CONSTRAINTS = new Set([
  'CONSTRAINT',
  'PRIMARY',
  'UNIQUE',
  'CHECK',
  'FOREIGN',
]);

/** The result of reading a CREATE TABLE text. */
interface CreateTable {
  sql: string;
  withoutRowid: boolean;
}

/**
 * The table's `CREATE TABLE` text with its name replaced by `newName`, the
 * DATETIME word of every column's declared type turned into TIMESTAMP (its
 * `(n)` arguments kept) and `datetime('now')` inside a column's DEFAULT
 * turned into `current_timestamp`. Column names, table constraints, generated
 * expressions, string literals and comments are never touched. Returns
 * `null` when the text is not the CREATE TABLE expected.
 */
export function rewriteCreateTable(
  sql: string,
  newName: string,
): string | null {
  return readCreateTable(sql, newName)?.sql ?? null;
}

function readCreateTable(sql: string, newName: string): CreateTable | null {
  const tokens = tokenize(sql);
  const significant = (from: number) => {
    let k = from;
    while (
      k < tokens.length &&
      (tokens[k].kind === 'space' || tokens[k].kind === 'comment')
    )
      k += 1;
    return k;
  };
  const upperAt = (k: number) => tokens[k]?.text.toUpperCase();
  let at = significant(0);
  if (upperAt(at) !== 'CREATE') return null;
  at = significant(at + 1);
  if (upperAt(at) !== 'TABLE') return null;
  at = significant(at + 1);
  if (upperAt(at) === 'IF') {
    at = significant(significant(significant(at + 1) + 1) + 1);
  }
  const nameAt = at;
  if (!tokens[nameAt] || !['word', 'quoted'].includes(tokens[nameAt].kind))
    return null;
  // A schema-qualified name (`main.t`) is not what this script writes.
  const open = significant(nameAt + 1);
  if (tokens[open]?.text !== '(') return null;
  tokens[nameAt] = { kind: 'quoted', text: `"${newName.replace(/"/g, '""')}"` };

  // Walk the column list: depth 1 items separated by commas.
  let depth = 0;
  let itemStart = true; // next significant token starts an item
  let mode: 'none' | 'name' | 'type' | 'rest' | 'default' | 'constraint' =
    'none';
  let close = -1;
  for (let k = open; k < tokens.length; k++) {
    const token = tokens[k];
    if (token.kind === 'space' || token.kind === 'comment') continue;
    if (token.kind === 'punct' && token.text === '(') {
      depth += 1;
      if (depth === 1) {
        itemStart = true;
        mode = 'none';
      }
      continue;
    }
    if (token.kind === 'punct' && token.text === ')') {
      depth -= 1;
      if (depth === 0) {
        close = k;
        break;
      }
      continue;
    }
    if (depth === 1 && token.kind === 'punct' && token.text === ',') {
      itemStart = true;
      mode = 'none';
      continue;
    }
    const upper = token.kind === 'word' ? token.text.toUpperCase() : '';
    if (depth === 1 && itemStart) {
      itemStart = false;
      mode =
        token.kind === 'word' && TABLE_CONSTRAINTS.has(upper)
          ? 'constraint'
          : 'type';
      // This token is the column name: left as written.
      if (mode === 'type') continue;
    }
    if (mode === 'constraint' || mode === 'none') continue;
    if (depth === 1 && token.kind === 'word' && TYPE_ENDS.has(upper)) {
      mode = upper === 'DEFAULT' ? 'default' : 'rest';
      continue;
    }
    if (mode === 'type' && depth === 1 && token.kind === 'word') {
      if (upper === 'DATETIME') tokens[k] = { kind: 'word', text: 'TIMESTAMP' };
      continue;
    }
    if (mode === 'type' && depth === 1 && token.kind === 'quoted') {
      // "DATETIME", [DATETIME] and `DATETIME` declare the same type.
      if (token.text.slice(1, -1).toUpperCase() === 'DATETIME') {
        // The delimiters were the separator: keep one if nothing else is.
        // By construction, from the source characters around the token:
        // a space unless the neighbour is plainly a separator. Extra spaces
        // in a declared type are harmless; a missing one renames a column.
        const edge = (index: number, step: number) => {
          for (let r = index; r >= 0 && r < tokens.length; r += step) {
            const text = tokens[r].text;
            if (text) return step < 0 ? text[text.length - 1] : text[0];
          }
          return undefined;
        };
        const previous = edge(k - 1, -1);
        const following = edge(k + 1, 1);
        const before =
          previous === undefined || /[ \t\n\r\f\v(,]/.test(previous) ? '' : ' ';
        const after =
          following === undefined || /[ \t\n\r\f\v),]/.test(following)
            ? ''
            : ' ';
        tokens[k] = { kind: 'word', text: `${before}TIMESTAMP${after}` };
      }
      continue;
    }
    if (mode === 'default' && token.kind === 'word' && upper === 'DATETIME') {
      const after = significant(k + 1);
      if (tokens[after]?.text !== '(') continue;
      const arg = significant(after + 1);
      const end = significant(arg + 1);
      if (
        tokens[arg]?.kind === 'string' &&
        tokens[arg].text.toLowerCase() === "'now'" &&
        tokens[end]?.text === ')'
      ) {
        tokens[k] = { kind: 'word', text: 'current_timestamp' };
        for (let r = k + 1; r <= end; r++)
          tokens[r] = { kind: 'space', text: '' };
      }
    }
  }
  if (close === -1) return null;
  let withoutRowid = false;
  for (
    let k = significant(close + 1);
    k < tokens.length;
    k = significant(k + 1)
  ) {
    if (upperAt(k) === 'WITHOUT' && upperAt(significant(k + 1)) === 'ROWID')
      withoutRowid = true;
  }
  return { sql: tokens.map((token) => token.text).join(''), withoutRowid };
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** A table with a DATETIME column, and the columns a copy must carry. */
function inventory(db: DatabaseSync, tableName: string) {
  const info = db
    .prepare(`PRAGMA table_xinfo(${quote(tableName)})`)
    .all() as Row[];
  return {
    datetimeColumns: info.filter((col) =>
      // The DATETIME word of the declared type, as the rewriter sees it:
      // not DATETIME2 or SMALLDATETIME.
      /(^|[^A-Za-z0-9_$])DATETIME($|[^A-Za-z0-9_$])/i.test(
        String(col.type ?? ''),
      ),
    ),
    // hidden 0 = an ordinary column; generated (2, 3) and virtual-table
    // hidden (1) columns cannot be inserted into.
    copyColumns: info
      .filter((col) => Number(col.hidden) === 0)
      .map((col) => String(col.name)),
    allNames: info.map((col) => String(col.name).toLowerCase()),
  };
}

/**
 * Main migration function
 */
async function migrate(options: MigrationOptions) {
  const { databasePath, dryRun = false, backup = true } = options;

  if (!existsSync(databasePath)) {
    throw new Error(`Database not found: ${databasePath}`);
  }

  console.log(`🔍 Analyzing database: ${databasePath}`);
  const db = new DatabaseSync(databasePath);
  const all = (sql: string, ...params: (string | number)[]) =>
    db.prepare(sql).all(...params) as Row[];
  const foreignKeys = Number(
    (db.prepare('PRAGMA foreign_keys').get() as Row).foreign_keys,
  );

  try {
    if (backup && !dryRun) {
      const backupPath = `${databasePath}.backup-${Date.now()}`;
      console.log(`📦 Creating backup: ${backupPath}`);
      // A consistent snapshot, WAL contents included.
      db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
      console.log(`✅ Backup created successfully`);
    }

    if (!dryRun) {
      // Only outside a transaction does this take effect.
      db.exec('PRAGMA foreign_keys = OFF');
      // One transaction for the whole run: any failure applies none of it.
      db.exec('BEGIN EXCLUSIVE');
    }
    try {
      // Read inside the exclusive transaction: nothing changes underneath.
      const tables = all(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_smrt\\_%' ESCAPE '\\'
      `);
      console.log(`📊 Found ${tables.length} user tables to check`);

      for (const table of tables) {
        const tableName = String(table.name);
        console.log(`\n🔧 Processing table: ${tableName}`);
        const { datetimeColumns } = inventory(db, tableName);
        if (datetimeColumns.length === 0) {
          console.log(`  ✓ No DATETIME columns found, skipping`);
          continue;
        }
        console.log(
          `  📋 Found ${datetimeColumns.length} DATETIME column(s): ${datetimeColumns.map((c) => c.name).join(', ')}`,
        );
        if (dryRun) {
          console.log(
            `  🔍 [DRY RUN] Would migrate these columns to TIMESTAMP`,
          );
          continue;
        }
        rebuildTable(db, tableName);
        console.log(`  ✅ Migration complete for table: ${tableName}`);
      }

      if (!dryRun) {
        const violations = all('PRAGMA foreign_key_check');
        if (violations.length > 0)
          throw new Error(
            `Foreign key check failed after the rebuild (${violations.length} row(s)); nothing was changed`,
          );
        db.exec('COMMIT');
      }
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    } finally {
      if (!dryRun)
        db.exec(`PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
    }

    console.log(`\n✨ Migration completed successfully!`);
  } finally {
    db.close();
  }
}

/** Rebuild one table inside the run's transaction (foreign keys are off). */
function rebuildTable(db: DatabaseSync, tableName: string): void {
  const all = (sql: string, ...params: (string | number)[]) =>
    db.prepare(sql).all(...params) as Row[];
  const legacyAlter = Number(
    (db.prepare('PRAGMA legacy_alter_table').get() as Row).legacy_alter_table,
  );
  const [definition] = all(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
    tableName,
  );
  const objects = all(
    `SELECT type, name, sql FROM sqlite_master
      WHERE tbl_name = ? COLLATE NOCASE AND type IN ('index', 'trigger') AND sql IS NOT NULL
      ORDER BY CASE type WHEN 'index' THEN 0 ELSE 1 END, rowid`,
    tableName,
  );
  const { copyColumns, allNames } = inventory(db, tableName);
  const newTableName = `${tableName}_smrt_timestamp_new`;
  const created = readCreateTable(String(definition?.sql ?? ''), newTableName);
  if (!created)
    throw new Error(
      `Cannot read the CREATE TABLE text of ${tableName}; nothing was changed`,
    );

  // Implicit rowids are identities consumers can hold (an FTS index, a
  // cache): copy them through the first alias no column shadows, for every
  // rowid table (for a true INTEGER PRIMARY KEY alias it is the same value;
  // INTEGER PRIMARY KEY DESC is not an alias, so nothing is inferred).
  const rowidAlias: string[] = [];
  if (!created.withoutRowid) {
    const alias = ['rowid', '_rowid_', 'oid'].find(
      (name) => !allNames.includes(name),
    );
    if (!alias)
      throw new Error(
        `${tableName} shadows rowid, _rowid_ and oid with columns, so its rowids cannot be kept; nothing was changed`,
      );
    rowidAlias.push(alias);
  }
  const columns = [...rowidAlias, ...copyColumns.map(quote)];
  const sequenceTable = all(
    `SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'`,
  );
  const sequence =
    sequenceTable.length > 0
      ? // As a bigint: a counter above 2^53 must survive exactly.
        (() => {
          const read = db.prepare(
            `SELECT seq FROM sqlite_sequence WHERE name = ?`,
          );
          read.setReadBigInts(true);
          return read.get(tableName) as { seq: bigint } | undefined;
        })()
      : undefined;

  console.log(`  🏗️  Creating new table: ${newTableName}`);
  db.exec(created.sql);
  console.log(`  📤 Copying data to new table...`);
  db.exec(
    `INSERT INTO ${quote(newTableName)} (${columns.join(', ')}) SELECT ${columns.join(', ')} FROM ${quote(tableName)}`,
  );
  const count = (name: string) =>
    Number(
      (db.prepare(`SELECT COUNT(*) AS count FROM ${quote(name)}`).get() as Row)
        .count,
    );
  const oldCount = count(tableName);
  const newCount = count(newTableName);
  if (oldCount !== newCount)
    throw new Error(
      `Data copy verification failed: ${oldCount} rows in old table, ${newCount} rows in new table`,
    );
  console.log(`  ✅ Copied ${oldCount} rows successfully`);

  console.log(`  🗑️  Dropping old table: ${tableName}`);
  db.exec(`DROP TABLE ${quote(tableName)}`);
  console.log(`  📝 Renaming ${newTableName} to ${tableName}`);
  db.exec('PRAGMA legacy_alter_table = ON');
  db.exec(`ALTER TABLE ${quote(newTableName)} RENAME TO ${quote(tableName)}`);
  db.exec(`PRAGMA legacy_alter_table = ${legacyAlter ? 'ON' : 'OFF'}`);

  if (sequence) {
    // The old counter went with the dropped table: put the high-water mark
    // back so a deleted top id is never issued again.
    db.prepare(`DELETE FROM sqlite_sequence WHERE name = ?`).run(tableName);
    db.prepare(`INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)`).run(
      tableName,
      sequence.seq,
    );
  }

  if (objects.length > 0) {
    console.log(
      `  🔗 Recreating ${objects.length} index(es) and trigger(s)...`,
    );
    // Exactly as written: their text names the table, which exists again.
    for (const object of objects) db.exec(String(object.sql));
  }
}

/**
 * Parse command line arguments and run migration
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
Migration Script for Issue #198: DuckDB DATETIME Compatibility

Usage:
  npx tsx scripts/migrate-datetime-to-timestamp.ts [options] <database-path>

Options:
  --dry-run         Show what would be migrated without making changes
  --no-backup       Skip creating a backup file (not recommended)
  -h, --help        Show this help message

Examples:
  # Migrate database with backup
  npx tsx scripts/migrate-datetime-to-timestamp.ts ./data/my-database.db

  # Preview migration without making changes
  npx tsx scripts/migrate-datetime-to-timestamp.ts --dry-run ./data/my-database.db

  # Migrate without backup (dangerous!)
  npx tsx scripts/migrate-datetime-to-timestamp.ts --no-backup ./data/my-database.db
    `);
    process.exit(0);
  }

  const dryRun = args.includes('--dry-run');
  const noBackup = args.includes('--no-backup');
  const databasePath = resolve(args.find((arg) => !arg.startsWith('--')) || '');

  if (!databasePath) {
    console.error('❌ Error: Database path is required');
    process.exit(1);
  }

  try {
    await migrate({
      databasePath,
      dryRun,
      backup: !noBackup,
    });
    process.exit(0);
  } catch (error) {
    console.error(`\n❌ Migration failed:`, error);
    process.exit(1);
  }
}

// Run if called directly
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}

export { type MigrationOptions, migrate };
