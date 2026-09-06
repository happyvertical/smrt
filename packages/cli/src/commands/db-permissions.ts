import { getPackageConfig } from '@happyvertical/smrt-config';
import type { PostgresPermissionPlan } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { CLICommand } from '../cli-generator.js';
import { DEFAULT_CLI_CONFIG } from '../config.js';
import { autoDiscoverAndLoad } from '../discovery/index.js';
import { closeDatabaseConnection } from './db-command-utils.js';

export interface DbPermissionsOptions {
  json?: boolean;
  'dry-run'?: boolean;
  apply?: boolean;
  'expected-fingerprint'?: string;
}

export interface PermissionsOutcome {
  skipped: boolean;
  plan: PostgresPermissionPlan | null;
  error: string | null;
}

/** The only mutating caller is the explicit permissions command. */
export async function runPostgresPermissions(
  options: DbPermissionsOptions = {},
  optional = false,
): Promise<PermissionsOutcome> {
  const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);
  const configured = config.postgresPermissions;
  const failure = (error: string): PermissionsOutcome => ({
    skipped: false,
    plan: null,
    error,
  });
  if (!configured && optional)
    return { skipped: true, plan: null, error: null };
  if (!configured)
    return failure(
      'Configure postgresPermissions before inspecting or applying database permissions.',
    );
  if (config.database?.type !== 'postgres' || !config.database.url) {
    return failure(
      'PostgreSQL permissions require a configured PostgreSQL database.',
    );
  }
  if (
    options.apply &&
    (options['dry-run'] || !options['expected-fingerprint'])
  ) {
    return failure(
      '--apply requires --expected-fingerprint from a reviewed plan and cannot be combined with --dry-run.',
    );
  }
  let db: DatabaseInterface | undefined;
  try {
    await autoDiscoverAndLoad();
    const { getDatabase } = await import('@happyvertical/sql');
    const {
      ObjectRegistry,
      getSystemTableShapes,
      planPostgresPermissions,
      applyPostgresPermissions,
    } = await import('@happyvertical/smrt-core');
    db = await getDatabase({ type: 'postgres', url: config.database.url });
    // Optional framework features may not have installed their system tables.
    // Read catalog metadata in the configured schema, never application rows.
    const { rows } = await db.query(
      'SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = $1',
      [configured.schema],
    );
    const present = new Set(rows.map((row) => row.tablename));
    const managedTables = [
      ...new Set([
        ...Object.keys(ObjectRegistry.getAllSchemasAsDefinitions()),
        ...[...getSystemTableShapes('postgres').keys()].filter((table) =>
          present.has(table),
        ),
        ...(configured.managedTables ?? []),
      ]),
    ].sort();
    const contract = { ...configured, managedTables };
    const plan = options.apply
      ? await applyPostgresPermissions(db, contract, {
          expectedFingerprint: options['expected-fingerprint'] ?? '',
        })
      : await planPostgresPermissions(db, contract);
    return { skipped: false, plan, error: null };
  } catch {
    // Driver and discovery errors may contain connection secrets or row data.
    return failure(
      'PostgreSQL permissions could not be verified or applied. Check connectivity, contract validity, administrator authority, and the reviewed fingerprint.',
    );
  } finally {
    try {
      await closeDatabaseConnection(db);
    } catch {
      /* Never expose adapter errors. */
    }
  }
}

export function formatPermissionsOutcome(
  outcome: PermissionsOutcome,
): string[] {
  if (outcome.skipped) return [];
  if (outcome.error) return [`PostgreSQL permissions: ${outcome.error}`];
  const plan = outcome.plan;
  if (!plan) return ['PostgreSQL permissions could not be verified.'];
  return [
    `PostgreSQL permissions: ${plan.diagnostics.length} finding(s)`,
    ...plan.diagnostics.map(
      (finding) =>
        `  ${finding.severity}: ${finding.role ? `${finding.role} · ` : ''}${finding.resource}: ${finding.message}`,
    ),
    `Plan fingerprint: ${plan.fingerprint}`,
    ...plan.limitations.map((limitation) => `Scope: ${limitation}`),
    ...(plan.canApply
      ? []
      : [
          'Automatic application refused; resolve unsupported conditions first.',
        ]),
  ];
}

export function outputPermissionsOutcome(
  outcome: PermissionsOutcome,
  json = false,
): void {
  if (json) console.log(JSON.stringify(outcome, null, 2));
  else for (const line of formatPermissionsOutcome(outcome)) console.log(line);
  if (outcome.error || outcome.plan?.diagnostics.length) process.exitCode = 1;
}

export const dbPermissionsCommand: CLICommand = {
  name: 'db:permissions',
  description:
    'Inspect PostgreSQL role permissions; explicitly apply a reviewed plan',
  args: [],
  options: {
    'dry-run': { type: 'boolean', description: 'Read-only plan (the default)' },
    apply: {
      type: 'boolean',
      description: 'Apply the reviewed plan explicitly',
      default: false,
    },
    'expected-fingerprint': {
      type: 'string',
      description: 'Fingerprint from the reviewed read-only plan',
    },
    json: {
      type: 'boolean',
      description: 'Output plan and diagnostics as JSON',
      default: false,
    },
  },
  handler: async (_args: string[], options: DbPermissionsOptions) => {
    const outcome = await runPostgresPermissions(options);
    outputPermissionsOutcome(outcome, options.json);
    if (!options.json && outcome.plan && !options.apply) {
      console.log('Read-only plan SQL:');
      for (const sql of outcome.plan.statements) console.log(sql);
    }
  },
};
