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

// PostgreSQL's `::uuid` cast also accepts the bare 32-hex form (no hyphens) as
// the identical value to its canonical hyphenated form — but NOT braces or
// partial hyphenation. Accept both forms at the shape probes that gate a
// TEXT→uuid TYPE conversion (candidate shape probe, rename-source probe): the
// column becomes a native `uuid` either way, and both input forms normalize
// to the same value.
const UUID_RE =
  '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$';

// The generated TEXT bridge stays TEXT — it is re-added as `sourceColumn::text`
// over the now-native-uuid column, and `uuid::text` always renders the
// canonical HYPHENATED form. A bridge column that held the bare-hex form
// would therefore come back re-hyphenated: a silent, irreversible rewrite of
// the exact literal the bridge exists to preserve for TEXT FK children. So
// the bridge sample probe stays canonical-hyphenated-only (case-sensitive,
// lower-case), never the widened alternation.
const CANONICAL_UUID_RE =
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

function renamedSourceColumns(renameSpecs: RenameSpec[]): Set<string> {
  return new Set(
    renameSpecs.map((spec) => declaredUuidKey(spec.table, spec.from)),
  );
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
  /**
   * Count of normalized-value groups with more than one distinct TEXT row
   * mapping to the same uuid (e.g. one hyphenated, one bare-hex row for the
   * same value) — a many-to-one collision the widened shape probe admits.
   * Optional/defaults to 0 so existing call sites need not set it.
   */
  duplicateNormalized?: number;
}

/**
 * The outcome of classifying live TEXT columns against the declared-UUID set.
 */
export interface ConversionPlan {
  convert: ConvertCandidate[];
  /**
   * Declared-UUID columns whose data still has non-uuid values, and/or two or
   * more TEXT rows that normalize to the same uuid (a post-normalization
   * collision — `duplicateNormalized` is present only when > 0).
   */
  skipDirtyData: Array<{
    table: string;
    column: string;
    nonUuid: number;
    duplicateNormalized?: number;
  }>;
  /** Live TEXT columns the schema does NOT declare as UUID (left as TEXT). */
  skipNotDeclared: Array<{ table: string; column: string }>;
  /**
   * Otherwise-convertible columns blocked because a foreign-key partner
   * (transitively) will not convert. Populated by
   * `propagateBlockedForeignKeyPartners`; absent/empty before that step runs.
   */
  skipBlockedPartner?: Array<{ table: string; column: string; reason: string }>;
}

/** A single-column foreign key edge between two candidate columns. */
export interface ForeignKeyEdge {
  name: string;
  childTable: string;
  childColumn: string;
  parentTable: string;
  parentColumn: string;
}

/**
 * Propagate skips across foreign-key edges to a fixpoint.
 *
 * `db:migrate-uuid` converts a column only when BOTH its declared-UUID/clean
 * data gates pass (see `planUuidConversions`) AND every foreign-key partner
 * of it will also convert — otherwise `ALTER TABLE … ADD CONSTRAINT` at
 * recreation time would fail with a text/uuid type mismatch. Rather than
 * aborting the whole run, block the convertible partner too: a column
 * skipped for dirty data or because the schema intentionally keeps it TEXT
 * blocks every foreign-key partner of it, and that block propagates
 * transitively (a two-hop chain blocks both hops).
 *
 * Pure and DB-independent: `edges` is the full set of single-column foreign
 * keys touching the candidate columns, discovered separately. Multi-column
 * foreign keys are out of scope here and stay a hard refusal downstream.
 */
/** Human-readable reason for one `skipDirtyData` entry — shared by dry-run/apply logging and FK-block-propagation reasons. */
function dirtyDataReason(
  item: ConversionPlan['skipDirtyData'][number],
): string {
  const parts: string[] = [];
  if (item.nonUuid > 0) parts.push(`${item.nonUuid} non-uuid value(s)`);
  if (item.duplicateNormalized)
    parts.push(
      `${item.duplicateNormalized} duplicate value(s) after normalization`,
    );
  return parts.join(', ');
}

