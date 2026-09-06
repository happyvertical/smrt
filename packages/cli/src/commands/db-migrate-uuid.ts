/**
 * db:migrate-uuid Command
 *
 * relationships-v2 (0.27.0) data migration helper.
 *
 * The 0.27.0 release makes `@foreignKey()` / `@crossPackageRef()` (and primary
 * `id`) columns native `uuid` on PostgreSQL. The structural migration
 * (`smrt db:migrate`) is *additive* — it cannot rename or change a column's
 * type in place — so two pieces of per-project DATA migration remain:
 *
 *  1. **R3 column renames** (e.g. `tags.parent_slug → parent_id`,
 *     `facts.parent_id → previous_fact_id`, `assets.parent_id →
 *     source_asset_id`). The new column is added empty and the old column is
 *     left orphaned. Use `--rename "old:new[,old2:new2]"` (optionally with
 *     `--table <name>`) to copy old → new (only where new is still empty) and
 *     drop the old column.
 *
 *  2. **TEXT → native uuid conversion**. Most existing `id`/FK columns already
 *     hold canonical UUID strings in TEXT columns and can be promoted to native
 *     `uuid`. Conversion is gated on TWO independent checks, BOTH of which must
 *     pass for a column to be converted:
 *
 *       (a) **Schema-declared UUID** — the column is one the SMRT manifest
 *           declares as a `UUID` type (primary `id`, `@foreignKey()` /
 *           `@crossPackageRef()` columns). The declared types come from
 *           `ObjectRegistry.getAllSchemasAsDefinitions()` — the SAME source
 *           `smrt db:migrate` / `db:diff` use. Columns the schema intentionally
 *           keeps TEXT (`external_id`, `message_id`, provider/oauth ids, …) are
 *           NEVER converted even when their current data happens to be
 *           uuid-shaped, because a future non-uuid insert must still succeed.
 *           Tables not present in the manifest (non-SMRT tables in the `public`
 *           schema) drop out automatically.
 *
 *       (b) **Data-shape** — every non-empty value is already a canonical UUID.
 *           A declared-UUID column that still holds genuine non-uuid values
 *           (legacy unhyphenated ids, partially-migrated data, …) is SKIPPED and
 *           reported so the operator can clean it before re-running.
 *
 *     **Fail-closed:** if the manifest/registry can't be loaded or declares no
 *     UUID columns, NOTHING is converted (the operator is told to run from the
 *     project root). There is deliberately no name-regex fallback — over-
 *     converting a TEXT column the schema tolerates as TEXT (the differ treats
 *     uuid/text as equivalent, so it would never self-repair) is irreversible
 *     prod-data damage.
 *
 * When BOTH the rename backfills and the uuid conversion run in one invocation
 * they share a SINGLE transaction (one `BEGIN`, one `COMMIT`, one `ROLLBACK` on
 * any failure) so a conversion failure can never leave a half-applied migration
 * with the old columns already dropped. Postgres DDL is transactional, so this
 * holds. With `--skip-convert` the rename phase commits on its own. Both steps
 * are idempotent — re-running is a no-op once the renames are done and the
 * columns are already `uuid`.
 *
 * PostgreSQL only: SQLite and DuckDB store SMRT uuid columns as TEXT (SQLite)
 * or accept uuid strings transparently, so no `ALTER COLUMN TYPE uuid` step is
 * needed there. On a non-Postgres database this command performs the rename
 * backfills (if requested) and then reports that the uuid conversion is a no-op.
 *
 * Run AFTER `smrt db:migrate`.
 *
 * Usage:
 *   smrt db:migrate-uuid --dry-run
 *   smrt db:migrate-uuid
 *   smrt db:migrate-uuid --rename "parent_id:source_asset_id" --table assets
 *   smrt db:migrate-uuid --rename "parent_slug:parent_id" --table tags --skip-convert
 */

import { ObjectRegistry } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { CLICommand } from '../cli-generator.js';
import { autoDiscoverAndLoad } from '../discovery/index.js';
import {
  closeDatabaseConnection,
  formatDatabaseDisplayUrl,
  quoteIdentifier,
} from './db-command-utils.js';

/** Parsed CLI options for the `db:migrate-uuid` command. */
interface DbMigrateUuidOptions {
  rename?: string;
  table?: string;
  'skip-convert'?: boolean;
  'dry-run'?: boolean;
  verbose?: boolean;
}

const UUID_RE =
  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

/**
 * Build the set of schema-declared UUID columns from a manifest's
 * `getAllSchemasAsDefinitions()` output.
 *
 * Only columns whose declared `type === 'UUID'` are included. The returned set
 * uses `${table}|${column}` keys for O(1) membership tests. Pure and
 * DB-independent so the gating semantics can be unit-tested without a database.
 */
export function buildDeclaredUuidColumnSet(
  schemaDefinitions: Record<
    string,
    { columns?: Record<string, { type?: string }> }
  >,
): Set<string> {
  const declared = new Set<string>();
  for (const [tableName, def] of Object.entries(schemaDefinitions ?? {})) {
    const columns = def?.columns ?? {};
    for (const [columnName, columnDef] of Object.entries(columns)) {
      if (String(columnDef?.type).toUpperCase() === 'UUID') {
        declared.add(declaredUuidKey(tableName, columnName));
      }
    }
  }
  return declared;
}

