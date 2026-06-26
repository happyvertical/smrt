/**
 * db:status Command
 *
 * Shows the current status of database migrations:
 * - Applied migrations
 * - Pending migrations
 * - Drift detection warnings
 */

import { ObjectRegistry, SchemaComparer } from '@happyvertical/smrt-core';
import type { SchemaDiff } from '@happyvertical/smrt-core/migrations';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { CLICommand } from '../cli-generator.js';
import { autoDiscoverAndLoad } from '../discovery/index.js';
import {
  closeDatabaseConnection,
  formatDatabaseDisplayUrl,
} from './db-command-utils.js';
import {
  classifyTypeUpgradeSql,
  getUnresolvedGeneratedMigrationNames,
  summarizeFailedMigrations,
} from './db-migrate-actions.js';
import { assessFailedMigrations } from './migration-failure-analysis.js';
import {
  evaluateSchemaContract,
  formatSchemaContractFailures,
  type SchemaContractReport,
} from './schema-contract.js';

type StatusDrift = {
  name: string;
  type: string;
  recommendation: string;
};

type StatusPrecondition = {
  name: string;
  status: 'warning' | 'error';
  message: string;
  recommendation: string;
  details?: Record<string, unknown>;
};

type FailedMigrationSummary = {
  total: number;
  actionRequired: number;
  superseded: number;
  manualReview: number;
  details: Array<{
    name: string;
    resolution: 'action_required' | 'superseded' | 'manual_review';
    kind: 'add_column' | 'add_index' | 'type_upgrade' | 'other';
    reason: string;
    errorMessage: string | null;
  }>;
};

type FailedMigrationBuckets = ReturnType<typeof summarizeFailedMigrations>;

/** Parsed CLI options for the `db:status` command. */
interface DbStatusOptions {
  json?: boolean;
  verbose?: boolean;
}

const CANONICAL_UUID_RE =
  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

/** Minimal column shape this command reads (manifest or live db column). */
type SchemaColumnLike = { name?: string; type?: unknown };

/**
 * Minimal schema shape this command reads. Covers both manifest definitions
 * (`getAllSchemasAsDefinitions()`) and live `getTableSchema()` results, whose
 * `columns` are keyed records; an array form is tolerated defensively.
 */
type SchemaLike = {
  tableName?: string;
  columns?: Record<string, SchemaColumnLike> | SchemaColumnLike[];
};

function getSchemaColumn(
  schema: SchemaLike | null | undefined,
  columnName: string,
): SchemaColumnLike | null {
  const columns = schema?.columns;
  if (!columns) return null;

  if (Array.isArray(columns)) {
    return columns.find((column) => column?.name === columnName) ?? null;
  }

  return columns[columnName] ?? null;
}

function normalizeColumnType(type: unknown): string {
  return String(type ?? '')
    .trim()
    .toLowerCase()
    .replace(/\(.+\)$/, '');
}

function isTextColumnType(type: unknown): boolean {
  const normalized = normalizeColumnType(type);
  return (
    normalized === 'text' ||
    normalized === 'varchar' ||
    normalized === 'character varying'
  );
}

function isPostgresDatabase(dbType: string, dbUrl: string): boolean {
  return dbType === 'postgres' || /^postgres/i.test(dbUrl);
}

function manifestDeclaresTenantIdUuid(
  manifestSchemas: Record<string, SchemaLike>,
): boolean {
  const tenantSchema =
    manifestSchemas.tenants ??
    Object.values(manifestSchemas).find(
      (schema) => schema?.tableName === 'tenants',
    );
  const idColumn = getSchemaColumn(tenantSchema, 'id');
  return normalizeColumnType(idColumn?.type) === 'uuid';
}

async function countNonUuidTenantIds(db: DatabaseInterface): Promise<number> {
  const result = await db.query(
    `SELECT count(*)::text AS count
       FROM tenants
      WHERE nullif(btrim(id), '') IS NOT NULL
        AND btrim(id) !~* '${CANONICAL_UUID_RE}'`,
  );
  const row = result?.rows?.[0] ?? {};
  return Number(row.count ?? row.n ?? 0);
}

