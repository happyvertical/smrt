/**
 * db:drop-framework-base-tables Command
 *
 * One-time remediation for the five orphaned framework-base tables
 * (`smrt_objects`, `smrt_classes`, `smrt_collections`, `smrt_hierarchicals`,
 * `smrt_polymorphic_associations`) that a pre-#2644 `db:migrate` planned for
 * SMRT's abstract framework-base classes. #2644 stopped planning them; this
 * command drops the ones a deployment already created.
 *
 * Deliberately separate from `db:migrate` and from `db:diff`'s orphan-table
 * reporting: `SchemaDiff.includeDroppedTables` stays `false` so an ordinary
 * migration never drops a table just because it is absent from the manifest.
 * This command drops **only** the five hardcoded names above, and only after
 * verifying each one is empty, has no foreign keys pointing at it, and has
 * nothing but the universal baseline columns (`id`, `slug`, `context`,
 * `created_at`, `updated_at`) — see `@happyvertical/smrt-core/migrations`'
 * `planFrameworkBaseTableDrop()` for the full safety model.
 *
 * Skipping this command is safe: a table left behind here is inert and
 * permanently orphaned, never written to or read from again.
 */

import {
  dropFrameworkBaseTables,
  FRAMEWORK_BASE_TABLE_NAMES,
  type FrameworkBaseTableRefusal,
  parsePostgresTimeoutMs,
  planFrameworkBaseTableDrop,
} from '@happyvertical/smrt-core/migrations';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { CLICommand } from '../cli-generator.js';
import {
  closeDatabaseConnection,
  formatDatabaseDisplayUrl,
  quoteIdentifier,
} from './db-command-utils.js';

interface DbDropFrameworkBaseTablesOptions {
  'dry-run'?: boolean;
  verbose?: boolean;
}

const DEFAULT_POSTGRES_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_POSTGRES_STATEMENT_TIMEOUT_MS = 60_000;

function describeRefusal(refusal: FrameworkBaseTableRefusal): string {
  switch (refusal.kind) {
    case 'not-empty':
      return `has ${refusal.rowCount} row(s) — nothing should ever have written to this table`;
    case 'unexpected-shape': {
      const parts: string[] = [];
      if (refusal.extraColumns.length > 0) {
        parts.push(`unexpected column(s) [${refusal.extraColumns.join(', ')}]`);
      }
      if (refusal.missingColumns.length > 0) {
        parts.push(
          `missing baseline column(s) [${refusal.missingColumns.join(', ')}]`,
        );
      }
      return `has an unexpected shape: ${parts.join('; ')} (actual columns: ${refusal.actualColumns.join(', ')})`;
    }
    case 'referenced-by-foreign-key':
      return `is referenced by foreign key(s) from: ${refusal.references
        .map((reference) => `${reference.table}.${reference.column}`)
        .join(', ')}`;
    case 'introspection-unavailable':
      return refusal.reason;
    default:
      return 'is unsafe to drop for an unrecognized reason';
  }
}

export const dbDropFrameworkBaseTablesCommand: CLICommand = {
  name: 'db:drop-framework-base-tables',
  description:
    'One-time removal of the five framework-base tables orphaned by #2644 (smrt_objects, smrt_classes, smrt_collections, smrt_hierarchicals, smrt_polymorphic_associations). Refuses if any target table has rows, an unexpected shape, or an inbound foreign key.',
  aliases: ['drop-framework-base-tables', 'db-drop-framework-base-tables'],
  args: [],
  options: {
    'dry-run': {
      type: 'boolean',
      description: 'Print the plan without dropping anything.',
      default: false,
    },
    verbose: {
      type: 'boolean',
      description:
        'Print a per-table report, including tables that are not present.',
      default: false,
      short: 'v',
    },
  },
  handler: async (
    _args: string[],
    options: DbDropFrameworkBaseTablesOptions,
  ) => {
    let db: DatabaseInterface | undefined;
    const dryRun = Boolean(options['dry-run']);

    try {
      const { getPackageConfig } = await import('@happyvertical/smrt-config');
      const { DEFAULT_CLI_CONFIG } = await import('../config.js');
      const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);
      if (!config.database?.url || config.database.url === ':memory:') {
        throw new Error(
          'Database configuration required for db:drop-framework-base-tables. Configure database.url in smrt.config.ts (or DATABASE_URL).',
        );
      }

      const dbType = config.database.type || 'sqlite';
      const dbUrl = config.database.url;
      const { getDatabase } = await import('@happyvertical/sql');
      db = await getDatabase({ type: dbType, url: dbUrl });
      console.log('\n🗑️  Framework base-table remediation (#2647)\n');
      console.log(
        `✓ Connected to ${formatDatabaseDisplayUrl(dbType, dbUrl)}\n`,
      );

      const plan = await planFrameworkBaseTableDrop(db, {
        engineHint: dbType,
      });

      const present = plan.tables.filter((table) => table.exists);
      const absent = plan.tables.filter((table) => !table.exists);

      if (options.verbose || present.length === 0) {
        for (const table of absent) {
          console.log(`  - ${table.table}: not present, nothing to do`);
        }
      }
      for (const table of present) {
        if (table.refusals.length === 0) {
          console.log(
            `  - ${table.table}: safe to drop (${table.indexNames.length} companion index(es))`,
          );
          continue;
        }
        console.log(`  - ${table.table}: UNSAFE`);
        for (const refusal of table.refusals) {
          console.log(`      ${describeRefusal(refusal)}`);
        }
      }

      if (!plan.safe) {
        throw new Error(
          `Refusing to drop framework base tables — ${FRAMEWORK_BASE_TABLE_NAMES.length} target name(s) checked, at least one is unsafe (see above). Nothing was dropped.`,
        );
      }

      if (present.length === 0) {
        console.log(
          '\nNone of the five framework-base tables are present. Nothing to do.\n',
        );
        return;
      }

      console.log(
        `\n${dryRun ? 'DRY RUN — would execute' : 'Applying'} ${plan.statements.length} statement(s):`,
      );
      for (const statement of plan.statements) console.log(`  ${statement};`);

      if (dryRun) {
        console.log('\nDry run complete — no changes applied.\n');
        return;
      }

      const postgresMigrationConfig = config.migrations?.postgres;
      const result = await dropFrameworkBaseTables(db, plan, {
        lockTimeout: parsePostgresTimeoutMs(
          postgresMigrationConfig?.lockTimeout,
          DEFAULT_POSTGRES_LOCK_TIMEOUT_MS,
        ),
        statementTimeout: parsePostgresTimeoutMs(
          postgresMigrationConfig?.statementTimeout,
          DEFAULT_POSTGRES_STATEMENT_TIMEOUT_MS,
        ),
      });

      console.log(
        `\n✓ Dropped ${result.droppedTables.length} table(s) and ${result.droppedIndexes.length} companion index(es): ${result.droppedTables.map((table) => quoteIdentifier(table)).join(', ')}\n`,
      );
    } catch (error) {
      console.error(
        `\n❌ Framework base-table remediation failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    } finally {
      await closeDatabaseConnection(db);
    }
  },
};
