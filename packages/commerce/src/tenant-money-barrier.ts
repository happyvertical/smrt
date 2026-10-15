/** Tenant serialization point for commerce money runtime work. */

import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { TaxSettingsCollection } from './collections/TaxSettingsCollection.js';
import { withDocumentMoneyTransaction } from './document-money-internal.js';
import type { TaxSettings } from './models/TaxSettings.js';
import { MoneyValidationError } from './money.js';
import { assertTenantMoneyCurrent } from './upgrade/detect.js';

declare const tenantMoneyScopeBrand: unique symbol;

/** Transaction-affine proof that a tenant's settings row is locked on `db`. */
export interface TenantMoneyRuntimeScope {
  readonly db: DatabaseInterface;
  readonly tenantId: string;
  readonly settings: TaxSettings;
  readonly phase: 'runtime';
  readonly [tenantMoneyScopeBrand]: true;
}

function requiredText(value: string, label: string): string {
  if (!value || value.trim() !== value)
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      `${label} must be a nonempty trimmed string`,
    );
  return value;
}

const activeRuntimeScopes = new WeakMap<
  object,
  Map<string, TenantMoneyRuntimeScope>
>();

/**
 * Lock and re-read the tenant's tax settings row before runtime money work,
 * creating it once when missing. Old-format money data is refused first with
 * `COMMERCE_DATA_NEEDS_UPGRADE`.
 */
export async function lockTenantMoneyRuntime(
  tx: DatabaseInterface,
  tenantId: string,
): Promise<TaxSettings> {
  requiredText(tenantId, 'Money tenant');
  await assertTenantMoneyCurrent(tx, tenantId);
  return (await TaxSettingsCollection.create({ db: tx })).lockForTenant(
    tenantId,
  );
}

/**
 * Run tenant money work under the tenant settings lock on exactly one
 * executor.
 *
 * Supplying an existing scope proves re-entry on the same executor. Calls made
 * through the owning transaction wrapper also reuse its exact registered
 * executor. No optional adapter-property heuristic can grant this capability.
 */
export async function withTenantMoneyRuntime<T>(
  db: DatabaseInterface,
  tenantId: string,
  operation: (scope: TenantMoneyRuntimeScope) => Promise<T>,
  existingScope?: TenantMoneyRuntimeScope,
): Promise<T> {
  requiredText(tenantId, 'Money tenant');
  if (existingScope) {
    if (
      existingScope.phase !== 'runtime' ||
      existingScope.db !== db ||
      existingScope.tenantId !== tenantId
    )
      throw new MoneyValidationError(
        'INVALID_MONEY_INPUT',
        'Tenant money runtime scope does not match the requested executor',
      );
    return operation(existingScope);
  }
  return withDocumentMoneyTransaction(db, async (tx) => {
    const active = activeRuntimeScopes.get(tx as object)?.get(tenantId);
    if (active) return operation(active);
    const settings = await lockTenantMoneyRuntime(tx, tenantId);
    const scope = {
      db: tx,
      tenantId,
      settings,
      phase: 'runtime',
    } as TenantMoneyRuntimeScope;
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
 * @internal Guard a generated money-document collection read: a tenant whose
 * data predates the current money model is refused before any row is read.
 */
export async function withTenantMoneyCollectionRead<T>(
  db: DatabaseInterface,
  tenantId: string,
  operation: (boundDb: DatabaseInterface) => Promise<T>,
): Promise<T> {
  await assertTenantMoneyCurrent(db, tenantId);
  return operation(db);
}
