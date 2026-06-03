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
import type { CLICommand } from '../cli-generator.js';
import { autoDiscoverAndLoad } from '../discovery/index.js';
import {
  closeDatabaseConnection,
  formatDatabaseDisplayUrl,
} from './db-command-utils.js';

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

function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
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
  handler: async (_args: string[], options: any) => {
    const dryRun = Boolean(options['dry-run']);
    let db: any;

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

      // When BOTH phases will execute for real, run them inside ONE transaction
      // so a conversion failure rolls the dropped rename columns back too — the
      // command's documented atomicity guarantee. Postgres DDL is transactional.
      // A dry run executes nothing, so there is no transaction to share.
      const sharedTxn = runRenames && runConvert && !dryRun;
      // True once a BEGIN has been issued that is NOT owned by an inner phase.
      let openTxn = false;

      try {
        // -----------------------------------------------------------------
        // Step 1: rename backfills (copy old → new where new is empty, drop old)
        // -----------------------------------------------------------------
        if (runRenames) {
          if (sharedTxn) {
            await db.query('BEGIN');
            openTxn = true;
          }
          await applyRenameBackfills(db, isPostgres, renameSpecs, dryRun, {
            ownTransaction: !sharedTxn,
          });
        }

        // -----------------------------------------------------------------
        // Step 2: TEXT → native uuid conversion (Postgres only)
        // -----------------------------------------------------------------
        if (skipConvert) {
          console.log('Skipping TEXT→uuid conversion (--skip-convert).\n');
          return;
        }

        if (!isPostgres) {
          console.log(
            `Database type "${dbType}" has no native uuid column type that needs converting; uuid conversion is a no-op.\n`,
          );
          return;
        }

        // Gate (a): load the SMRT-declared schema (same source db:migrate /
        // db:diff use) and collect the columns the manifest declares as native
        // UUID. The manifest is resolved relative to process.cwd() — the
        // operator MUST run this from the project root.
        const declaredUuid = await loadDeclaredUuidColumns();

        // Fail-closed: with no declared-UUID columns we convert NOTHING rather
        // than fall back to a name-regex that would over-convert
        // schema-intentional TEXT columns (the differ tolerates uuid/text drift,
        // so it would never self-repair the damage). #1338 codex P1.
        if (declaredUuid.size === 0) {
          console.log(
            'No schema-declared UUID columns found in the loaded manifest.',
          );
          console.log(
            'Skipping TEXT→uuid conversion (fail-closed). Run this command from\n' +
              'the project root so the SMRT manifest can be discovered, then re-run.\n',
          );
          if (openTxn && !dryRun) {
            // Commit the renames that already ran rather than discard them.
            await db.query('COMMIT');
            openTxn = false;
          }
          return;
        }

        // Scan every public TEXT id/FK column, then keep only those the schema
        // declares UUID (gate a). Within a shared transaction this scan runs
        // AFTER the renames so dropped/added columns are reflected.
        const { rows: candidates } = await db.query(
          `SELECT table_name, column_name, (column_default IS NOT NULL) AS has_default
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND data_type = 'text'
              AND (column_name = 'id' OR column_name ~* '(_id|Id)$')
            ORDER BY table_name, column_name`,
        );

        const liveColumns: LiveTextColumn[] = [];
        for (const row of candidates as any[]) {
          // Gate (b) data-shape: only count rows for columns we might convert.
          // For columns the schema does not declare UUID we skip the (possibly
          // expensive) full-column scan entirely — they can never convert.
          const declared = declaredUuid.has(
            `${row.table_name}|${row.column_name}`,
          );
          let nonUuid = 0;
          if (declared) {
            const t = quoteIdent(row.table_name);
            const c = quoteIdent(row.column_name);
            const { rows } = await db.query(
              `SELECT count(*)::text AS n
                 FROM ${t}
                WHERE nullif(btrim(${c}), '') IS NOT NULL
                  AND btrim(${c}) !~* '${UUID_RE}'`,
            );
            nonUuid = Number((rows as any[])[0]?.n ?? '0');
          }
          liveColumns.push({
            table: row.table_name,
            column: row.column_name,
            hasDefault: Boolean(row.has_default),
            nonUuid,
          });
        }

        const { convert, skipDirtyData, skipNotDeclared } = planUuidConversions(
          liveColumns,
          declaredUuid,
        );

        console.log(
          `Found ${(candidates as any[]).length} TEXT id/FK column(s): ${convert.length} convertible, ${skipDirtyData.length + skipNotDeclared.length} skipped.`,
        );
        if (skipDirtyData.length > 0) {
          console.log(
            '\nSKIP (declared UUID but data still has non-UUID values — clean these first):',
          );
          for (const s of skipDirtyData) {
            console.log(`  - ${s.table}.${s.column} (${s.nonUuid} non-uuid)`);
          }
        }
        if (skipNotDeclared.length > 0) {
          console.log(
            '\nSKIP (not declared UUID by the SMRT schema, left as TEXT):',
          );
          for (const s of skipNotDeclared) {
            console.log(`  - ${s.table}.${s.column}`);
          }
        }

        if (convert.length === 0) {
          console.log('\nNothing to convert. Done.\n');
          if (openTxn && !dryRun) {
            // Commit any renames that ran in the shared transaction.
            await db.query('COMMIT');
            openTxn = false;
          }
          return;
        }

        console.log(
          `\n${dryRun ? 'DRY RUN — would run' : 'Applying'} ${convert.length} conversion(s):`,
        );

        // Open a conversion-only transaction when we are NOT already inside the
        // shared rename+convert transaction.
        if (!sharedTxn && !dryRun) {
          await db.query('BEGIN');
          openTxn = true;
        }

        for (const { table, column, hasDefault } of convert) {
          const t = quoteIdent(table);
          const c = quoteIdent(column);
          if (hasDefault) {
            const dropDefault = `ALTER TABLE ${t} ALTER COLUMN ${c} DROP DEFAULT`;
            console.log(`  ${dropDefault};`);
            if (!dryRun) await db.query(dropDefault);
          }
          const alter = `ALTER TABLE ${t} ALTER COLUMN ${c} TYPE uuid USING NULLIF(btrim(${c}), '')::uuid`;
          console.log(`  ${alter};`);
          if (!dryRun) await db.query(alter);
        }

        if (!dryRun) {
          // Commit the (possibly shared) transaction once, after conversions.
          if (openTxn) {
            await db.query('COMMIT');
            openTxn = false;
          }
          console.log(`\n✓ Converted ${convert.length} column(s) to uuid.\n`);
        } else {
          console.log('\nDry run complete — no changes applied.\n');
        }
      } catch (error) {
        // One rollback unwinds whatever transaction is open — the shared
        // rename+convert transaction or a phase-owned one.
        if (openTxn && !dryRun) {
          try {
            await db.query('ROLLBACK');
          } catch {
            // ignore
          }
          openTxn = false;
        }
        throw error;
      }
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
  db: any,
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
      const t = quoteIdent(spec.table);
      const from = quoteIdent(spec.from);
      const to = quoteIdent(spec.to);

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
  db: any,
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
    return (rows as any[]).length > 0;
  }
  // SQLite / DuckDB: PRAGMA-style introspection.
  try {
    const { rows } = await db.query(`PRAGMA table_info(${quoteIdent(table)})`);
    return (rows as any[]).some((r) => r.name === column);
  } catch {
    return false;
  }
}

async function columnIsUuid(
  db: any,
  table: string,
  column: string,
): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = '${table.replaceAll("'", "''")}'
        AND column_name = '${column.replaceAll("'", "''")}'`,
  );
  return (rows as any[])[0]?.data_type === 'uuid';
}