function declaredUuidKey(table: string, column: string): string {
  return `${table}|${column}`;
}

/** A live TEXT column scheduled for `ALTER COLUMN … TYPE uuid`. */
interface ConvertCandidate {
  table: string;
  column: string;
  hasDefault: boolean;
}

/**
 * A live TEXT `id`/FK column discovered in the database, annotated with how
 * many of its non-empty values are NOT canonical UUIDs.
 */
export interface LiveTextColumn {
  table: string;
  column: string;
  hasDefault: boolean;
  /** Count of non-empty values that are not canonical UUIDs. */
  nonUuid: number;
}

/**
 * The outcome of classifying live TEXT columns against the declared-UUID set.
 */
export interface ConversionPlan {
  convert: ConvertCandidate[];
  /** Declared-UUID columns whose data still has non-uuid values. */
  skipDirtyData: Array<{ table: string; column: string; nonUuid: number }>;
  /** Live TEXT columns the schema does NOT declare as UUID (left as TEXT). */
  skipNotDeclared: Array<{ table: string; column: string }>;
}

/**
 * Decide which live TEXT columns to convert to native `uuid`.
 *
 * A column is converted ONLY if BOTH gates pass:
 *   1. it is in the schema-declared-UUID set, AND
 *   2. all of its non-empty values are already canonical UUIDs.
 *
 * Declared-UUID columns with dirty data are reported in `skipDirtyData`;
 * undeclared columns (schema-intentional TEXT, or non-SMRT tables) are reported
 * in `skipNotDeclared`. Pure so the gating can be unit-tested without a DB.
 */
export function planUuidConversions(
  liveColumns: LiveTextColumn[],
  declaredUuid: Set<string>,
): ConversionPlan {
  const convert: ConvertCandidate[] = [];
  const skipDirtyData: ConversionPlan['skipDirtyData'] = [];
  const skipNotDeclared: ConversionPlan['skipNotDeclared'] = [];

  for (const col of liveColumns) {
    if (!declaredUuid.has(declaredUuidKey(col.table, col.column))) {
      // Gate 1 failed: schema does not declare this column UUID. Leave as TEXT.
      skipNotDeclared.push({ table: col.table, column: col.column });
      continue;
    }
    if (col.nonUuid > 0) {
      // Gate 2 failed: declared UUID but data is not all-uuid. Operator cleans.
      skipDirtyData.push({
        table: col.table,
        column: col.column,
        nonUuid: col.nonUuid,
      });
      continue;
    }
    convert.push({
      table: col.table,
      column: col.column,
      hasDefault: col.hasDefault,
    });
  }

  return { convert, skipDirtyData, skipNotDeclared };
}

interface RenameSpec {
  table: string;
  from: string;
  to: string;
}

/**
 * Parse `--rename "old:new,old2:new2"` plus the optional default `--table`
 * into structured rename specs. A pair may carry its own table via
 * `table.old:new`; otherwise it falls back to `--table`.
 */
export function parseRenameSpecs(
  renameArg: string | undefined,
  defaultTable: string | undefined,
): RenameSpec[] {
  if (!renameArg) return [];
  const specs: RenameSpec[] = [];
  for (const raw of renameArg.split(',')) {
    const pair = raw.trim();
    if (!pair) continue;
    const [lhs, to] = pair.split(':').map((s) => s.trim());
    if (!lhs || !to) {
      throw new Error(
        `Invalid --rename entry "${pair}". Expected "old:new" or "table.old:new".`,
      );
    }
    let table = defaultTable;
    let from = lhs;
    const dot = lhs.indexOf('.');
    if (dot !== -1) {
      table = lhs.slice(0, dot);
      from = lhs.slice(dot + 1);
    }
    if (!table) {
      throw new Error(
        `--rename entry "${pair}" has no table. Pass --table <name> or use "table.old:new".`,
      );
    }
    specs.push({ table, from, to });
  }
  return specs;
}