export async function checkTenantIdUuidPreconditions(input: {
  db: DatabaseInterface;
  dbType: string;
  dbUrl: string;
  manifestSchemas: Record<string, SchemaLike>;
}): Promise<StatusPrecondition[]> {
  const { db, dbType, dbUrl, manifestSchemas } = input;
  if (
    !isPostgresDatabase(dbType, dbUrl) ||
    typeof db?.getTableSchema !== 'function' ||
    !manifestDeclaresTenantIdUuid(manifestSchemas)
  ) {
    return [];
  }

  const tenantSchema = await db.getTableSchema('tenants');
  const idColumn = getSchemaColumn(tenantSchema, 'id');
  if (!idColumn) {
    return [];
  }

  const idType = normalizeColumnType(idColumn.type);
  if (idType === 'uuid') {
    return [
      {
        name: 'tenants.id',
        status: 'warning',
        message:
          '`tenants.id` is native uuid. Fresh 0.27 PostgreSQL schemas reject slug-shaped tenant primary keys.',
        recommendation:
          'Use UUID tenant primary keys, or remap existing slug/human-readable tenant IDs before creating fresh 0.27 schemas.',
        details: { columnType: idColumn.type },
      },
    ];
  }

  if (!isTextColumnType(idColumn.type)) {
    return [];
  }

  const nonUuidCount = await countNonUuidTenantIds(db);
  if (nonUuidCount === 0) {
    return [
      {
        name: 'tenants.id',
        status: 'warning',
        message:
          '`tenants.id` is still TEXT while the current manifest declares UUID tenant IDs.',
        recommendation:
          'Run `smrt db:migrate-uuid` after `smrt db:migrate` to converge existing PostgreSQL schemas to native UUID columns.',
        details: { columnType: idColumn.type },
      },
    ];
  }

  return [
    {
      name: 'tenants.id',
      status: 'error',
      message: `Found ${nonUuidCount} non-UUID tenant primary key value(s) in a schema whose manifest now declares UUID tenant IDs.`,
      recommendation:
        'Remap `tenants.id` and every tenant_id reference to canonical UUIDs before upgrading fresh environments to SMRT 0.27.',
      details: { columnType: idColumn.type, nonUuidCount },
    },
  ];
}

export function summarizeSchemaDiff(diff: {
  added_tables: Array<{ tableName: string }>;
  changes: Array<{
    type: string;
    table: string;
    name?: string;
    mismatch?: {
      expected: string;
      actual: string;
    };
    sql?: string;
  }>;
}): StatusDrift[] {
  const drift: StatusDrift[] = [];

  for (const schema of diff.added_tables) {
    drift.push({
      name: schema.tableName,
      type: 'missing_table',
      recommendation:
        'Run `smrt db:migrate` to create the missing table in the live database.',
    });
  }

  for (const change of diff.changes) {
    switch (change.type) {
      case 'add_column':
        drift.push({
          name: `${change.table}.${change.name ?? '(unknown)'}`,
          type: 'missing_column',
          recommendation:
            'Run `smrt db:migrate` to add the missing column before application writes hit this table.',
        });
        break;

      case 'add_index':
        drift.push({
          name: `${change.table}.${change.name ?? '(unknown)'}`,
          type: 'missing_index',
          recommendation:
            'Run `smrt db:migrate` to add the missing index and reconcile the live schema.',
        });
        break;

      case 'type_upgrade':
        switch (classifyTypeUpgradeSql(change.sql)) {
          case 'executable':
            drift.push({
              name: `${change.table}.${change.name ?? '(unknown)'}`,
              type: 'type_upgrade',
              recommendation:
                'Run `smrt db:migrate` to apply the compatible type upgrade for this live column.',
            });
            break;

          case 'manual':
            drift.push({
              name: `${change.table}.${change.name ?? '(unknown)'}`,
              type: 'type_upgrade',
              recommendation:
                'Manual intervention required: this live column needs a type upgrade that the current database engine cannot auto-apply.',
            });
            break;

          case 'noop':
            break;
        }
        break;

      case 'type_mismatch':
        drift.push({
          name: `${change.table}.${change.name ?? '(unknown)'}`,
          type: 'type_mismatch',
          recommendation: change.mismatch
            ? `Manual intervention required: expected ${change.mismatch.expected}, found ${change.mismatch.actual}.`
            : 'Manual intervention required to reconcile this incompatible live column type.',
        });
        break;
    }
  }

  return drift;
}