export function propagateBlockedForeignKeyPartners(
  plan: ConversionPlan,
  edges: ForeignKeyEdge[],
): ConversionPlan {
  const convertByKey = new Map(
    plan.convert.map((candidate) => [
      declaredUuidKey(candidate.table, candidate.column),
      candidate,
    ]),
  );
  const blockedReason = new Map<string, string>();
  for (const item of plan.skipDirtyData) {
    blockedReason.set(
      declaredUuidKey(item.table, item.column),
      dirtyDataReason(item),
    );
  }
  for (const item of plan.skipNotDeclared) {
    blockedReason.set(
      declaredUuidKey(item.table, item.column),
      'not schema-declared UUID',
    );
  }

  const skipBlockedPartner: NonNullable<ConversionPlan['skipBlockedPartner']> =
    [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      const childKey = declaredUuidKey(edge.childTable, edge.childColumn);
      const parentKey = declaredUuidKey(edge.parentTable, edge.parentColumn);
      const childBlockedReason = blockedReason.get(childKey);
      const parentBlockedReason = blockedReason.get(parentKey);

      if (
        childBlockedReason !== undefined &&
        parentBlockedReason === undefined &&
        convertByKey.has(parentKey)
      ) {
        const candidate = convertByKey.get(parentKey);
        if (!candidate) continue;
        const reason = `blocked by foreign key ${edge.name} to ${edge.childTable}.${edge.childColumn} (${childBlockedReason})`;
        blockedReason.set(parentKey, reason);
        convertByKey.delete(parentKey);
        skipBlockedPartner.push({
          table: candidate.table,
          column: candidate.column,
          reason,
        });
        changed = true;
        continue;
      }

      if (
        parentBlockedReason !== undefined &&
        childBlockedReason === undefined &&
        convertByKey.has(childKey)
      ) {
        const candidate = convertByKey.get(childKey);
        if (!candidate) continue;
        const reason = `blocked by foreign key ${edge.name} to ${edge.parentTable}.${edge.parentColumn} (${parentBlockedReason})`;
        blockedReason.set(childKey, reason);
        convertByKey.delete(childKey);
        skipBlockedPartner.push({
          table: candidate.table,
          column: candidate.column,
          reason,
        });
        changed = true;
      }
    }
  }

  return {
    convert: [...convertByKey.values()],
    skipDirtyData: plan.skipDirtyData,
    skipNotDeclared: plan.skipNotDeclared,
    skipBlockedPartner,
  };
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
    const duplicateNormalized = col.duplicateNormalized ?? 0;
    if (col.nonUuid > 0 || duplicateNormalized > 0) {
      // Gate 2 failed: declared UUID but data is not all-uuid, OR two+ TEXT
      // rows normalize to the same uuid (a PK/unique conflict waiting to
      // happen at ALTER time). Operator cleans/dedupes.
      skipDirtyData.push({
        table: col.table,
        column: col.column,
        nonUuid: col.nonUuid,
        ...(duplicateNormalized > 0 ? { duplicateNormalized } : {}),
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
        await applyRenameOnlyBackfills(db, isPostgres, renameSpecs, dryRun);
        console.log('Skipping TEXT→uuid conversion (--skip-convert).\n');
        return;
      }

      if (!isPostgres) {
        await applyRenameOnlyBackfills(db, isPostgres, renameSpecs, dryRun);
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
        await applyRenameOnlyBackfills(db, isPostgres, renameSpecs, dryRun);
        return;
      }

      if (dryRun) {
        await applyRenameBackfills(db, isPostgres, renameSpecs, true, {
          ownTransaction: false,
        });
        await convertPostgresUuidColumns(
          db,
          declaredUuid,
          true,
          true,
          renamedSourceColumns(renameSpecs),
          renameSpecs,
        );
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
        // This is a read-only safety preflight, not the operator-requested
        // dry run.  Suppress preview wording so a subsequently mutating run
        // never claims that no changes were applied.
        await convertPostgresUuidColumns(
          db,
          declaredUuid,
          true,
          false,
          renamedSourceColumns(renameSpecs),
          renameSpecs,
        );
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

/** Execute a rename-only PostgreSQL mutation on the transaction callback. */
async function applyRenameOnlyBackfills(
  db: DatabaseInterface,
  isPostgres: boolean,
  renameSpecs: RenameSpec[],
  dryRun: boolean,
): Promise<void> {
  if (!isPostgres || dryRun) {
    await applyRenameBackfills(db, isPostgres, renameSpecs, dryRun, {
      ownTransaction: !dryRun,
    });
    return;
  }
  if (renameSpecs.length === 0) {
    await applyRenameBackfills(db, true, renameSpecs, false, {
      ownTransaction: false,
    });
    return;
  }
  if (!db.transaction) {
    throw new Error(
      'PostgreSQL UUID migration requires DatabaseInterface.transaction(); refusing to run unpinned DDL.',
    );
  }
  await db.transaction(async (tx) => {
    await applyRenameBackfills(tx, true, renameSpecs, false, {
      ownTransaction: false,
    });
  });
}

type QueryExecutor = Pick<DatabaseInterface, 'query'>;

interface PostgresColumn extends ConvertCandidate {
  defaultExpression: string | null;
  relationOid: string;
  attributeNumber: number;
  typeName: string;
}

interface ForeignKeySnapshot {
  oid: string;
  table: string;
  name: string;
  definition: string;
  validated: boolean;
  comment: string | null;
}

interface GeneratedBridgeSnapshot {
  tableOid: string;
  attributeNumber: number;
  attributeDefaultOid: string;
  statisticsTarget: number | null;
  compression: string;
  table: string;
  column: string;
  sourceColumn: string;
  indexDefinitions: Array<{
    oid: string;
    schema: string;
    name: string;
    definition: string;
    comment: string | null;
    clustered: boolean;
    replicaIdentity: boolean;
  }>;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** PostgreSQL relation reference in the migration's fixed public schema. */
function pgTable(table: string): string {
  return `${quoteIdentifier('public')}.${quoteIdentifier(table)}`;
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
  renderDryRun = true,
  excludedColumns = new Set<string>(),
  projectedRenames: RenameSpec[] = [],
): Promise<void> {
  const { rows: candidateRows } = await db.query(
    `SELECT cols.table_name, cols.column_name, cols.column_default,
              relation.oid::text AS relation_oid, attribute.attnum AS attribute_number,
              format_type(attribute.atttypid, attribute.atttypmod) AS type_name
         FROM information_schema.columns cols
         JOIN pg_namespace namespace ON namespace.nspname = cols.table_schema
         JOIN pg_class relation ON relation.relnamespace = namespace.oid AND relation.relname = cols.table_name
         JOIN pg_attribute attribute ON attribute.attrelid = relation.oid AND attribute.attname = cols.column_name
        WHERE cols.table_schema = 'public' AND cols.data_type = 'text'
        AND (column_name = 'id' OR column_name ~* '(_id|Id)$')
      ORDER BY table_name, column_name`,
  );
  const liveColumns: LiveTextColumn[] = [];
  const defaults = new Map<string, string | null>();
  for (const row of candidateRows as Array<Record<string, unknown>>) {
    const table = String(row.table_name);
    const column = String(row.column_name);
    // Rename backfills drop their source before the authoritative conversion
    // scan. A dry/preflight scan still sees that source, so exclude it from
    // the projected conversion component rather than previewing a TYPE ALTER
    // that apply can never execute.
    if (excludedColumns.has(declaredUuidKey(table, column))) continue;
    let nonUuid = 0;
    let duplicateNormalized = 0;
    if (declaredUuid.has(declaredUuidKey(table, column))) {
      const { rows } = await db.query(
        `SELECT count(*)::text AS n FROM ${pgTable(table)}
          WHERE nullif(btrim(${quoteIdentifier(column)}), '') IS NOT NULL
            AND btrim(${quoteIdentifier(column)}) !~* '${UUID_RE}'`,
      );
      nonUuid = Number(
        (rows[0] as Record<string, unknown> | undefined)?.n ?? 0,
      );
      // TEXT→uuid is many-to-one: the widened shape probe now accepts both
      // the hyphenated and bare-hex forms of the SAME value, so two
      // DIFFERENT, individually-valid TEXT strings can normalize to the same
      // uuid. That is only a problem for a column covered by a unique/PK
      // index (single-key OR composite — SMRT itself generates composite
      // UNIQUE(tenant_id, slug, context) indexes on tenant-scoped tables) —
      // `ALTER COLUMN … TYPE uuid` rebuilds every such index and fails with
      // a duplicate-key error, aborting the whole transaction. A column with
      // no unique index at all normalizing several rows to the same value is
      // the intended, harmless outcome (e.g. an ordinary FK column with
      // mixed-case or mixed hyphenation across rows), so only probe columns
      // actually covered by SOME unique index — flagging every declared-
      // UUID column would itself falsely block otherwise-clean, unindexed
      // data (and propagate that false block to FK partners).
      const uniqueIndexes = await findUniqueIndexKeyColumns(
        db,
        String(row.relation_oid),
        Number(row.attribute_number),
      );
      for (const { keyColumns, nullsNotDistinct } of uniqueIndexes) {
        const otherColumns = keyColumns.filter((c) => c.name !== column);
        // Build each other key column's GROUP BY expression:
        //   - a column that is ITSELF a declared-UUID candidate converting
        //     in the SAME run (e.g. UNIQUE(source_id, target_id) where both
        //     are declared UUID) must be grouped on its normalized value
        //     too, not its raw TEXT — otherwise two rows that collide only
        //     AFTER both columns convert (one hyphenated, one bare-hex on
        //     EACH side) stay in different groups and the collision is
        //     missed, reintroducing the whole-run abort this probe exists
        //     to prevent. Guarded with CASE so a row whose other-column
        //     value is not itself uuid-shaped (dirty data on that column)
        //     falls back to its raw text rather than erroring the cast.
        //   - a column already native `uuid` (e.g. converted in an earlier
        //     run) needs no cast at all.
        //   - anything else (a column that will never convert, e.g. `slug`)
        //     groups on its raw value, unchanged.
        const otherColumnExpr = (other: UniqueIndexKeyColumn): string => {
          const quoted = quoteIdentifier(other.name);
          if (other.typeName === 'uuid') return quoted;
          if (declaredUuid.has(declaredUuidKey(table, other.name))) {
            return `CASE WHEN btrim(${quoted}) ~* '${UUID_RE}' THEN NULLIF(btrim(${quoted}), '')::uuid::text ELSE ${quoted} END`;
          }
          return quoted;
        };
        // PostgreSQL's default NULLS DISTINCT means a NULL in an other key
        // column can never collide with anything, however the rest of the
        // row compares — exclude those rows from the group entirely rather
        // than let a shared NULL falsely group two otherwise-unrelated rows
        // together (a false collision that would needlessly skip, and
        // propagate-block, an otherwise-clean column).
        const nullGuards = nullsNotDistinct
          ? []
          : otherColumns.map(
              (other) => `${quoteIdentifier(other.name)} IS NOT NULL`,
            );
        // This must count DISTINCT RAW (un-trimmed) TEXT forms of THIS
        // column per group, not rows and not trimmed forms:
        //   - grouping by the index's OTHER key columns too (composite
        //     case): a collision only violates THIS index when every other
        //     key column also matches — two rows that share a normalized
        //     `tenant_id` but differ in `slug` never collide on
        //     UNIQUE(tenant_id, slug, context). Empty for a single-key
        //     index, which degenerates to grouping on the normalized value
        //     alone.
        //   - not rows: an ordinary repeat of the same (identical) TEXT
        //     value across many rows under the SAME unique key cannot
        //     happen (the unique index already forbids it), but guard it
        //     anyway rather than assume — no unique index is violated by
        //     rows that were already byte-identical TEXT.
        //   - not trimmed forms: the conversion's own `USING` clause also
        //     btrims before casting, so two rows differing only by leading
        //     or trailing whitespace (' <uuid>' vs '<uuid>') are just as
        //     collision-prone as a hyphen/bare-hex pair, and counting on
        //     the trimmed value would hide exactly that case.
        const groupBy = [
          ...otherColumns.map(otherColumnExpr),
          `NULLIF(btrim(${quoteIdentifier(column)}), '')::uuid`,
        ].join(', ');
        const whereClause = [
          `nullif(btrim(${quoteIdentifier(column)}), '') IS NOT NULL`,
          `btrim(${quoteIdentifier(column)}) ~* '${UUID_RE}'`,
          ...nullGuards,
        ].join(' AND ');
        const { rows: dupRows } = await db.query(
          `SELECT count(*)::text AS n FROM (
               SELECT 1
                 FROM ${pgTable(table)}
                WHERE ${whereClause}
                GROUP BY ${groupBy}
               HAVING count(DISTINCT ${quoteIdentifier(column)}) > 1
             ) collisions`,
        );
        const found = Number(
          (dupRows[0] as Record<string, unknown> | undefined)?.n ?? 0,
        );
        if (found > 0) {
          duplicateNormalized += found;
          // One flagged unique index is enough to force the skip; other
          // covering indexes would only add noise to the reported count.
          break;
        }
      }
    }
    liveColumns.push({
      table,
      column,
      hasDefault: row.column_default != null,
      nonUuid,
      duplicateNormalized,
    });
    defaults.set(
      declaredUuidKey(table, column),
      row.column_default == null ? null : String(row.column_default),
    );
  }
  // Apply copies a source only into an empty destination before scanning it.
  // Project dirty copied values into dry/preflight eligibility so the plan
  // never promises a TYPE ALTER that the authoritative scan will skip.
  for (const spec of projectedRenames) {
    const destination = liveColumns.find(
      (column) => column.table === spec.table && column.column === spec.to,
    );
    if (!destination || !declaredUuid.has(declaredUuidKey(spec.table, spec.to)))
      continue;
    const { rows: source } = await db.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = ${quoteLiteral(spec.table)}
          AND column_name = ${quoteLiteral(spec.from)}`,
    );
    // Mirror applyRenameBackfills: an already-dropped source is an idempotent
    // skip, not an error during dry-run or the read-only preflight.
    if (source.length === 0) continue;
    const { rows } = await db.query(
      `SELECT count(*)::text AS n FROM ${pgTable(spec.table)}
        WHERE ${nullifEmpty(true, quoteIdentifier(spec.from))} IS NOT NULL
          AND ${quoteIdentifier(spec.to)} IS NULL
          AND btrim(${quoteIdentifier(spec.from)}) !~* '${UUID_RE}'`,
    );
    destination.nonUuid += Number(
      (rows[0] as Record<string, unknown> | undefined)?.n ?? 0,
    );
  }
  const initialPlan = planUuidConversions(liveColumns, declaredUuid);
  const { skipDirtyData, skipNotDeclared } = initialPlan;
  // A convertible column whose foreign-key partner will not convert (dirty
  // data, or a column the schema deliberately keeps TEXT) must be blocked
  // too, transitively, or the FK recreation step below fails with a
  // text/uuid mismatch instead of the conversion being safely skipped.
  const foreignKeyEdges = await fetchSingleColumnForeignKeyEdges(db);
  const { convert, skipBlockedPartner = [] } =
    propagateBlockedForeignKeyPartners(initialPlan, foreignKeyEdges);
  console.log(
    `Found ${candidateRows.length} TEXT id/FK column(s): ${convert.length} convertible, ${skipDirtyData.length + skipNotDeclared.length + skipBlockedPartner.length} skipped.`,
  );
  for (const item of skipDirtyData)
    console.log(
      `  SKIP ${item.table}.${item.column}: ${dirtyDataReason(item)}`,
    );
  for (const item of skipNotDeclared)
    console.log(
      `  SKIP ${item.table}.${item.column}: not schema-declared UUID`,
    );
  for (const item of skipBlockedPartner)
    console.log(`  SKIP ${item.table}.${item.column}: ${item.reason}`);
  if (convert.length === 0) {
    console.log('\nNothing to convert. Done.\n');
    return;
  }

  const columns: PostgresColumn[] = convert.map((column) => ({
    ...column,
    defaultExpression:
      defaults.get(declaredUuidKey(column.table, column.column)) ?? null,
    relationOid: String(
      (candidateRows as Array<Record<string, unknown>>).find(
        (row) =>
          String(row.table_name) === column.table &&
          String(row.column_name) === column.column,
      )?.relation_oid,
    ),
    attributeNumber: Number(
      (candidateRows as Array<Record<string, unknown>>).find(
        (row) =>
          String(row.table_name) === column.table &&
          String(row.column_name) === column.column,
      )?.attribute_number,
    ),
    typeName: String(
      (candidateRows as Array<Record<string, unknown>>).find(
        (row) =>
          String(row.table_name) === column.table &&
          String(row.column_name) === column.column,
      )?.type_name,
    ),
  }));
  await assertSupportedSourceColumns(db, columns);
  const bridges = await snapshotGeneratedBridges(db, columns);
  const foreignKeys = await snapshotForeignKeys(db, columns, bridges);
  await assertSupportedBridgeDependencies(db, bridges, foreignKeys);
  const tables = [
    ...new Set([
      ...columns.map((column) => column.table),
      ...bridges.map((bridge) => bridge.table),
      ...foreignKeys.map((foreignKey) => foreignKey.table),
    ]),
  ].sort();

  if (dryRun) {
    if (!renderDryRun) return;
    console.log(
      `\nDRY RUN — dependency plan for ${columns.length} conversion(s):`,
    );
    for (const table of tables)
      console.log(`  LOCK TABLE ${pgTable(table)} IN ACCESS EXCLUSIVE MODE;`);
    renderUuidConversionSql(columns, bridges, foreignKeys);
    console.log('\nDry run complete — no changes applied.\n');
    return;
  }

  // Locks prevent a DDL/data race between the plan and mutation.  Re-read the
  // whole bounded catalog after acquiring them; any changed shape is refused.
  for (const table of tables) {
    await db.query(`LOCK TABLE ${pgTable(table)} IN ACCESS EXCLUSIVE MODE`);
  }
  // A concurrent session can attach an inherited child after the original
  // preflight but before our first lock. Recheck the supported table shape
  // while holding the planned tables: ALTER TYPE on a parent recurses to an
  // undeclared child, so proceeding would exceed the declared source scope.
  await assertSupportedSourceColumns(db, columns);
  for (const column of columns) {
    const { rows } = await db.query(
      `SELECT cols.column_default, relation.oid::text AS relation_oid,
              attribute.attnum AS attribute_number,
              format_type(attribute.atttypid, attribute.atttypmod) AS type_name
         FROM information_schema.columns cols
         JOIN pg_namespace namespace ON namespace.nspname = cols.table_schema
         JOIN pg_class relation ON relation.relnamespace = namespace.oid AND relation.relname = cols.table_name
         JOIN pg_attribute attribute ON attribute.attrelid = relation.oid AND attribute.attname = cols.column_name
        WHERE cols.table_schema = 'public'
          AND cols.table_name = ${quoteLiteral(column.table)}
          AND cols.column_name = ${quoteLiteral(column.column)}`,
    );
    const lockedDefault =
      (rows[0] as Record<string, unknown> | undefined)?.column_default == null
        ? null
        : String((rows[0] as Record<string, unknown>).column_default);
    const locked = rows[0] as Record<string, unknown> | undefined;
    if (
      lockedDefault !== column.defaultExpression ||
      String(locked?.relation_oid) !== column.relationOid ||
      Number(locked?.attribute_number) !== column.attributeNumber ||
      String(locked?.type_name) !== column.typeName
    ) {
      throw new Error(
        `UUID source identity, type, or default changed while locks were acquired for ${column.table}.${column.column}; refusing stale migration plan. Re-run the command.`,
      );
    }
  }
  const rescannedBridges = await snapshotGeneratedBridges(db, columns);
  const rescannedForeignKeys = await snapshotForeignKeys(
    db,
    columns,
    rescannedBridges,
  );
  await assertSupportedBridgeDependencies(
    db,
    rescannedBridges,
    rescannedForeignKeys,
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
      `ALTER TABLE ${pgTable(foreignKey.table)} DROP CONSTRAINT ${quoteIdentifier(foreignKey.name)}`,
    );
  }
  for (const bridge of bridges) {
    await db.query(
      `ALTER TABLE ${pgTable(bridge.table)} DROP COLUMN ${quoteIdentifier(bridge.column)}`,
    );
  }
  for (const column of columns) {
    const table = pgTable(column.table);
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
      `ALTER TABLE ${pgTable(bridge.table)} ADD COLUMN ${quoteIdentifier(bridge.column)} text GENERATED ALWAYS AS (${quoteIdentifier(bridge.sourceColumn)}::text) STORED`,
    );
    if (bridge.statisticsTarget != null && bridge.statisticsTarget !== -1)
      await db.query(
        `ALTER TABLE ${pgTable(bridge.table)} ALTER COLUMN ${quoteIdentifier(bridge.column)} SET STATISTICS ${bridge.statisticsTarget}`,
      );
    if (bridge.compression)
      await db.query(
        `ALTER TABLE ${pgTable(bridge.table)} ALTER COLUMN ${quoteIdentifier(bridge.column)} SET COMPRESSION ${bridge.compression === 'l' ? 'lz4' : 'pglz'}`,
      );
  }
  for (const { index, table } of uniqueBridgeIndexes(bridges)) {
    await db.query(index.definition);
    if (index.comment)
      await db.query(
        `COMMENT ON INDEX ${quoteIdentifier(index.schema)}.${quoteIdentifier(index.name)} IS ${quoteLiteral(index.comment)}`,
      );
    if (index.clustered)
      await db.query(
        `ALTER TABLE ${pgTable(table)} CLUSTER ON ${quoteIdentifier(index.name)}`,
      );
    if (index.replicaIdentity)
      await db.query(
        `ALTER TABLE ${pgTable(table)} REPLICA IDENTITY USING INDEX ${quoteIdentifier(index.name)}`,
      );
  }
  for (const foreignKey of foreignKeys) {
    await db.query(
      `ALTER TABLE ${pgTable(foreignKey.table)} ADD CONSTRAINT ${quoteIdentifier(foreignKey.name)} ${foreignKey.definition}${foreignKey.validated ? '' : ' NOT VALID'}`,
    );
    if (foreignKey.comment)
      await db.query(
        `COMMENT ON CONSTRAINT ${quoteIdentifier(foreignKey.name)} ON ${pgTable(foreignKey.table)} IS ${quoteLiteral(foreignKey.comment)}`,
      );
  }
  console.log(`\n✓ Converted ${columns.length} column(s) to uuid.\n`);
}

function uniqueBridgeIndexes(bridges: GeneratedBridgeSnapshot[]) {
  return [
    ...new Map(
      bridges.flatMap((bridge) =>
        bridge.indexDefinitions.map((index) => [
          index.oid,
          { index, table: bridge.table },
        ]),
      ),
    ).values(),
  ];
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
      `  ALTER TABLE ${pgTable(foreignKey.table)} DROP CONSTRAINT ${quoteIdentifier(foreignKey.name)};`,
    );
  for (const bridge of bridges)
    console.log(
      `  ALTER TABLE ${pgTable(bridge.table)} DROP COLUMN ${quoteIdentifier(bridge.column)};`,
    );
  for (const column of columns) {
    const table = pgTable(column.table);
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
      `  ALTER TABLE ${pgTable(bridge.table)} ADD COLUMN ${quoteIdentifier(bridge.column)} text GENERATED ALWAYS AS (${quoteIdentifier(bridge.sourceColumn)}::text) STORED;`,
    );
    if (bridge.statisticsTarget != null && bridge.statisticsTarget !== -1)
      console.log(
        `  ALTER TABLE ${pgTable(bridge.table)} ALTER COLUMN ${quoteIdentifier(bridge.column)} SET STATISTICS ${bridge.statisticsTarget};`,
      );
    if (bridge.compression)
      console.log(
        `  ALTER TABLE ${pgTable(bridge.table)} ALTER COLUMN ${quoteIdentifier(bridge.column)} SET COMPRESSION ${bridge.compression === 'l' ? 'lz4' : 'pglz'};`,
      );
  }
  for (const { index, table } of uniqueBridgeIndexes(bridges)) {
    console.log(`  ${index.definition};`);
    if (index.comment)
      console.log(
        `  COMMENT ON INDEX ${quoteIdentifier(index.schema)}.${quoteIdentifier(index.name)} IS ${quoteLiteral(index.comment)};`,
      );
    if (index.clustered)
      console.log(
        `  ALTER TABLE ${pgTable(table)} CLUSTER ON ${quoteIdentifier(index.name)};`,
      );
    if (index.replicaIdentity)
      console.log(
        `  ALTER TABLE ${pgTable(table)} REPLICA IDENTITY USING INDEX ${quoteIdentifier(index.name)};`,
      );
  }
  for (const foreignKey of foreignKeys) {
    console.log(
      `  ALTER TABLE ${pgTable(foreignKey.table)} ADD CONSTRAINT ${quoteIdentifier(foreignKey.name)} ${foreignKey.definition}${foreignKey.validated ? '' : ' NOT VALID'};`,
    );
    if (foreignKey.comment)
      console.log(
        `  COMMENT ON CONSTRAINT ${quoteIdentifier(foreignKey.name)} ON ${pgTable(foreignKey.table)} IS ${quoteLiteral(foreignKey.comment)};`,
      );
  }
}

async function snapshotGeneratedBridges(
  db: QueryExecutor,
  columns: PostgresColumn[],
): Promise<GeneratedBridgeSnapshot[]> {
  const requested = new Set(
    columns.map((column) => declaredUuidKey(column.table, column.column)),
  );
  const { rows } = await db.query(
    `SELECT generated.oid::text AS table_oid, generated_attr.attnum AS attribute_number,
            def.oid::text AS attribute_default_oid,
            generated.relname AS table_name, generated_attr.attname AS column_name,
            pg_get_expr(def.adbin, def.adrelid) AS expression,
            format_type(generated_attr.atttypid, generated_attr.atttypmod) AS type_name,
            generated_attr.attnotnull AS not_null, generated_attr.attstorage AS storage,
            generated_attr.attstattarget AS statistics_target,
            generated_attr.attcompression AS compression,
            generated_attr.attoptions AS options,
            generated_attr.attacl IS NOT NULL AS has_acl,
            generated_attr.attcollation <> (SELECT typcollation FROM pg_type WHERE oid = generated_attr.atttypid) AS nondefault_collation,
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
      const sourceColumns = columns.filter(
        (column) => column.table === bridgeTable,
      );
      if (
        sourceColumns.length > 0 &&
        (await generatedColumnDependsOn(
          db,
          String(row.attribute_default_oid),
          String(row.table_oid),
          sourceColumns.map((column) => column.attributeNumber),
        ))
      ) {
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
      row.options != null ||
      row.has_acl ||
      row.nondefault_collation ||
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
    // so accepting upper-case/space-padded legacy values — or the bare-hex
    // shape, which would come back re-hyphenated by `uuid::text` — would
    // break TEXT FK children after recreation. Canonical-hyphenated-only,
    // deliberately narrower than the shape probes above.
    const { rows: nonCanonical } = await db.query(
      `SELECT count(*)::text AS n FROM ${pgTable(table)}
        WHERE ${quoteIdentifier(sourceColumn)} IS NOT NULL
          AND ${quoteIdentifier(sourceColumn)} !~ '${CANONICAL_UUID_RE}'`,
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
      tableOid: String(row.table_oid),
      attributeNumber: Number(row.attribute_number),
      attributeDefaultOid: String(row.attribute_default_oid),
      statisticsTarget:
        row.statistics_target == null ? null : Number(row.statistics_target),
      compression: String(row.compression),
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

/** Whether a generated expression actually references a converted source attr. */
async function generatedColumnDependsOn(
  db: QueryExecutor,
  attributeDefaultOid: string,
  tableOid: string,
  sourceAttributeNumbers: number[],
): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT EXISTS (
       SELECT 1 FROM pg_depend dep
        WHERE dep.classid = 'pg_attrdef'::regclass
          AND dep.objid = ${quoteLiteral(attributeDefaultOid)}::oid
          AND dep.refclassid = 'pg_class'::regclass
          AND dep.refobjid = ${quoteLiteral(tableOid)}::oid
          AND dep.refobjsubid IN (${sourceAttributeNumbers.join(', ')})
     ) AS depends_on_converted_column`,
  );
  return Boolean(
    (rows[0] as Record<string, unknown> | undefined)
      ?.depends_on_converted_column,
  );
}

async function snapshotBridgeIndexes(
  db: QueryExecutor,
  table: string,
  column: string,
): Promise<GeneratedBridgeSnapshot['indexDefinitions']> {
  const { rows } = await db.query(
    `SELECT index_rel.oid::text AS oid, index_ns.nspname AS index_schema,
            index_rel.relname AS index_name, pg_get_indexdef(index_rel.oid) AS definition,
            obj_description(index_rel.oid, 'pg_class') AS comment,
            idx.indnkeyatts AS key_count, idx.indpred IS NOT NULL AS partial,
            idx.indexprs IS NOT NULL AS expression_index, idx.indisvalid AS valid,
            idx.indisready AS ready, idx.indisclustered AS clustered,
            idx.indisreplident AS replica_identity,
            index_rel.reltablespace <> 0 AS nondefault_tablespace,
            am.amname AS method
       FROM pg_index idx
       JOIN pg_class table_rel ON table_rel.oid = idx.indrelid
       JOIN pg_namespace ns ON ns.oid = table_rel.relnamespace
       JOIN pg_class index_rel ON index_rel.oid = idx.indexrelid
       JOIN pg_namespace index_ns ON index_ns.oid = index_rel.relnamespace
       JOIN pg_am am ON am.oid = index_rel.relam
       JOIN pg_attribute attr ON attr.attrelid = table_rel.oid AND attr.attnum = ANY(idx.indkey)
      WHERE ns.nspname = 'public' AND table_rel.relname = ${quoteLiteral(table)}
        AND attr.attname = ${quoteLiteral(column)}
       ORDER BY index_ns.nspname, index_rel.relname, index_rel.oid`,
  );
  return (rows as Array<Record<string, unknown>>).map((row) => {
    if (
      Number(row.key_count) !== 1 ||
      row.partial ||
      row.expression_index ||
      !row.valid ||
      !row.ready ||
      row.nondefault_tablespace ||
      row.method !== 'btree'
    ) {
      throw new Error(
        `Unsupported index depending on generated bridge ${table}.${column}; only one-key valid btree indexes without a custom tablespace can be reconstructed safely.`,
      );
    }
    return {
      oid: String(row.oid),
      schema: String(row.index_schema),
      name: String(row.index_name),
      definition: String(row.definition),
      comment: row.comment == null ? null : String(row.comment),
      clustered: Boolean(row.clustered),
      replicaIdentity: Boolean(row.replica_identity),
    };
  });
}

/**
 * Discover every single-column foreign key in the `public` schema, keyed by
 * child/parent table+column. Used purely to feed
 * `propagateBlockedForeignKeyPartners` before the convert set is finalized;
 * multi-column foreign keys are excluded here and remain a hard refusal in
 * `snapshotForeignKeys` once the (reduced) convert set is known.
 */
/** One key column of a covering unique/PK index, with enough type info to
 * build a correct collision-detection GROUP BY over it. */
interface UniqueIndexKeyColumn {
  name: string;
  /** `format_type()` output, e.g. `text`, `uuid`. */
  typeName: string;
}

interface UniqueIndexCoverage {
  keyColumns: UniqueIndexKeyColumn[];
  /**
   * PostgreSQL's default is `NULLS DISTINCT`: two rows with NULL in the same
   * key column never collide, however their other columns compare. `false`
   * unless the index was declared `NULLS NOT DISTINCT` (PG 15+).
   */
  nullsNotDistinct: boolean;
}

/**
 * Every unique or primary-key index that covers `attnum` as a key column
 * (single-key or composite; INCLUDE-only columns are excluded via
 * `indnkeyatts`), returned as one entry per covering index — the probed
 * column included in `keyColumns`, so callers can filter it out to get the
 * index's "other" key columns for a composite collision check.
 *
 * A key column that is itself an expression (not a plain column reference)
 * has no `pg_attribute` row and is silently dropped from `keyColumns` by the
 * inner join below — the resulting collision check under-specifies that
 * index's true key, which only widens (never narrows) what it flags, so it
 * cannot hide a real collision; documented as a known imprecision rather
 * than fully modeled here.
 */
async function findUniqueIndexKeyColumns(
  db: QueryExecutor,
  relationOid: string,
  attnum: number,
): Promise<UniqueIndexCoverage[]> {
  // `indkey` is `int2vector`, whose cast to `int2[]` keeps its ORIGINAL
  // zero-based lower bound (unlike a normal array literal) — slicing it with
  // a one-based `[1:n]` silently returns empty. Slice `[0:n-1]` instead.
  //
  // `to_json(...)` (not bare `array_agg`/columns): this driver returns a raw
  // Postgres `{a,b}` array literal or scalar as an opaque string, not
  // parsed JS values — wrapping in `to_json` gets them parsed for us.
  //
  // `indnullsnotdistinct` only exists on PostgreSQL 15+ (this project's
  // documented floor is 14); a plain `idx.indnullsnotdistinct` reference —
  // in the SELECT list OR the GROUP BY — is a parse-time "column does not
  // exist" error on 14, not a NULL, so it would hard-fail every
  // db:migrate-uuid run there. Read it through `to_jsonb(idx)`, which only
  // ever exposes columns that exist on the connected server and yields NULL
  // (→ coalesced to `false`, PostgreSQL's own NULLS DISTINCT default) when
  // the key is absent — wrapped in an aggregate so it never needs to appear
  // in GROUP BY itself.
  const { rows } = await db.query(
    `SELECT to_json(array_agg(json_build_object(
                'name', key_attr.attname,
                'type', format_type(key_attr.atttypid, key_attr.atttypmod)
              ) ORDER BY key_order.ord)) AS key_columns,
              to_json(coalesce(
                bool_or((to_jsonb(idx) ->> 'indnullsnotdistinct')::boolean),
                false
              )) AS nulls_not_distinct
         FROM pg_index idx
         CROSS JOIN LATERAL unnest((idx.indkey::int2[])[0:idx.indnkeyatts - 1]) WITH ORDINALITY AS key_order(attnum, ord)
         JOIN pg_attribute key_attr
           ON key_attr.attrelid = idx.indrelid AND key_attr.attnum = key_order.attnum
        WHERE idx.indrelid = ${quoteLiteral(relationOid)}::oid AND idx.indisunique
          AND ${attnum} = ANY((idx.indkey::int2[])[0:idx.indnkeyatts - 1])
        GROUP BY idx.indexrelid`,
  );
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    keyColumns: (row.key_columns as Array<{ name: string; type: string }>).map(
      (col) => ({ name: String(col.name), typeName: String(col.type) }),
    ),
    nullsNotDistinct: Boolean(row.nulls_not_distinct),
  }));
}

async function fetchSingleColumnForeignKeyEdges(
  db: QueryExecutor,
): Promise<ForeignKeyEdge[]> {
  const { rows } = await db.query(
    `SELECT con.conname AS name, child.relname AS child_table,
            child_attr.attname AS child_column,
            parent.relname AS parent_table, parent_attr.attname AS parent_column
       FROM pg_constraint con
       JOIN pg_class child ON child.oid = con.conrelid
       JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
       JOIN pg_class parent ON parent.oid = con.confrelid
       JOIN pg_attribute child_attr ON child_attr.attrelid = child.oid AND child_attr.attnum = con.conkey[1]
       JOIN pg_attribute parent_attr ON parent_attr.attrelid = parent.oid AND parent_attr.attnum = con.confkey[1]
      WHERE con.contype = 'f' AND child_ns.nspname = 'public'
        AND array_length(con.conkey, 1) = 1`,
  );
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    name: String(row.name),
    childTable: String(row.child_table),
    childColumn: String(row.child_column),
    parentTable: String(row.parent_table),
    parentColumn: String(row.parent_column),
  }));
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
            EXISTS (
              SELECT 1 FROM pg_trigger trigger
               WHERE trigger.tgconstraint = con.oid
                 AND trigger.tgenabled <> 'O'
            ) AS nondefault_trigger_mode,
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
    if (row.nondefault_trigger_mode) {
      throw new Error(
        `Unsupported foreign key ${String(row.name)} has nondefault PostgreSQL trigger enforcement; refusing to recreate it with weaker semantics.`,
      );
    }
    participating.push({
      oid: String(row.oid),
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

/**
 * A bridge column is dropped and rebuilt. pg_depend is the authoritative
 * catalog for every object which would be removed with it, including objects
 * whose definition does not expose the column name (expression indexes,
 * predicates, and extended statistics). Keep only dependencies we snapshot
 * and recreate exactly; fail closed for every other catalog object.
 */
async function assertSupportedBridgeDependencies(
  db: QueryExecutor,
  bridges: GeneratedBridgeSnapshot[],
  foreignKeys: ForeignKeySnapshot[],
): Promise<void> {
  const foreignKeyOids = new Set(
    foreignKeys.map((foreignKey) => foreignKey.oid),
  );
  for (const bridge of bridges) {
    const indexOids = new Set(
      bridge.indexDefinitions.map((index) => index.oid),
    );
    const { rows } = await db.query(
      `SELECT dep.classid::regclass::text AS class_name,
              dep.objid::text AS object_oid,
              dep.objsubid AS object_subid,
              dep.deptype,
              coalesce(obj_class.relname, con.conname, stat.stxname, '') AS object_name
         FROM pg_depend dep
         LEFT JOIN pg_class obj_class
           ON dep.classid = 'pg_class'::regclass AND obj_class.oid = dep.objid
         LEFT JOIN pg_constraint con
           ON dep.classid = 'pg_constraint'::regclass AND con.oid = dep.objid
         LEFT JOIN pg_statistic_ext stat
           ON dep.classid = 'pg_statistic_ext'::regclass AND stat.oid = dep.objid
        WHERE dep.refclassid = 'pg_class'::regclass
          AND dep.refobjid = ${quoteLiteral(bridge.tableOid)}::oid
          AND dep.refobjsubid = ${bridge.attributeNumber}`,
    );
    for (const row of rows as Array<Record<string, unknown>>) {
      const className = String(row.class_name);
      const objectOid = String(row.object_oid);
      const knownAttributeDefinition =
        className === 'pg_attrdef' && objectOid === bridge.attributeDefaultOid;
      const knownIndex = className === 'pg_class' && indexOids.has(objectOid);
      const knownForeignKey =
        className === 'pg_constraint' && foreignKeyOids.has(objectOid);
      if (knownAttributeDefinition || knownIndex || knownForeignKey) continue;
      const name = row.object_name ? ` ${String(row.object_name)}` : '';
      throw new Error(
        `Unsupported catalog dependency on generated bridge ${bridge.table}.${bridge.column}:${name} (${className} OID ${objectOid}, dependency ${String(row.deptype)}). Remove or migrate it separately before db:migrate-uuid.`,
      );
    }
  }
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
      const t = isPostgres ? pgTable(spec.table) : quoteIdentifier(spec.table);
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