export const dbMigrateUuidCommand: CLICommand = {
  name: 'db:migrate-uuid',
  description:
    'Backfill R3 column renames and convert schema-declared-UUID TEXT id/FK columns to native uuid (Postgres). Run from the project root, after db:migrate.',
  aliases: ['migrate-uuid', 'db-migrate-uuid'],
  args: [],
  options: {
    rename: {
      type: 'string',
      description:
        'Comma-separated old:new column renames to backfill, e.g. "parent_id:source_asset_id". Use --table to scope, or "table.old:new" per entry.',
    },
    table: {
      type: 'string',
      description: 'Default table for --rename entries that omit one.',
    },
    'skip-convert': {
      type: 'boolean',
      description:
        'Only run the --rename backfills; skip the TEXT→uuid conversion pass.',
      default: false,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Show the SQL that would run without executing it.',
      default: false,
    },
    verbose: {
      type: 'boolean',
      description: 'Show detailed output.',
      default: false,
      short: 'v',
    },
  },
  handler: async (_args: string[], options: DbMigrateUuidOptions) => {
    const dryRun = Boolean(options['dry-run']);
    let db: DatabaseInterface | undefined;

    try {
      // 1. Load CLI config + validate DB.
      const { getPackageConfig } = await import('@happyvertical/smrt-config');
      const { DEFAULT_CLI_CONFIG } = await import('../config.js');
      const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);

      if (!config.database?.url || config.database.url === ':memory:') {
        console.error(
          '\n❌ Database configuration required for db:migrate-uuid',
        );
        console.error('\nConfigure database in smrt.config.js.\n');
        process.exit(1);
      }

      const dbUrl = config.database.url;
      const dbType = config.database.type || 'sqlite';

      // 2. Parse rename specs early so input errors fail before connecting.
      const renameSpecs = parseRenameSpecs(options.rename, options.table);

      console.log('\n🔑 UUID column migration\n');

      const { getDatabase } = await import('@happyvertical/sql');
      db = await getDatabase({ type: dbType, url: dbUrl });
      console.log(
        `✓ Connected to ${formatDatabaseDisplayUrl(dbType, dbUrl)}\n`,
      );

      const isPostgres = dbType === 'postgres' || /^postgres/i.test(dbUrl);

      const runRenames = renameSpecs.length > 0;
      const skipConvert = Boolean(options['skip-convert']);
      // The TEXT→uuid conversion only does work on Postgres (other dialects
      // store SMRT uuid columns as TEXT already).
      const runConvert = !skipConvert && isPostgres;

      if (skipConvert) {
        await applyRenameBackfills(db, isPostgres, renameSpecs, dryRun, {
          ownTransaction: !dryRun,
        });
        console.log('Skipping TEXT→uuid conversion (--skip-convert).\n');
        return;
      }

      if (!isPostgres) {
        await applyRenameBackfills(db, isPostgres, renameSpecs, dryRun, {
          ownTransaction: !dryRun,
        });
        console.log(
          `Database type "${dbType}" has no native uuid column type that needs converting; uuid conversion is a no-op.\n`,
        );
        return;
      }

      const declaredUuid = await loadDeclaredUuidColumns();
      if (declaredUuid.size === 0) {
        console.log(
          'No schema-declared UUID columns found in the loaded manifest.',
        );
        console.log(
          'Skipping TEXT→uuid conversion (fail-closed). Run this command from\n' +
            'the project root so the SMRT manifest can be discovered, then re-run.\n',
        );
        await applyRenameBackfills(db, isPostgres, renameSpecs, dryRun, {
          ownTransaction: !dryRun,
        });
        return;
      }

      if (dryRun) {
        await applyRenameBackfills(db, isPostgres, renameSpecs, true, {
          ownTransaction: false,
        });
        await convertPostgresUuidColumns(db, declaredUuid, true);
        return;
      }
      if (!db.transaction) {
        throw new Error(
          'PostgreSQL UUID migration requires DatabaseInterface.transaction(); refusing to run unpinned DDL.',
        );
      }
      // Do not let an optional rename be the first mutation that discovers an
      // unsupported conversion graph.  The transaction below performs the
      // locked authoritative re-scan; this read-only pass makes a malformed
      // existing component fail before the rename UPDATE/DROP is attempted.
      if (runRenames && runConvert) {
        await convertPostgresUuidColumns(db, declaredUuid, true);
      }
      await db.transaction(async (tx) => {
        // All mutation uses the callback executor: pooled root handles cannot
        // promise BEGIN/DDL affinity.
        await applyRenameBackfills(tx, true, renameSpecs, false, {
          ownTransaction: false,
        });
        await convertPostgresUuidColumns(tx, declaredUuid, false);
      });
    } catch (error) {
      console.error(
        `\n❌ uuid migration failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    } finally {
      await closeDatabaseConnection(db);
    }
  },
};

function nullifEmpty(isPostgres: boolean, quotedCol: string): string {
  return isPostgres
    ? `nullif(btrim(${quotedCol}), '')`
    : `nullif(trim(${quotedCol}), '')`;
}

type QueryExecutor = Pick<DatabaseInterface, 'query'>;

interface PostgresColumn extends ConvertCandidate {
  defaultExpression: string | null;
}

interface ForeignKeySnapshot {
  table: string;
  name: string;
  definition: string;
  validated: boolean;
  comment: string | null;
}

interface GeneratedBridgeSnapshot {
  table: string;
  column: string;
  sourceColumn: string;
  indexDefinitions: Array<{ definition: string; comment: string | null }>;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Convert a deliberately narrow PostgreSQL dependency component.  This is
 * intentionally catalog-driven: generated text bridges are consumer schema,
 * not SMRT manifest columns, and are never guessed from a name.
 */
async function convertPostgresUuidColumns(
  db: QueryExecutor,
  declaredUuid: Set<string>,
  dryRun: boolean,
): Promise<void> {
  const { rows: candidateRows } = await db.query(
    `SELECT table_name, column_name, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type = 'text'
        AND (column_name = 'id' OR column_name ~* '(_id|Id)$')
      ORDER BY table_name, column_name`,
  );
  const liveColumns: LiveTextColumn[] = [];
  const defaults = new Map<string, string | null>();
  for (const row of candidateRows as Array<Record<string, unknown>>) {
    const table = String(row.table_name);
    const column = String(row.column_name);
    let nonUuid = 0;
    if (declaredUuid.has(declaredUuidKey(table, column))) {
      const { rows } = await db.query(
        `SELECT count(*)::text AS n FROM ${quoteIdentifier(table)}
          WHERE nullif(btrim(${quoteIdentifier(column)}), '') IS NOT NULL
            AND btrim(${quoteIdentifier(column)}) !~* '${UUID_RE}'`,
      );
      nonUuid = Number(
        (rows[0] as Record<string, unknown> | undefined)?.n ?? 0,
      );
    }
    liveColumns.push({
      table,
      column,
      hasDefault: row.column_default != null,
      nonUuid,
    });
    defaults.set(
      declaredUuidKey(table, column),
      row.column_default == null ? null : String(row.column_default),
    );
  }
  const { convert, skipDirtyData, skipNotDeclared } = planUuidConversions(
    liveColumns,
    declaredUuid,
  );
  console.log(
    `Found ${candidateRows.length} TEXT id/FK column(s): ${convert.length} convertible, ${skipDirtyData.length + skipNotDeclared.length} skipped.`,
  );
  for (const item of skipDirtyData)
    console.log(
      `  SKIP ${item.table}.${item.column}: ${item.nonUuid} non-uuid value(s)`,
    );
  for (const item of skipNotDeclared)
    console.log(
      `  SKIP ${item.table}.${item.column}: not schema-declared UUID`,
    );
  if (convert.length === 0) {
    console.log('\nNothing to convert. Done.\n');
    return;
  }

  const columns: PostgresColumn[] = convert.map((column) => ({
    ...column,
    defaultExpression:
      defaults.get(declaredUuidKey(column.table, column.column)) ?? null,
  }));
  await assertSupportedSourceColumns(db, columns);
  const bridges = await snapshotGeneratedBridges(db, columns);
  const foreignKeys = await snapshotForeignKeys(db, columns, bridges);
  const tables = [
    ...new Set([
      ...columns.map((column) => column.table),
      ...bridges.map((bridge) => bridge.table),
      ...foreignKeys.map((foreignKey) => foreignKey.table),
    ]),
  ].sort();

  if (dryRun) {
    console.log(
      `\nDRY RUN — dependency plan for ${columns.length} conversion(s):`,
    );
    for (const table of tables)
      console.log(
        `  LOCK TABLE ${quoteIdentifier(table)} IN ACCESS EXCLUSIVE MODE;`,
      );
    renderUuidConversionSql(columns, bridges, foreignKeys);
    console.log('\nDry run complete — no changes applied.\n');
    return;
  }

  // Locks prevent a DDL/data race between the plan and mutation.  Re-read the
  // whole bounded catalog after acquiring them; any changed shape is refused.
  for (const table of tables) {
    await db.query(
      `LOCK TABLE ${quoteIdentifier(table)} IN ACCESS EXCLUSIVE MODE`,
    );
  }
  const rescannedBridges = await snapshotGeneratedBridges(db, columns);
  const rescannedForeignKeys = await snapshotForeignKeys(
    db,
    columns,
    rescannedBridges,
  );
  if (
    JSON.stringify({ bridges, foreignKeys }) !==
    JSON.stringify({
      bridges: rescannedBridges,
      foreignKeys: rescannedForeignKeys,
    })
  ) {
    throw new Error(
      'UUID dependency catalog changed while locks were acquired; refusing stale migration plan. Re-run the command.',
    );
  }
  renderUuidConversionSql(columns, bridges, foreignKeys);
  for (const foreignKey of foreignKeys) {
    await db.query(
      `ALTER TABLE ${quoteIdentifier(foreignKey.table)} DROP CONSTRAINT ${quoteIdentifier(foreignKey.name)}`,
    );
  }
  for (const bridge of bridges) {
    await db.query(
      `ALTER TABLE ${quoteIdentifier(bridge.table)} DROP COLUMN ${quoteIdentifier(bridge.column)}`,
    );
  }
  for (const column of columns) {
    const table = quoteIdentifier(column.table);
    const name = quoteIdentifier(column.column);
    if (column.defaultExpression)
      await db.query(`ALTER TABLE ${table} ALTER COLUMN ${name} DROP DEFAULT`);
    await db.query(
      `ALTER TABLE ${table} ALTER COLUMN ${name} TYPE uuid USING NULLIF(btrim(${name}), '')::uuid`,
    );
    if (column.defaultExpression) {
      // The original expression remains the source of truth; the explicit cast
      // validates it on this server rather than silently discarding a default.
      await db.query(
        `ALTER TABLE ${table} ALTER COLUMN ${name} SET DEFAULT (${column.defaultExpression})::uuid`,
      );
    }
  }
  for (const bridge of bridges) {
    await db.query(
      `ALTER TABLE ${quoteIdentifier(bridge.table)} ADD COLUMN ${quoteIdentifier(bridge.column)} text GENERATED ALWAYS AS (${quoteIdentifier(bridge.sourceColumn)}::text) STORED`,
    );
    for (const index of bridge.indexDefinitions) {
      await db.query(index.definition);
      if (index.comment)
        await db.query(
          `COMMENT ON INDEX ${indexNameFromDefinition(index.definition)} IS ${quoteLiteral(index.comment)}`,
        );
    }
  }
  for (const foreignKey of foreignKeys) {
    await db.query(
      `ALTER TABLE ${quoteIdentifier(foreignKey.table)} ADD CONSTRAINT ${quoteIdentifier(foreignKey.name)} ${foreignKey.definition}${foreignKey.validated ? '' : ' NOT VALID'}`,
    );
    if (foreignKey.comment)
      await db.query(
        `COMMENT ON CONSTRAINT ${quoteIdentifier(foreignKey.name)} ON ${quoteIdentifier(foreignKey.table)} IS ${quoteLiteral(foreignKey.comment)}`,
      );
  }
  console.log(`\n✓ Converted ${columns.length} column(s) to uuid.\n`);
}

async function assertSupportedSourceColumns(
  db: QueryExecutor,
  columns: PostgresColumn[],
): Promise<void> {
  for (const column of columns) {
    const { rows: shape } = await db.query(
      `SELECT relispartition AS partitioned,
              EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid OR i.inhparent = c.oid) AS inherited
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ${quoteLiteral(column.table)} AND c.relkind = 'r'`,
    );
    if (
      shape.length !== 1 ||
      (shape[0] as Record<string, unknown>).partitioned ||
      (shape[0] as Record<string, unknown>).inherited
    ) {
      throw new Error(
        `Unsupported table shape for ${column.table}.${column.column}; UUID conversion supports only non-partitioned, non-inherited public tables.`,
      );
    }
    const { rows: views } = await db.query(
      `SELECT dependent.relname AS name
         FROM pg_depend dep
         JOIN pg_rewrite rule ON rule.oid = dep.objid
         JOIN pg_class dependent ON dependent.oid = rule.ev_class
         JOIN pg_class source ON source.oid = dep.refobjid
         JOIN pg_namespace source_ns ON source_ns.oid = source.relnamespace
         JOIN pg_attribute source_attr ON source_attr.attrelid = source.oid AND source_attr.attnum = dep.refobjsubid
        WHERE dep.classid = 'pg_rewrite'::regclass AND source_ns.nspname = 'public'
          AND source.relname = ${quoteLiteral(column.table)} AND source_attr.attname = ${quoteLiteral(column.column)}`,
    );
    if (views.length > 0) {
      throw new Error(
        `Unsupported view or rule dependency on ${column.table}.${column.column}: ${(views as Array<Record<string, unknown>>).map((view) => String(view.name)).join(', ')}. Remove or migrate it separately before db:migrate-uuid.`,
      );
    }
  }
}

function renderUuidConversionSql(
  columns: PostgresColumn[],
  bridges: GeneratedBridgeSnapshot[],
  foreignKeys: ForeignKeySnapshot[],
): void {
  for (const foreignKey of foreignKeys)
    console.log(
      `  ALTER TABLE ${quoteIdentifier(foreignKey.table)} DROP CONSTRAINT ${quoteIdentifier(foreignKey.name)};`,
    );
  for (const bridge of bridges)
    console.log(
      `  ALTER TABLE ${quoteIdentifier(bridge.table)} DROP COLUMN ${quoteIdentifier(bridge.column)};`,
    );
  for (const column of columns) {
    const table = quoteIdentifier(column.table);
    const name = quoteIdentifier(column.column);
    if (column.defaultExpression)
      console.log(`  ALTER TABLE ${table} ALTER COLUMN ${name} DROP DEFAULT;`);
    console.log(
      `  ALTER TABLE ${table} ALTER COLUMN ${name} TYPE uuid USING NULLIF(btrim(${name}), '')::uuid;`,
    );
    if (column.defaultExpression)
      console.log(
        `  ALTER TABLE ${table} ALTER COLUMN ${name} SET DEFAULT (${column.defaultExpression})::uuid;`,
      );
  }
  for (const bridge of bridges) {
    console.log(
      `  ALTER TABLE ${quoteIdentifier(bridge.table)} ADD COLUMN ${quoteIdentifier(bridge.column)} text GENERATED ALWAYS AS (${quoteIdentifier(bridge.sourceColumn)}::text) STORED;`,
    );
    for (const index of bridge.indexDefinitions)
      console.log(`  ${index.definition};`);
  }
  for (const foreignKey of foreignKeys)
    console.log(
      `  ALTER TABLE ${quoteIdentifier(foreignKey.table)} ADD CONSTRAINT ${quoteIdentifier(foreignKey.name)} ${foreignKey.definition}${foreignKey.validated ? '' : ' NOT VALID'};`,
    );
}

async function snapshotGeneratedBridges(
  db: QueryExecutor,
  columns: PostgresColumn[],
): Promise<GeneratedBridgeSnapshot[]> {
  const requested = new Set(
    columns.map((column) => declaredUuidKey(column.table, column.column)),
  );
  const { rows } = await db.query(
    `SELECT generated.relname AS table_name, generated_attr.attname AS column_name,
            pg_get_expr(def.adbin, def.adrelid) AS expression,
            format_type(generated_attr.atttypid, generated_attr.atttypmod) AS type_name,
            generated_attr.attnotnull AS not_null, generated_attr.attstorage AS storage,
            generated_attr.attacl IS NOT NULL AS has_acl,
            col_description(generated_attr.attrelid, generated_attr.attnum) AS column_comment,
            generated.relispartition AS partitioned,
            EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = generated.oid OR i.inhparent = generated.oid) AS inherited
       FROM pg_attrdef def
       JOIN pg_class generated ON generated.oid = def.adrelid
       JOIN pg_namespace generated_ns ON generated_ns.oid = generated.relnamespace
       JOIN pg_attribute generated_attr ON generated_attr.attrelid = generated.oid AND generated_attr.attnum = def.adnum
      WHERE generated_ns.nspname = 'public'
        AND generated.relkind = 'r' AND generated_attr.attgenerated = 's'`,
  );
  const bridges: GeneratedBridgeSnapshot[] = [];
  for (const row of rows as Array<Record<string, unknown>>) {
    const bridgeTable = String(row.table_name);
    const bridgeColumn = String(row.column_name);
    const expression = String(row.expression).replaceAll(' ', '');
    const sourceColumn = expression.match(
      /^\(?([a-zA-Z_][a-zA-Z0-9_$]*)\)?(?:::text)?$/,
    )?.[1];
    if (!sourceColumn) {
      if (columns.some((column) => column.table === bridgeTable)) {
        throw new Error(
          `Unsupported generated dependency ${bridgeTable}.${bridgeColumn}; only a plain stored TEXT id::text bridge can coexist with a converted UUID column.`,
        );
      }
      continue;
    }
    // A table may already contain native UUID columns and bridges unrelated to
    // the TEXT candidate currently being converted. Leave those intact. Only
    // a bridge whose *actual expression source* is converted participates.
    if (!requested.has(declaredUuidKey(bridgeTable, sourceColumn))) {
      continue;
    }
    const table = bridgeTable;
    if (
      bridgeTable !== table ||
      String(row.type_name) !== 'text' ||
      row.not_null ||
      String(row.storage) !== 'x' ||
      row.has_acl ||
      row.column_comment != null ||
      row.partitioned ||
      row.inherited ||
      ![
        'id',
        '(id)::text',
        `${sourceColumn}::text`,
        `(${sourceColumn})::text`,
      ].includes(expression)
    ) {
      throw new Error(
        `Unsupported generated dependency ${bridgeTable}.${bridgeColumn}; only a plain stored TEXT ${sourceColumn}::text bridge without ACLs, comments, inheritance, partitioning, or extra attributes is supported.`,
      );
    }
    // UUID casts normalize input. A text bridge must keep its values exactly,
    // so accepting upper-case/space-padded legacy values would break TEXT FK
    // children after recreation.
    const { rows: nonCanonical } = await db.query(
      `SELECT count(*)::text AS n FROM ${quoteIdentifier(table)}
        WHERE ${quoteIdentifier(sourceColumn)} IS NOT NULL
          AND ${quoteIdentifier(sourceColumn)} !~ '${UUID_RE}'`,
    );
    if (
      Number((nonCanonical[0] as Record<string, unknown> | undefined)?.n ?? 0) >
      0
    ) {
      throw new Error(
        `Refusing ${table}.${sourceColumn}: its generated TEXT bridge requires canonical lower-case UUID text; normalize or remove non-canonical values before migration.`,
      );
    }
    bridges.push({
      table,
      column: bridgeColumn,
      sourceColumn,
      indexDefinitions: await snapshotBridgeIndexes(db, table, bridgeColumn),
    });
  }
  return bridges.sort((a, b) =>
    `${a.table}.${a.column}`.localeCompare(`${b.table}.${b.column}`),
  );
}

async function snapshotBridgeIndexes(
  db: QueryExecutor,
  table: string,
  column: string,
): Promise<Array<{ definition: string; comment: string | null }>> {
  const { rows } = await db.query(
    `SELECT pg_get_indexdef(index_rel.oid) AS definition,
            obj_description(index_rel.oid, 'pg_class') AS comment,
            idx.indnkeyatts AS key_count, idx.indpred IS NOT NULL AS partial,
            idx.indexprs IS NOT NULL AS expression_index, idx.indisvalid AS valid,
            am.amname AS method
       FROM pg_index idx
       JOIN pg_class table_rel ON table_rel.oid = idx.indrelid
       JOIN pg_namespace ns ON ns.oid = table_rel.relnamespace
       JOIN pg_class index_rel ON index_rel.oid = idx.indexrelid
       JOIN pg_am am ON am.oid = index_rel.relam
       JOIN pg_attribute attr ON attr.attrelid = table_rel.oid AND attr.attnum = ANY(idx.indkey)
      WHERE ns.nspname = 'public' AND table_rel.relname = ${quoteLiteral(table)}
        AND attr.attname = ${quoteLiteral(column)}`,
  );
  return (rows as Array<Record<string, unknown>>).map((row) => {
    if (
      Number(row.key_count) !== 1 ||
      row.partial ||
      row.expression_index ||
      !row.valid ||
      row.method !== 'btree'
    ) {
      throw new Error(
        `Unsupported index depending on generated bridge ${table}.${column}; only one-key valid btree indexes can be reconstructed safely.`,
      );
    }
    return {
      definition: String(row.definition),
      comment: row.comment == null ? null : String(row.comment),
    };
  });
}

async function snapshotForeignKeys(
  db: QueryExecutor,
  columns: PostgresColumn[],
  bridges: GeneratedBridgeSnapshot[],
): Promise<ForeignKeySnapshot[]> {
  const converted = new Set(
    columns.map((column) => declaredUuidKey(column.table, column.column)),
  );
  const bridgeColumns = new Set(
    bridges.map((bridge) => declaredUuidKey(bridge.table, bridge.column)),
  );
  const { rows } = await db.query(
    `SELECT con.oid, child.relname AS child_table, con.conname AS name,
            parent.relname AS parent_table, con.convalidated AS validated,
            pg_get_constraintdef(con.oid) AS definition,
            obj_description(con.oid, 'pg_constraint') AS comment,
            array_length(con.conkey, 1) AS child_keys,
            array_length(con.confkey, 1) AS parent_keys,
            child_attr.attname AS child_column, parent_attr.attname AS parent_column
       FROM pg_constraint con
       JOIN pg_class child ON child.oid = con.conrelid
       JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
       JOIN pg_class parent ON parent.oid = con.confrelid
       JOIN unnest(con.conkey) WITH ORDINALITY child_key(attnum, ord) ON true
       JOIN unnest(con.confkey) WITH ORDINALITY parent_key(attnum, ord) ON parent_key.ord = child_key.ord
       JOIN pg_attribute child_attr ON child_attr.attrelid = child.oid AND child_attr.attnum = child_key.attnum
       JOIN pg_attribute parent_attr ON parent_attr.attrelid = parent.oid AND parent_attr.attnum = parent_key.attnum
      WHERE con.contype = 'f' AND child_ns.nspname = 'public'`,
  );
  const participating: ForeignKeySnapshot[] = [];
  for (const row of rows as Array<Record<string, unknown>>) {
    const child = declaredUuidKey(
      String(row.child_table),
      String(row.child_column),
    );
    const parent = declaredUuidKey(
      String(row.parent_table),
      String(row.parent_column),
    );
    if (
      !converted.has(child) &&
      !converted.has(parent) &&
      !bridgeColumns.has(child) &&
      !bridgeColumns.has(parent)
    )
      continue;
    if (Number(row.child_keys) !== 1 || Number(row.parent_keys) !== 1) {
      throw new Error(
        `Unsupported multi-column foreign key ${String(row.name)} touches UUID migration component.`,
      );
    }
    // A TEXT child may reference a generated TEXT bridge. Every other edge
    // touching a converted endpoint must remain inside the declared UUID set.
    const bridgeEdge = bridgeColumns.has(child) || bridgeColumns.has(parent);
    if (bridgeEdge && (converted.has(child) || converted.has(parent))) {
      throw new Error(
        `Foreign key ${String(row.name)} mixes a UUID-converted endpoint with a retained TEXT generated bridge; refusing incompatible recreation.`,
      );
    }
    if (!bridgeEdge && (!converted.has(child) || !converted.has(parent))) {
      throw new Error(
        `Foreign key ${String(row.name)} crosses a UUID conversion component boundary (${child} → ${parent}); declare both endpoints UUID or migrate it separately.`,
      );
    }
    participating.push({
      table: String(row.child_table),
      name: String(row.name),
      definition: String(row.definition),
      validated: Boolean(row.validated),
      comment: row.comment == null ? null : String(row.comment),
    });
  }
  return participating.sort((a, b) =>
    `${a.table}.${a.name}`.localeCompare(`${b.table}.${b.name}`),
  );
}

function indexNameFromDefinition(definition: string): string {
  const match = definition.match(/^CREATE(?: UNIQUE)? INDEX (.+?) ON /i);
  if (!match)
    throw new Error(
      `Cannot preserve generated bridge index comment: unsupported index definition ${definition}`,
    );
  return match[1];
}

/**
 * Apply the R3 rename backfills: copy `old → new` where `new` is still empty,
 * then drop `old`. Idempotent (a missing source column is skipped).
 *
 * When `ownTransaction` is true this wraps the work in its own
 * `BEGIN`/`COMMIT`/`ROLLBACK`. When false the caller owns the surrounding
 * transaction (the shared rename+convert transaction) and is responsible for
 * commit/rollback — so a conversion failure later can roll these renames back
 * too. A dry run executes nothing regardless.
 */
async function applyRenameBackfills(
  db: DatabaseInterface,
  isPostgres: boolean,
  renameSpecs: RenameSpec[],
  dryRun: boolean,
  { ownTransaction }: { ownTransaction: boolean },
): Promise<void> {
  console.log(
    `${dryRun ? 'DRY RUN — would apply' : 'Applying'} ${renameSpecs.length} rename backfill(s):`,
  );

  const useOwnTxn = ownTransaction && !dryRun;
  if (useOwnTxn) await db.query('BEGIN');
  try {
    for (const spec of renameSpecs) {
      const t = quoteIdentifier(spec.table);
      const from = quoteIdentifier(spec.from);
      const to = quoteIdentifier(spec.to);

      // Skip if the old column is already gone (idempotent re-run).
      const fromExists = await columnExists(
        db,
        isPostgres,
        spec.table,
        spec.from,
      );
      if (!fromExists) {
        console.log(
          `  - ${spec.table}.${spec.from} → ${spec.to}: source column absent (already migrated), skipping.`,
        );
        continue;
      }
      const toExists = await columnExists(db, isPostgres, spec.table, spec.to);
      if (!toExists) {
        throw new Error(
          `${spec.table}.${spec.to} is missing. Run \`smrt db:migrate\` first to add it, then re-run.`,
        );
      }

      const toIsUuid =
        isPostgres && (await columnIsUuid(db, spec.table, spec.to));
      const copyExpr = toIsUuid
        ? isPostgres
          ? `NULLIF(btrim(${from}), '')::uuid`
          : `NULLIF(btrim(${from}), '')`
        : isPostgres
          ? `NULLIF(btrim(${from}), '')`
          : `NULLIF(trim(${from}), '')`;

      // Only copy where the destination is still empty so re-runs are safe.
      const update = `UPDATE ${t} SET ${to} = ${copyExpr} WHERE ${nullifEmpty(isPostgres, from)} IS NOT NULL AND ${to} IS NULL`;
      const drop = `ALTER TABLE ${t} DROP COLUMN ${from}`;

      console.log(`  ${update};`);
      console.log(`  ${drop};`);
      if (!dryRun) {
        await db.query(update);
        await db.query(drop);
      }
    }
    if (useOwnTxn) await db.query('COMMIT');
  } catch (error) {
    if (useOwnTxn) {
      try {
        await db.query('ROLLBACK');
      } catch {
        // ignore
      }
    }
    throw error;
  }
  console.log();
}

