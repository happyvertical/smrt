/**
 * `smrt db:upgrade-commerce-money` and the matching `db:status` precondition
 * (#4021). Commerce refuses money data written by an earlier version with
 * `COMMERCE_DATA_NEEDS_UPGRADE`; this command converts it once. Delete this
 * module with commerce's `upgrade/` directory.
 */
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

interface TenantNeed {
  tenantId: string;
  reason: string;
}

interface CommerceMoneyUpgradeModule {
  findCommerceMoneyUpgradeNeeds(db: DatabaseInterface): Promise<{
    oldSchema: string[];
    tenantlessDocuments?: Array<{ table: string; id: string }>;
    tenants: TenantNeed[];
  }>;
  upgradeCommerceMoney(
    db: DatabaseInterface,
    options: { tenantId?: string },
  ): Promise<{
    upgraded: Array<{
      tenantId: string;
      issuedBackfilled: number;
      draftsRecomputed: number;
      changedDrafts: Array<{
        documentType: string;
        documentId: string;
        old: { totalMinor: number };
        next: { totalMinor: number };
      }>;
      componentsWithoutLiabilityAccount: string[];
    }>;
    failures: Array<{
      tenantId: string;
      documentType: string | null;
      documentId: string;
      reason: string;
    }>;
    droppedSchema: string[];
    remaining: TenantNeed[];
    tenantlessDocuments?: Array<{ table: string; id: string }>;
    billingSchedulesBackfilled?: number;
  }>;
}

/** The upgrade command, as named in commerce's refusal. */
export const COMMERCE_MONEY_UPGRADE_COMMAND = 'smrt db:upgrade-commerce-money';

function loadCommerce(): Promise<CommerceMoneyUpgradeModule> {
  return importConsumerPackage<CommerceMoneyUpgradeModule>(COMMERCE_PACKAGE);
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error && typeof error === 'object' && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  return `${typeof code === 'string' && code ? `[${code}] ` : ''}${message}`;
}

/**
 * `db:status` precondition: an error when the database holds commerce money
 * data from an earlier version. Empty when commerce is not installed.
 */
export async function checkCommerceMoneyPreconditions(
  db: DatabaseInterface,
): Promise<
  Array<{
    name: string;
    status: 'warning' | 'error';
    message: string;
    recommendation: string;
    details: Record<string, unknown>;
  }>
> {
  let commerce: CommerceMoneyUpgradeModule;
  try {
    commerce = await loadCommerce();
  } catch {
    return [];
  }
  if (typeof commerce.findCommerceMoneyUpgradeNeeds !== 'function') return [];
  if (db.tableExists && !(await db.tableExists('invoices'))) return [];
  let status: Awaited<
    ReturnType<CommerceMoneyUpgradeModule['findCommerceMoneyUpgradeNeeds']>
  >;
  try {
    status = await commerce.findCommerceMoneyUpgradeNeeds(db);
  } catch (error) {
    return [
      {
        name: 'commerce-money-upgrade',
        status: 'warning',
        message: `Commerce money data could not be checked: ${redactDatabaseUrlsInText(errorMessage(error))}`,
        recommendation: `Run ${COMMERCE_MONEY_UPGRADE_COMMAND} --check.`,
        details: {},
      },
    ];
  }
  const tenantless = status.tenantlessDocuments ?? [];
  if (
    status.oldSchema.length === 0 &&
    status.tenants.length === 0 &&
    tenantless.length === 0
  )
    return [];
  return [
    {
      name: 'commerce-money-upgrade',
      status: 'error',
      message: `COMMERCE_DATA_NEEDS_UPGRADE: commerce money data from an earlier version (${status.tenants.length} tenant(s) to convert${
        status.oldSchema.length
          ? `; old columns ${status.oldSchema.join(', ')}`
          : ''
      }${
        tenantless.length
          ? `; ${tenantless.length} document row(s) without a tenant to assign or delete`
          : ''
      }). Commerce refuses it until it is upgraded.`,
      recommendation: `Run ${COMMERCE_MONEY_UPGRADE_COMMAND} (add --tenant-id <id> to convert one tenant).`,
      details: {
        oldSchema: status.oldSchema,
        tenants: status.tenants,
        tenantlessDocuments: tenantless.length,
      },
    },
  ];
}

