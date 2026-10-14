import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { CLICommand } from '../cli-generator.js';
import { autoDiscoverAndLoad } from '../discovery/index.js';
import { importConsumerPackage } from '../loaders/consumer-package.js';
import {
  closeDatabaseConnection,
  formatDatabaseDisplayUrl,
  redactDatabaseUrlsInText,
} from './db-command-utils.js';

const COMMERCE_PACKAGE = '@happyvertical/smrt-commerce';

interface CommerceMoneyModule {
  migrateCommerceLineAmounts(
    db: DatabaseInterface,
    options: {
      acceptDraftChanges: boolean;
      migrationId: string;
      tenantId: string;
    },
  ): Promise<{
    activated: boolean;
    migrated: number;
    migrationId: string;
    report: CommerceMoneyReportLike;
    resumed: number;
    tenantId: string;
  }>;
  preflightCommerceLineAmounts(
    db: DatabaseInterface,
    options: {
      out?: { csvPath: string; jsonPath: string };
      tenantId?: string;
    },
  ): Promise<CommerceMoneyReportLike>;
  rollbackCommerceLineAmounts(
    db: DatabaseInterface,
    options: { migrationId: string; tenantId: string },
  ): Promise<{
    alreadyRestored: number;
    migrationId: string;
    restored: number;
    tenantId: string;
  }>;
}

function loadCommerceMoneyModule(): Promise<CommerceMoneyModule> {
  return importConsumerPackage<CommerceMoneyModule>(COMMERCE_PACKAGE);
}

interface CommerceMoneyReportOptions {
  'csv-path'?: string;
  'json-path'?: string;
  'tenant-id'?: string;
}

interface CommerceMoneyMigrationOptions {
  'accept-draft-changes'?: boolean;
  'migration-id'?: string;
  'tenant-id'?: string;
}

interface CommerceMoneyRollbackOptions {
  'migration-id'?: string;
  'tenant-id'?: string;
}

interface CommerceMoneyReportLike {
  documents: Array<{
    documentId: string;
    documentType: string;
    reasons: string[];
    tenantId: string;
  }>;
  tenants: Array<{
    changingDraftCount: number;
    documentCount: number;
    issuedUnpostedFallbackTaxCount: number;
    reasonCounts: Record<string, number | undefined>;
    tenantId: string;
  }>;
}

function requiredOption(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`--${name} is required`);
  return normalized;
}

function reportOutput(options: CommerceMoneyReportOptions) {
  const jsonPath = options['json-path']?.trim();
  const csvPath = options['csv-path']?.trim();
  if (Boolean(jsonPath) !== Boolean(csvPath)) {
    throw new Error('--json-path and --csv-path must be supplied together');
  }
  return jsonPath && csvPath ? { jsonPath, csvPath } : undefined;
}

function renderReport(report: CommerceMoneyReportLike): void {
  for (const tenant of report.tenants) {
    const reasons = Object.entries(tenant.reasonCounts)
      .filter(([, count]) => Number(count) > 0)
      .map(([reason, count]) => `${reason}=${count}`)
      .join(', ');
    console.log(
      `  ${tenant.tenantId}: ${tenant.documentCount} document(s), ${tenant.changingDraftCount} changing draft(s), ${tenant.issuedUnpostedFallbackTaxCount} issued/unposted fallback-tax document(s)${reasons ? `; ${reasons}` : ''}`,
    );
  }
  for (const document of report.documents) {
    if (document.reasons.length === 0) continue;
    console.log(
      `    ${document.tenantId}/${document.documentType}/${document.documentId}: ${document.reasons.join(', ')}`,
    );
  }
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error && typeof error === 'object' && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  return `${typeof code === 'string' && code ? `[${code}] ` : ''}${message}`;
}

async function configuredDatabase(command: string): Promise<{
  db: DatabaseInterface;
  dbType: string;
  dbUrl: string;
}> {
  const { getPackageConfig } = await import('@happyvertical/smrt-config');
  const { DEFAULT_CLI_CONFIG } = await import('../config.js');
  const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);
  if (!config.database?.url || config.database.url === ':memory:') {
    throw new Error(
      `Database configuration required for ${command}. Configure database.url in smrt.config.ts (or DATABASE_URL).`,
    );
  }
  await autoDiscoverAndLoad();
  const { getDatabase } = await import('@happyvertical/sql');
  const dbType = config.database.type || 'sqlite';
  return {
    db: await getDatabase({ type: dbType, url: config.database.url }),
    dbType,
    dbUrl: config.database.url,
  };
}

function commonOptions() {
  return {
    'tenant-id': {
      type: 'string' as const,
      description: 'Authoritative tenant identifier.',
    },
  };
}

