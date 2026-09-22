import type { DatabaseInterface } from '@happyvertical/sql';
import type { CLICommand } from '../cli-generator.js';
import {
  closeDatabaseConnection,
  formatDatabaseDisplayUrl,
  redactConnectionStringsInText,
} from './db-command-utils.js';

interface DbMaterializeTenantHierarchyOptions {
  'dry-run'?: boolean;
  table?: string;
}

/**
 * `smrt db:materialize-tenant-hierarchy` (smrt#3036).
 *
 * Backfills `tenants.hierarchy_path` / `hierarchy_level` from each row's
 * `parent_tenant_id` chain. `Tenant.save()` in `@happyvertical/smrt-users`
 * now maintains both; this repairs rows written before it did, which left `inheritsToDescendants` and the declared ancestor-read
 * policy failing closed. Idempotent; refuses (writing nothing) when any
 * tenant's parent chain is broken.
 */
export const dbMaterializeTenantHierarchyCommand: CLICommand = {
  name: 'db:materialize-tenant-hierarchy',
  description:
    'Backfill tenant hierarchy_path/hierarchy_level from parent_tenant_id (smrt-users). Idempotent; run after db:migrate.',
  aliases: ['materialize-tenant-hierarchy', 'tenancy:materialize-hierarchy'],
  args: [],
  options: {
    'dry-run': {
      type: 'boolean',
      description: 'Report the tenants that would change without writing.',
      default: false,
    },
    table: {
      type: 'string',
      description: 'Tenant table name (default: tenants).',
    },
  },
  handler: async (
    _args: string[],
    options: DbMaterializeTenantHierarchyOptions,
  ) => {
    let db: DatabaseInterface | undefined;
    try {
      const { getPackageConfig } = await import('@happyvertical/smrt-config');
      const { DEFAULT_CLI_CONFIG } = await import('../config.js');
      const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);
      if (!config.database?.url || config.database.url === ':memory:') {
        throw new Error(
          'Database configuration required for db:materialize-tenant-hierarchy. Configure database.url in smrt.config.ts (or DATABASE_URL).',
        );
      }
      const dbType = config.database.type || 'sqlite';
      const { getDatabase } = await import('@happyvertical/sql');
      const {
        materializeTenantHierarchy,
        TenantHierarchyMaterializationError,
      } = await import('@happyvertical/smrt-users');
      db = await getDatabase({ type: dbType, url: config.database.url });
      console.log('\n🌳 Tenant hierarchy materialization\n');
      console.log(
        `✓ Connected to ${formatDatabaseDisplayUrl(dbType, config.database.url)}\n`,
      );

      const dryRun = options['dry-run'] === true;
      let result: Awaited<ReturnType<typeof materializeTenantHierarchy>>;
      try {
        result = await materializeTenantHierarchy(db, {
          dryRun,
          tableName: options.table,
        });
      } catch (error) {
        if (error instanceof TenantHierarchyMaterializationError) {
          for (const problem of error.problems) {
            console.error(`  ✗ ${problem.code}: ${problem.message}`);
          }
          throw new Error(
            `${error.problems.length} tenant(s) have a broken parent chain; repair parent_tenant_id and re-run. No changes were made.`,
          );
        }
        throw error;
      }

      for (const change of result.changes) {
        console.log(
          `  ${dryRun ? '~' : '✓'} ${change.id}: level ${change.previousLevel ?? 'null'} → ${change.hierarchyLevel}, path "${change.previousPath ?? ''}" → "${change.hierarchyPath}"`,
        );
      }
      for (const problem of result.problems) {
        console.log(`  ✗ ${problem.code}: ${problem.message}`);
      }

      if (dryRun) {
        console.log(
          `\nDRY RUN: ${result.total} tenant(s) examined; ${result.changes.length} would be updated, ${result.problems.length} have a broken parent chain. No changes made.\n`,
        );
        if (result.problems.length > 0) {
          process.exitCode = 1;
        }
        return;
      }
      console.log(
        result.changes.length > 0
          ? `\n✓ Materialized the hierarchy for ${result.changes.length} of ${result.total} tenant(s).\n`
          : `\nAll ${result.total} tenant(s) already carry the correct hierarchy; nothing to do.\n`,
      );
    } catch (error) {
      console.error(
        `\n❌ Tenant hierarchy materialization failed: ${redactConnectionStringsInText(
          error instanceof Error ? error.message : String(error),
        )}\n`,
      );
      process.exitCode = 1;
    } finally {
      await closeDatabaseConnection(db);
    }
  },
};
