/** Shared tenant serialization barrier for commerce money runtime and migration. */

import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import {
  materializeTenantTaxSettings,
  TaxSettingsCollection,
} from './collections/TaxSettingsCollection.js';
import {
  MONEY_MIGRATION_WRITE,
  withDocumentMoneyTransaction,
} from './document-money-internal.js';
import type { TaxSettings } from './models/TaxSettings.js';
import { MoneyValidationError } from './money.js';
import { tenantHasMoneyDocuments } from './tenant-money-default.js';

export type TenantMoneyRuntimeRequirement = 'legacy-or-v2' | 'v2';

export type TenantMoneyRuntimeBarrier =
  | {
      readonly moneyModel: 'legacy';
      readonly settings: null;
      readonly persistedBarrier: false;
    }
  | {
      readonly moneyModel: 'legacy';
      readonly settings: TaxSettings;
      readonly persistedBarrier: true;
    }
  | {
      readonly moneyModel: 'v2';
      readonly settings: TaxSettings;
      readonly persistedBarrier: true;
    };

declare const tenantMoneyScopeBrand: unique symbol;

/** Transaction-affine proof that a tenant marker is locked on `db`. */
export interface TenantMoneyRuntimeScope {
  readonly db: DatabaseInterface;
  readonly tenantId: string;
  readonly barrier: TenantMoneyRuntimeBarrier;
  readonly phase: 'runtime';
  readonly [tenantMoneyScopeBrand]: true;
}

declare const tenantMoneyMigrationScopeBrand: unique symbol;

/** Transaction-affine proof held only by the active migration owner. */
export interface TenantMoneyMigrationScope {
  readonly db: DatabaseInterface;
  readonly tenantId: string;
  readonly migrationId: string;
  readonly settings: TaxSettings;
  readonly phase: 'migration';
  readonly [tenantMoneyMigrationScopeBrand]: true;
}

function requiredText(value: string, label: string): string {
  if (!value || value.trim() !== value)
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      `${label} must be a nonempty trimmed string`,
    );
  return value;
}

async function hasSettingsStorage(db: DatabaseInterface): Promise<boolean> {
  return !db.tableExists || (await db.tableExists('tax_settings'));
}

const activeRuntimeScopes = new WeakMap<
  object,
  Map<string, TenantMoneyRuntimeScope>
>();
const activeMigrationScopes = new WeakMap<
  object,
  Map<string, TenantMoneyMigrationScope>
>();

function runtimeScope(
  db: DatabaseInterface,
  tenantId: string,
  barrier: TenantMoneyRuntimeBarrier,
): TenantMoneyRuntimeScope {
  return {
    db,
    tenantId,
    barrier,
    phase: 'runtime',
  } as TenantMoneyRuntimeScope;
}

/**
 * Lock and re-read the tenant money marker before any runtime money work.
 *
 * Older schemas without TaxSettings stay byte-compatible legacy and are never
 * modified. Once the table exists, a missing deterministic row is
 * materialized to provide the serialization point shared by migration; it
 * starts on `v2` when the tenant has no stored documents (#4009).
 */
export async function lockTenantMoneyRuntime(
  tx: DatabaseInterface,
  tenantId: string,
  requirement: TenantMoneyRuntimeRequirement = 'legacy-or-v2',
): Promise<TenantMoneyRuntimeBarrier> {
  requiredText(tenantId, 'Money tenant');
  if (!(await hasSettingsStorage(tx))) {
    if (requirement === 'v2')
      throw new MoneyValidationError(
        'INVALID_MONEY_INPUT',
        'Money v2 requires tenant tax settings storage',
      );
    return {
      moneyModel: 'legacy',
      settings: null,
      persistedBarrier: false,
    };
  }
  const collection = await TaxSettingsCollection.create({ db: tx });
  const settings = await collection.lockForTenant(tenantId);
  if (!settings)
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Tenant money settings could not be materialized',
    );
  if (settings.moneyModel === 'migrating')
    throw new MoneyValidationError(
      'FROZEN_DOCUMENT',
      'Tenant money migration is in progress',
    );
  if (settings.moneyModel === 'v2')
    return { moneyModel: 'v2', settings, persistedBarrier: true };
  if (requirement === 'v2')
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Money v2 is not active for this tenant',
    );
  return { moneyModel: 'legacy', settings, persistedBarrier: true };
}