export const dbPreflightCommerceMoneyCommand: CLICommand = {
  name: 'db:preflight-commerce-money',
  description:
    'Read and report legacy Commerce line amounts before activating the v2 money model. Never writes database state.',
  aliases: ['commerce-money:preflight'],
  args: [],
  options: {
    ...commonOptions(),
    'json-path': {
      type: 'string',
      description: 'Write the deterministic JSON report to this path.',
    },
    'csv-path': {
      type: 'string',
      description: 'Write the deterministic CSV report to this path.',
    },
  },
  handler: async (_args: string[], options: CommerceMoneyReportOptions) => {
    let db: DatabaseInterface | undefined;
    try {
      const out = reportOutput(options);
      const configured = await configuredDatabase(
        'db:preflight-commerce-money',
      );
      db = configured.db;
      const { preflightCommerceLineAmounts } = await loadCommerceMoneyModule();
      console.log('\n💰 Commerce money preflight\n');
      console.log(
        `✓ Connected to ${formatDatabaseDisplayUrl(configured.dbType, configured.dbUrl)}\n`,
      );
      const tenantId = options['tenant-id']?.trim() || undefined;
      const report = await preflightCommerceLineAmounts(db, { out, tenantId });
      renderReport(report);
      if (out) {
        console.log(`\n✓ Wrote ${out.jsonPath} and ${out.csvPath}.`);
      }
      console.log(
        `\nPreflight complete: ${report.documents.length} document(s) across ${report.tenants.length} tenant(s). No database changes made.\n`,
      );
    } catch (error) {
      console.error(
        `\n❌ Commerce money preflight failed: ${redactDatabaseUrlsInText(errorMessage(error))}\n`,
      );
      process.exitCode = 1;
    } finally {
      await closeDatabaseConnection(db);
    }
  },
};

export const dbMigrateCommerceMoneyCommand: CLICommand = {
  name: 'db:migrate-commerce-money',
  description:
    'Migrate one tenant to the Commerce v2 money model after reviewing preflight output.',
  aliases: ['commerce-money:migrate'],
  args: [],
  options: {
    ...commonOptions(),
    'accept-draft-changes': {
      type: 'boolean',
      description: 'Accept draft total changes identified by the preflight.',
      default: false,
    },
    'migration-id': {
      type: 'string',
      description:
        'Resume the active tenant migration with its owner identity.',
    },
  },
  handler: async (_args: string[], options: CommerceMoneyMigrationOptions) => {
    let db: DatabaseInterface | undefined;
    try {
      const tenantId = requiredOption(options['tenant-id'], 'tenant-id');
      const configured = await configuredDatabase('db:migrate-commerce-money');
      db = configured.db;
      const { migrateCommerceLineAmounts } = await loadCommerceMoneyModule();
      console.log('\n💰 Commerce money migration\n');
      console.log(
        `✓ Connected to ${formatDatabaseDisplayUrl(configured.dbType, configured.dbUrl)}\n`,
      );
      const migrationId = options['migration-id']?.trim() || randomUUID();
      console.log(
        `Migration owner: ${migrationId} (reuse with --migration-id after an interrupted attempt).\n`,
      );
      const result = await migrateCommerceLineAmounts(db, {
        tenantId,
        acceptDraftChanges: options['accept-draft-changes'] === true,
        migrationId,
      });
      renderReport(result.report);
      console.log(
        `\n✓ Tenant ${result.tenantId} activated v2 money model (migration ${result.migrationId}); migrated ${result.migrated}, resumed ${result.resumed}.\n`,
      );
    } catch (error) {
      console.error(
        `\n❌ Commerce money migration failed: ${redactDatabaseUrlsInText(errorMessage(error))}\n`,
      );
      process.exitCode = 1;
    } finally {
      await closeDatabaseConnection(db);
    }
  },
};

export const dbRollbackCommerceMoneyCommand: CLICommand = {
  name: 'db:rollback-commerce-money',
  description:
    'Restore one Commerce tenant from its durable v2 money migration journal.',
  aliases: ['commerce-money:rollback'],
  args: [],
  options: {
    ...commonOptions(),
    'migration-id': {
      type: 'string',
      description: 'Migration owner identity recorded during activation.',
    },
  },
  handler: async (_args: string[], options: CommerceMoneyRollbackOptions) => {
    let db: DatabaseInterface | undefined;
    try {
      const tenantId = requiredOption(options['tenant-id'], 'tenant-id');
      const migrationId = requiredOption(
        options['migration-id'],
        'migration-id',
      );
      const configured = await configuredDatabase('db:rollback-commerce-money');
      db = configured.db;
      const { rollbackCommerceLineAmounts } = await loadCommerceMoneyModule();
      console.log('\n💰 Commerce money rollback\n');
      console.log(
        `✓ Connected to ${formatDatabaseDisplayUrl(configured.dbType, configured.dbUrl)}\n`,
      );
      const result = await rollbackCommerceLineAmounts(db, {
        tenantId,
        migrationId,
      });
      console.log(
        `\n✓ Tenant ${result.tenantId} migration ${result.migrationId} rolled back; restored ${result.restored}, already restored ${result.alreadyRestored}.\n`,
      );
    } catch (error) {
      console.error(
        `\n❌ Commerce money rollback failed: ${redactDatabaseUrlsInText(errorMessage(error))}\n`,
      );
      process.exitCode = 1;
    } finally {
      await closeDatabaseConnection(db);
    }
  },
};