async function configuredDatabase(): Promise<{
  db: DatabaseInterface;
  dbType: string;
  dbUrl: string;
}> {
  const { getPackageConfig } = await import('@happyvertical/smrt-config');
  const { DEFAULT_CLI_CONFIG } = await import('../config.js');
  const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);
  if (!config.database?.url || config.database.url === ':memory:') {
    throw new Error(
      'Database configuration required for db:upgrade-commerce-money. Configure database.url in smrt.config.ts (or DATABASE_URL).',
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

interface UpgradeOptions {
  'tenant-id'?: string;
  check?: boolean;
}

export const dbUpgradeCommerceMoneyCommand: CLICommand = {
  name: 'db:upgrade-commerce-money',
  description:
    'Convert commerce money data written by an earlier version to the current money model, once. Each tenant converts atomically; an issued document that does not reconcile exactly fails its tenant.',
  aliases: ['commerce-money:upgrade'],
  args: [],
  options: {
    'tenant-id': {
      type: 'string',
      description: 'Convert only this tenant.',
    },
    check: {
      type: 'boolean',
      description: 'Report what needs the upgrade without changing anything.',
      default: false,
    },
  },
  handler: async (_args: string[], options: UpgradeOptions) => {
    let db: DatabaseInterface | undefined;
    try {
      const configured = await configuredDatabase();
      db = configured.db;
      const commerce = await loadCommerce();
      console.log('\n💰 Commerce money upgrade\n');
      console.log(
        `✓ Connected to ${formatDatabaseDisplayUrl(configured.dbType, configured.dbUrl)}\n`,
      );
      if (options.check) {
        const status = await commerce.findCommerceMoneyUpgradeNeeds(db);
        for (const need of status.tenants)
          console.log(`  ${need.tenantId}: ${need.reason}`);
        if (status.oldSchema.length)
          console.log(`  old columns: ${status.oldSchema.join(', ')}`);
        const tenantless = status.tenantlessDocuments ?? [];
        for (const row of tenantless)
          console.log(`  ${row.table} ${row.id}: no tenant (assign or delete)`);
        if (
          status.tenants.length === 0 &&
          status.oldSchema.length === 0 &&
          tenantless.length === 0
        )
          console.log('Nothing to upgrade.\n');
        else {
          console.log(
            `\n${status.tenants.length} tenant(s) need the upgrade. No database changes made.\n`,
          );
          process.exitCode = 1;
        }
        return;
      }
      const tenantId = options['tenant-id']?.trim() || undefined;
      const result = await commerce.upgradeCommerceMoney(db, { tenantId });
      for (const tenant of result.upgraded) {
        console.log(
          `✓ ${tenant.tenantId}: ${tenant.issuedBackfilled} issued document(s) backfilled, ${tenant.draftsRecomputed} draft(s) recomputed.`,
        );
        for (const draft of tenant.changedDrafts)
          console.log(
            `    ${draft.documentType} ${draft.documentId}: total ${draft.old.totalMinor} -> ${draft.next.totalMinor}`,
          );
        if (tenant.componentsWithoutLiabilityAccount.length)
          console.log(
            `    created tax components without a liability account: ${tenant.componentsWithoutLiabilityAccount.join(', ')}`,
          );
      }
      for (const failure of result.failures)
        console.error(
          `✗ ${failure.tenantId || '(no tenant)'}${
            failure.documentType
              ? ` ${failure.documentType} ${failure.documentId}`
              : ''
          }: ${failure.reason}`,
        );
      if (result.billingSchedulesBackfilled)
        console.log(
          `\n✓ Set ${result.billingSchedulesBackfilled} contract(s) with a NULL billing schedule to empty.`,
        );
      if (result.droppedSchema.length)
        console.log(
          `\n✓ Removed earlier-version columns: ${result.droppedSchema.join(', ')}`,
        );
      if (result.failures.length || result.remaining.length) {
        console.error(
          `\n❌ ${result.remaining.length} tenant(s) and ${(result.tenantlessDocuments ?? []).length} row(s) without a tenant still need attention.\n`,
        );
        process.exitCode = 1;
        return;
      }
      console.log('\nCommerce money upgrade complete.\n');
    } catch (error) {
      console.error(
        `\n❌ Commerce money upgrade failed: ${redactDatabaseUrlsInText(errorMessage(error))}\n`,
      );
      process.exitCode = 1;
    } finally {
      await closeDatabaseConnection(db);
    }
  },
};