/**
 * Run tenant money work under the shared marker lock on exactly one executor.
 *
 * Supplying an existing scope proves re-entry on the same executor. Calls made
 * through the owning transaction wrapper also reuse its exact registered
 * executor. No optional adapter-property heuristic can grant this capability.
 */
export async function withTenantMoneyRuntime<T>(
  db: DatabaseInterface,
  tenantId: string,
  requirement: TenantMoneyRuntimeRequirement,
  operation: (scope: TenantMoneyRuntimeScope) => Promise<T>,
  existingScope?: TenantMoneyRuntimeScope,
): Promise<T> {
  requiredText(tenantId, 'Money tenant');
  if (existingScope) {
    if (
      existingScope.phase !== 'runtime' ||
      existingScope.db !== db ||
      existingScope.tenantId !== tenantId ||
      (requirement === 'v2' && existingScope.barrier.moneyModel !== 'v2')
    )
      throw new MoneyValidationError(
        'INVALID_MONEY_INPUT',
        'Tenant money runtime scope does not match the requested executor',
      );
    return operation(existingScope);
  }
  return withDocumentMoneyTransaction(db, async (tx) => {
    const active = activeRuntimeScopes.get(tx as object)?.get(tenantId);
    if (active) {
      if (requirement === 'v2' && active.barrier.moneyModel !== 'v2')
        throw new MoneyValidationError(
          'INVALID_MONEY_INPUT',
          'Money v2 is not active for this tenant',
        );
      return operation(active);
    }
    const barrier = await lockTenantMoneyRuntime(tx, tenantId, requirement);
    const scope = runtimeScope(tx, tenantId, barrier);
    const scopes = activeRuntimeScopes.get(tx as object) ?? new Map();
    scopes.set(tenantId, scope);
    activeRuntimeScopes.set(tx as object, scopes);
    try {
      return await operation(scope);
    } finally {
      scopes.delete(tenantId);
      if (scopes.size === 0) activeRuntimeScopes.delete(tx as object);
    }
  });
}

/**
 * Run migration work under the exact owner marker and transaction executor.
 * This is the only scope that lets guarded collections read while the marker
 * is `migrating`; possession cannot be inferred from adapter shape.
 */
export async function withTenantMoneyMigration<T>(
  db: DatabaseInterface,
  tenantId: string,
  migrationId: string,
  operation: (scope: TenantMoneyMigrationScope) => Promise<T>,
  existingScope?: TenantMoneyMigrationScope,
): Promise<T> {
  requiredText(tenantId, 'Money migration tenant');
  requiredText(migrationId, 'Money migration owner');
  if (existingScope) {
    if (
      existingScope.phase !== 'migration' ||
      existingScope.db !== db ||
      existingScope.tenantId !== tenantId ||
      existingScope.migrationId !== migrationId
    )
      throw new MoneyValidationError(
        'INVALID_MONEY_INPUT',
        'Tenant money migration scope does not match the requested executor',
      );
    return operation(existingScope);
  }
  return withDocumentMoneyTransaction(db, async (tx) => {
    const active = activeMigrationScopes.get(tx as object)?.get(tenantId);
    if (active) {
      if (active.migrationId !== migrationId)
        throw new MoneyValidationError(
          'FROZEN_DOCUMENT',
          'Tenant money migration owner does not match',
        );
      return operation(active);
    }
    const settings = await lockTenantMoneyMigrationOwner(
      tx,
      tenantId,
      migrationId,
    );
    const scope = {
      db: tx,
      tenantId,
      migrationId,
      settings,
      phase: 'migration',
    } as TenantMoneyMigrationScope;
    const scopes = activeMigrationScopes.get(tx as object) ?? new Map();
    scopes.set(tenantId, scope);
    activeMigrationScopes.set(tx as object, scopes);
    try {
      return await operation(scope);
    } finally {
      scopes.delete(tenantId);
      if (scopes.size === 0) activeMigrationScopes.delete(tx as object);
    }
  });
}

/** @internal Guard a generated collection read for runtime or migration. */
export async function withTenantMoneyCollectionRead<T>(
  db: DatabaseInterface,
  tenantId: string,
  operation: (boundDb: DatabaseInterface) => Promise<T>,
): Promise<T> {
  const migration = activeMigrationScopes.get(db as object)?.get(tenantId);
  if (migration) return operation(migration.db);
  return withTenantMoneyRuntime(db, tenantId, 'legacy-or-v2', (scope) =>
    operation(scope.db),
  );
}