/**
 * Discover + load the SMRT manifest (cwd-relative, exactly like `db:diff`) and
 * return the set of `${table}|${column}` keys the schema declares as native
 * `UUID`. Returns an empty set when no manifest is found or it declares no UUID
 * columns — the caller treats that as fail-closed (convert nothing).
 */
async function loadDeclaredUuidColumns(): Promise<Set<string>> {
  // Populate the ObjectRegistry from manifests in the project cwd /
  // node_modules. ManifestBuilder + registry are cwd-relative (#1331/#1332),
  // so this only works when run from the project root. A discovery failure is
  // non-fatal: the registry may already be populated; we still read it below
  // and the empty-set fail-closed gate in the handler is the safety net.
  let discoveryFailed = false;
  try {
    await autoDiscoverAndLoad();
  } catch (error) {
    discoveryFailed = true;
    console.warn(
      `Failed to auto-discover SMRT manifests for declared-UUID gating: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const schemaDefinitions = ObjectRegistry.getAllSchemasAsDefinitions();
    const declared = buildDeclaredUuidColumnSet(schemaDefinitions);
    // The empty-set fail-closed gate only fires when NOTHING is declared. A
    // partial discovery failure can leave a non-empty-but-incomplete set, which
    // slips past that gate and silently leaves some declared-UUID columns as
    // TEXT (recoverable false-negatives). Surface that explicitly.
    if (discoveryFailed && declared.size > 0) {
      console.warn(
        'Manifest discovery partially failed — the declared-UUID set may be INCOMPLETE; ' +
          'some packages may not have been scanned, so some uuid columns could be silently left as TEXT. ' +
          'Resolve the discovery error above and re-run from the project root before trusting the conversion.',
      );
    }
    return declared;
  } catch (error) {
    console.warn(
      `Failed to read declared schema for UUID gating: ${error instanceof Error ? error.message : String(error)}`,
    );
    return new Set<string>();
  }
}

async function columnExists(
  db: DatabaseInterface,
  isPostgres: boolean,
  table: string,
  column: string,
): Promise<boolean> {
  if (isPostgres) {
    const { rows } = await db.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = '${table.replaceAll("'", "''")}'
          AND column_name = '${column.replaceAll("'", "''")}'`,
    );
    return rows.length > 0;
  }
  // SQLite / DuckDB: PRAGMA-style introspection.
  try {
    const { rows } = await db.query(
      `PRAGMA table_info(${quoteIdentifier(table)})`,
    );
    return rows.some((r) => r.name === column);
  } catch {
    return false;
  }
}

async function columnIsUuid(
  db: DatabaseInterface,
  table: string,
  column: string,
): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = '${table.replaceAll("'", "''")}'
        AND column_name = '${column.replaceAll("'", "''")}'`,
  );
  return rows[0]?.data_type === 'uuid';
}
