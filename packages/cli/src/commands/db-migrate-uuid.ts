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
 *     `uuid`. This command is *self-classifying*: a column is converted only if
 *     EVERY non-empty value is a canonical UUID. Columns with even one genuine
 *     non-uuid value (slugs, external ids like `'google-weather'`, legacy
 *     unhyphenated ids, analytics measurement ids, …) are SKIPPED and left as
 *     TEXT.
 *
 * Both steps run inside a single transaction and are idempotent — re-running is
 * a no-op once the renames are done and the columns are already `uuid`.
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

import type { CLICommand } from '../cli-generator.js';
import {
  closeDatabaseConnection,
  formatDatabaseDisplayUrl,
} from './db-command-utils.js';

const UUID_RE =
  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

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

interface ConvertCandidate {
  table: string;
  column: string;
  hasDefault: boolean;
}

export const dbMigrateUuidCommand: CLICommand = {
  name: 'db:migrate-uuid',
  description:
    'Backfill R3 column renames and convert UUID-shaped TEXT id/FK columns to native uuid (Postgres). Run after db:migrate.',
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

      // -------------------------------------------------------------------
      // Step 1: rename backfills (copy old → new where new is empty, drop old)
      // -------------------------------------------------------------------
      if (renameSpecs.length > 0) {
        console.log(
          `${dryRun ? 'DRY RUN — would apply' : 'Applying'} ${renameSpecs.length} rename backfill(s):`,
        );

        if (!dryRun) await db.query('BEGIN');
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
            const toExists = await columnExists(
              db,
              isPostgres,
              spec.table,
              spec.to,
            );
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
          if (!dryRun) await db.query('COMMIT');
        } catch (error) {
          if (!dryRun) {
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

      // -------------------------------------------------------------------
      // Step 2: TEXT → native uuid conversion (Postgres only)
      // -------------------------------------------------------------------
      if (options['skip-convert']) {
        console.log('Skipping TEXT→uuid conversion (--skip-convert).\n');
        return;
      }

      if (!isPostgres) {
        console.log(
          `Database type "${dbType}" has no native uuid column type that needs converting; uuid conversion is a no-op.\n`,
        );
        return;
      }

      // All TEXT id / FK columns, with whether they carry a column default.
      const { rows: candidates } = await db.query(
        `SELECT table_name, column_name, (column_default IS NOT NULL) AS has_default
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND data_type = 'text'
            AND (column_name = 'id' OR column_name ~* '(_id|Id)$')
          ORDER BY table_name, column_name`,
      );

      const convert: ConvertCandidate[] = [];
      const skip: Array<{ table: string; column: string; nonUuid: number }> =
        [];

      for (const row of candidates as any[]) {
        const t = quoteIdent(row.table_name);
        const c = quoteIdent(row.column_name);
        const { rows } = await db.query(
          `SELECT count(*)::text AS n
             FROM ${t}
            WHERE nullif(btrim(${c}), '') IS NOT NULL
              AND btrim(${c}) !~* '${UUID_RE}'`,
        );
        const nonUuid = Number((rows as any[])[0]?.n ?? '0');
        if (nonUuid === 0) {
          convert.push({
            table: row.table_name,
            column: row.column_name,
            hasDefault: Boolean(row.has_default),
          });
        } else {
          skip.push({
            table: row.table_name,
            column: row.column_name,
            nonUuid,
          });
        }
      }

      console.log(
        `Found ${(candidates as any[]).length} TEXT id/FK column(s): ${convert.length} convertible, ${skip.length} skipped.`,
      );
      if (skip.length > 0) {
        console.log('\nSKIP (genuine non-UUID values, left as TEXT):');
        for (const s of skip) {
          console.log(`  - ${s.table}.${s.column} (${s.nonUuid} non-uuid)`);
        }
      }

      if (convert.length === 0) {
        console.log('\nNothing to convert. Done.\n');
        return;
      }

      console.log(
        `\n${dryRun ? 'DRY RUN — would run' : 'Applying'} ${convert.length} conversion(s):`,
      );

      if (!dryRun) await db.query('BEGIN');
      try {
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
          await db.query('COMMIT');
          console.log(`\n✓ Converted ${convert.length} column(s) to uuid.\n`);
        } else {
          console.log('\nDry run complete — no changes applied.\n');
        }
      } catch (error) {
        if (!dryRun) {
          try {
            await db.query('ROLLBACK');
          } catch {
            // ignore
          }
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