export const dbStatusCommand: CLICommand = {
  name: 'db:status',
  description: 'Show migration status (applied, pending, drift)',
  aliases: ['status', 'migration-status'],
  args: [],
  options: {
    json: {
      type: 'boolean',
      description: 'Output as JSON (for CI integration)',
      default: false,
      short: 'j',
    },
    verbose: {
      type: 'boolean',
      description: 'Show detailed migration information',
      default: false,
      short: 'v',
    },
  },
  handler: async (_args: string[], options: DbStatusOptions) => {
    let db: DatabaseInterface | undefined;

    try {
      // 1. Load CLI config
      const { getPackageConfig } = await import('@happyvertical/smrt-config');
      const { DEFAULT_CLI_CONFIG } = await import('../config.js');
      const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);

      // 2. Validate database configuration
      if (!config.database?.url || config.database.url === ':memory:') {
        if (options.json) {
          console.log(JSON.stringify({ error: 'Database not configured' }));
        } else {
          console.error('\n❌ Database configuration required');
          console.error('\nPlease configure database in smrt.config.js\n');
        }
        process.exit(1);
      }

      const dbUrl = config.database.url;
      const dbType = config.database.type || 'sqlite';

      if (!options.json) {
        console.log('\n📊 Migration Status\n');
        console.log(`Database: ${formatDatabaseDisplayUrl(dbType, dbUrl)}\n`);
      }

      // 3. Connect to database
      const { getDatabase } = await import('@happyvertical/sql');
      db = await getDatabase({ type: dbType, url: dbUrl });

      // 4. Import MigrationTracker
      const { MigrationTracker } = await import(
        '@happyvertical/smrt-core/migrations'
      );

      const tracker = new MigrationTracker({ db });
      await tracker.initialize();

      // 5. Get applied migrations
      const applied = await tracker.getAppliedMigrations();
      const failed = await tracker.getHistory({ status: 'failed' });

      // 6. Auto-discover manifests to get current definitions
      const { discovered, totalObjects } = await autoDiscoverAndLoad();
      const schemaContract = await evaluateSchemaContract({
        discovered,
        schemaContract: config.schemaContract,
        db,
      });

      // 7. Build status report
      const status = {
        database: {
          type: dbType,
          url: formatDatabaseDisplayUrl(dbType, dbUrl),
          engine: tracker.getEngine(),
        },
        manifests: {
          count: discovered.length,
          objects: totalObjects,
          details: discovered.map((manifest) => ({
            path: manifest.path,
            source: manifest.source,
            packageName: manifest.packageName,
            packageVersion: manifest.packageVersion,
            objectCount: manifest.objectCount,
            objectNames: manifest.objectNames ?? [],
          })),
        },
        migrations: {
          applied: applied.length,
          failed: {
            total: failed.length,
            actionRequired: 0,
            superseded: 0,
            manualReview: 0,
            details: [],
          } as FailedMigrationSummary,
          details: applied.map((m) => ({
            name: m.name,
            version: m.version,
            appliedAt: m.applied_at.toISOString(),
            executionTime: m.execution_time_ms,
            status: m.status,
            isReversible: m.is_reversible,
            checksum: m.checksum.substring(0, 8),
          })),
        },
        drift: [] as StatusDrift[],
        preconditions: [] as StatusPrecondition[],
        failedMigrations: summarizeFailedMigrations(failed, null),
        schemaContract: schemaContract as SchemaContractReport,
      };
      let diff: SchemaDiff = {
        added_tables: [],
        dropped_tables: [],
        changes: [],
        has_changes: false,
      };

      // 8. Compare the current manifest schema against the live database.
      // This keeps db:status useful for shared Postgres databases where the
      // migration history alone is not enough to prove the schema is current.
      if (typeof db.getTableSchema === 'function') {
        const manifestSchemas = ObjectRegistry.getAllSchemasAsDefinitions();
        const comparer = new SchemaComparer(db);
        diff = await comparer.compare(manifestSchemas);
        status.drift = summarizeSchemaDiff(diff);
        status.preconditions = await checkTenantIdUuidPreconditions({
          db,
          dbType,
          dbUrl,
          manifestSchemas,
        });
        status.failedMigrations = summarizeFailedMigrations(
          failed,
          getUnresolvedGeneratedMigrationNames(diff.changes),
        );
      }

      const failedAssessments = assessFailedMigrations(
        failed,
        typeof db.getTableSchema === 'function' ? diff : null,
      );
      status.migrations.failed = {
        total: failedAssessments.length,
        actionRequired: failedAssessments.filter(
          (item) => item.resolution === 'action_required',
        ).length,
        superseded: failedAssessments.filter(
          (item) => item.resolution === 'superseded',
        ).length,
        manualReview: failedAssessments.filter(
          (item) => item.resolution === 'manual_review',
        ).length,
        details: failedAssessments,
      };

      // 9. Output results
      if (options.json) {
        console.log(JSON.stringify(status, null, 2));
        if (
          !schemaContract.ok ||
          status.preconditions.some((item) => item.status === 'error')
        ) {
          process.exitCode = 1;
        }
        return;
      }

      // Human-readable output
      console.log(`📦 Manifests: ${status.manifests.count} discovered`);
      console.log(`   Objects:   ${status.manifests.objects} total`);
      console.log();

      if (applied.length === 0) {
        console.log('📋 Applied Migrations: None');
        console.log();
        console.log('💡 Run `smrt db:migrate` to apply pending schema changes');
      } else {
        console.log(`📋 Applied Migrations: ${applied.length}`);
        console.log();

        if (options.verbose) {
          // Detailed table
          console.log(
            '   Name                              Version    Applied At           Status',
          );
          console.log(`   ${'─'.repeat(80)}`);

          for (const m of applied) {
            const name = m.name.padEnd(35).substring(0, 35);
            const version = m.version.padEnd(10).substring(0, 10);
            const appliedAt = m.applied_at.toISOString().substring(0, 19);
            const statusIcon =
              m.status === 'completed'
                ? '✓'
                : m.status === 'failed'
                  ? '✗'
                  : '⊙';
            console.log(
              `   ${name} ${version} ${appliedAt} ${statusIcon} ${m.status}`,
            );
          }
        } else {
          // Compact list
          for (const m of applied.slice(-10)) {
            const statusIcon =
              m.status === 'completed'
                ? '✓'
                : m.status === 'failed'
                  ? '✗'
                  : '⊙';
            const timeAgo = getTimeAgo(m.applied_at);
            console.log(`   ${statusIcon} ${m.name} (${timeAgo})`);
          }

          if (applied.length > 10) {
            console.log(`   ... and ${applied.length - 10} more`);
          }
        }
      }

      console.log();

      // Drift warnings
      if (status.drift.length > 0) {
        console.log('⚠️  Drift Detected:');
        for (const d of status.drift) {
          console.log(`   • ${d.name}: ${d.type}`);
          if (options.verbose) {
            console.log(`     ${d.recommendation}`);
          }
        }
        console.log();
      } else {
        console.log('✅ Live schema matches current manifests');
        console.log();
      }

      if (!schemaContract.ok) {
        console.log('❌ Schema Contract Failed:');
        console.log(formatSchemaContractFailures(schemaContract));
        console.log();
        process.exitCode = 1;
      } else {
        console.log('✅ Schema contract passed');
        console.log();
      }

      if (status.preconditions.length > 0) {
        console.log('⚠️  Compatibility Preconditions:');
        for (const item of status.preconditions) {
          const prefix = item.status === 'error' ? '❌' : '⚠️';
          console.log(`   ${prefix} ${item.name}: ${item.message}`);
          if (options.verbose) {
            console.log(`      ${item.recommendation}`);
          }
        }
        console.log();
        if (status.preconditions.some((item) => item.status === 'error')) {
          process.exitCode = 1;
        }
      }

      printFailedMigrationGroup(
        '⚠️  Failed migrations still map to unresolved live drift:',
        status.failedMigrations.unresolved,
        options.verbose,
      );
      printFailedMigrationGroup(
        '⚠️  Failed migrations requiring direct review:',
        status.failedMigrations.other,
        options.verbose,
      );
      printFailedMigrationGroup(
        'ℹ️  Historical failed generated schema repairs already superseded by the live schema:',
        status.failedMigrations.superseded,
        options.verbose,
      );

      if (failedAssessments.length > 0) {
        console.log(
          `🧾 Failed migration history: ${status.migrations.failed.actionRequired} action required, ${status.migrations.failed.superseded} superseded, ${status.migrations.failed.manualReview} manual review`,
        );
        if (options.verbose) {
          for (const item of failedAssessments) {
            console.log(`   • ${item.name}: ${item.resolution}`);
            console.log(`     ${item.reason}`);
            if (item.errorMessage) {
              console.log(`     Last error: ${item.errorMessage}`);
            }
          }
        }
        console.log();
      }

      console.log('💡 Commands:');
      console.log('   smrt db:migrate   - Apply pending changes');
      console.log('   smrt db:history   - View migration history');
      console.log('   smrt db:diff      - Show schema differences');
      console.log();
    } catch (error) {
      if (options.json) {
        console.log(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      } else {
        console.error('\n❌ Failed to get migration status:');
        if (error instanceof Error) {
          console.error(`   ${error.message}`);
        }
      }
      process.exitCode = 1;
      return;
    } finally {
      await closeDatabaseConnection(db);
    }
  },
};

/**
 * Get human-readable time ago string
 */
function getTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;

  return date.toLocaleDateString();
}

function printFailedMigrationGroup(
  title: string,
  migrations: Array<{
    name: string;
    recommendation: string;
    errorMessage: string | null;
  }>,
  verbose: boolean | undefined,
): void {
  if (migrations.length === 0) {
    return;
  }

  console.log(title);
  for (const migration of migrations) {
    console.log(`   • ${migration.name}`);
    if (verbose) {
      console.log(`     ${migration.recommendation}`);
      if (migration.errorMessage) {
        console.log(`     Last error: ${migration.errorMessage}`);
      }
    }
  }
  console.log();
}