/** Lock a tenant at the legacy marker before the caller claims migration. */
export async function lockTenantMoneyMigrationClaim(
  tx: DatabaseInterface,
  tenantId: string,
): Promise<TaxSettings> {
  requiredText(tenantId, 'Money migration tenant');
  if (!(await hasSettingsStorage(tx)))
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Money migration requires installed tax settings storage',
    );
  // The migration starts from `legacy`: a tenant first seen here gets a legacy
  // marker, not the clean-tenant v2 default, so an empty tenant still migrates.
  await materializeTenantTaxSettings(tx, tenantId, 'legacy');
  const collection = await TaxSettingsCollection.create({ db: tx });
  const settings = await collection.lockForTenant(tenantId, false);
  if (!settings)
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Tenant money settings could not be materialized',
    );
  if (settings.moneyModel === 'v2')
    throw new MoneyValidationError(
      'FROZEN_DOCUMENT',
      'Tenant money model is already v2',
    );
  if (settings.moneyModel === 'migrating')
    throw new MoneyValidationError(
      'FROZEN_DOCUMENT',
      'Tenant money migration is already in progress',
    );
  return settings;
}

/** Lock and verify the exact owner of an active tenant migration. */
export async function lockTenantMoneyMigrationOwner(
  tx: DatabaseInterface,
  tenantId: string,
  migrationId: string,
): Promise<TaxSettings> {
  requiredText(tenantId, 'Money migration tenant');
  requiredText(migrationId, 'Money migration owner');
  if (!(await hasSettingsStorage(tx)))
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Money migration requires installed tax settings storage',
    );
  const collection = await TaxSettingsCollection.create({ db: tx });
  const settings = await collection.lockForTenant(tenantId, false);
  if (
    settings?.moneyModel !== 'migrating' ||
    settings.moneyMigrationId !== migrationId
  )
    throw new MoneyValidationError(
      'FROZEN_DOCUMENT',
      'Tenant money migration owner does not match',
    );
  return settings;
}

/**
 * Move a tenant with no stored Invoice or Contract rows to `v2` (#4009).
 *
 * Creates the marker when missing, then locks it. Every runtime document
 * write takes that same row lock before it touches a document, so the
 * document check under the lock is authoritative. A tenant with documents
 * stays `legacy`: only the tenant migration converts it. A tenant already on
 * `v2` is unchanged, and a migration in progress fails closed. Idempotent.
 */
export async function activateCleanTenantMoneyV2(
  db: DatabaseInterface,
  tenantId: string,
): Promise<'legacy' | 'v2'> {
  requiredText(tenantId, 'Money tenant');
  return withDocumentMoneyTransaction(db, async (tx) => {
    if (!(await hasSettingsStorage(tx)))
      throw new MoneyValidationError(
        'INVALID_MONEY_INPUT',
        'Money v2 requires tenant tax settings storage',
      );
    const settings = await (
      await TaxSettingsCollection.create({ db: tx })
    ).lockForTenant(tenantId);
    if (!settings)
      throw new MoneyValidationError(
        'INVALID_MONEY_INPUT',
        'Tenant money settings could not be materialized',
      );
    if (settings.moneyModel === 'v2') return 'v2';
    if (settings.moneyModel === 'migrating')
      throw new MoneyValidationError(
        'FROZEN_DOCUMENT',
        'Tenant money migration is in progress',
      );
    if (await tenantHasMoneyDocuments(tx, tenantId)) return 'legacy';
    settings.moneyModel = 'v2';
    await settings.saveMoneyModelOnTransaction(MONEY_MIGRATION_WRITE);
    return 'v2';
  });
}

/**
 * @internal Keep a tenant with no marker on `legacy` for a producer that does
 * not write money-v2 documents yet. Billing period close is the one such
 * producer (#4013). A tenant that already has a marker is never changed, and
 * an older schema without settings storage is already legacy.
 */
export async function retainLegacyTenantMoneyModel(
  db: DatabaseInterface,
  tenantId: string,
): Promise<void> {
  requiredText(tenantId, 'Money tenant');
  if (!(await hasSettingsStorage(db))) return;
  await materializeTenantTaxSettings(db, tenantId, 'legacy');
}
