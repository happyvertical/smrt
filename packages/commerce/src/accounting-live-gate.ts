/**
 * Live-mode gate on accounting writes (#5138).
 *
 * The frozen invoice, credit and refund sync functions accepted any provider
 * with `environment: 'production'`; live use was blocked only by convention.
 * Production writes now need a deliberate, persisted enablement on the tenant's
 * {@link AccountingConnection} (`enableLiveAccounting`) for the same company,
 * and a connected production connection. Sandbox stays the default and needs
 * nothing. Without it a production write throws
 * {@link AccountingLiveGateError} before any state is reserved or any provider
 * call is made, so state is unchanged.
 *
 * See `agents/accounting-live-gate.md`.
 *
 * @packageDocumentation
 */

import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { AccountingConnectionCollection } from './collections/AccountingConnectionCollection.js';
import { InvoiceCollection } from './collections/InvoiceCollection.js';

/** Why the gate refused a write. */
export type AccountingLiveGateErrorCode =
  | 'LIVE_ACCOUNTING_NOT_ENABLED'
  | 'ACCOUNTING_ENVIRONMENT_MISMATCH';

/** Typed refusal: a production accounting write is not enabled. */
export class AccountingLiveGateError extends Error {
  readonly code: AccountingLiveGateErrorCode;

  constructor(code: AccountingLiveGateErrorCode, message: string) {
    super(message);
    this.name = 'AccountingLiveGateError';
    this.code = code;
  }
}

/** What a sync function is about to write to. */
export interface AccountingWriteTarget {
  readonly db: DatabaseInterface;
  readonly tenantId: string;
  /** The local document, used to read the realm and environment it is bound to. */
  readonly invoiceId?: string;
  /** The provider; its own `environment` is checked when it exposes one. */
  readonly provider?: object;
  /** The realm and environment the caller's mapping targets, when it has one. */
  readonly scope?: {
    readonly realmId: string;
    readonly environment: 'sandbox' | 'production';
  };
}

function providerEnvironment(provider: object | undefined): string | undefined {
  const value = (provider as { environment?: unknown } | undefined)
    ?.environment;
  return typeof value === 'string' ? value : undefined;
}

/**
 * The tenant's connection, or `null` when it has none. A database that has not
 * migrated the connection table yet has no connection by definition: sandbox
 * writes carry on and production stays refused.
 */
async function findConnection(target: AccountingWriteTarget) {
  try {
    return await withTenant({ tenantId: target.tenantId }, async () =>
      (
        await AccountingConnectionCollection.create({ db: target.db })
      ).findForTenant({ tenantId: target.tenantId, provider: 'quickbooks' }),
    );
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'DB_SCHEMA_MISSING')
      return null;
    throw error;
  }
}

/**
 * Refuse a production accounting write unless live mode is enabled for the
 * tenant's connected company. Call before reserving state or calling the
 * provider. Resolves for sandbox targets.
 *
 * The target environment is every one of: the caller's mapping scope, the
 * provider's own `environment`, and the environment the document was already
 * synced under. They must agree, so a sandbox-labelled mapping cannot reach a
 * production provider; any production among them requires the gate.
 */
export async function assertAccountingWriteAllowed(
  target: AccountingWriteTarget,
): Promise<void> {
  const environments = new Set<string>();
  let realmId = target.scope?.realmId;
  if (target.scope) environments.add(target.scope.environment);
  const fromProvider = providerEnvironment(target.provider);
  if (fromProvider) environments.add(fromProvider);
  if (target.invoiceId) {
    const invoice = await withTenant({ tenantId: target.tenantId }, async () =>
      (await InvoiceCollection.create({ db: target.db })).get(
        { id: target.invoiceId },
        { cache: false },
      ),
    );
    if (invoice?.accountingSyncStateJson) {
      try {
        const state = JSON.parse(invoice.accountingSyncStateJson) as {
          identity?: { environment?: string; realmId?: string };
        };
        if (state.identity?.environment)
          environments.add(state.identity.environment);
        realmId = realmId ?? state.identity?.realmId;
      } catch {
        // Malformed state is the sync function's refusal to make, not ours.
      }
    }
  }
  if (environments.size > 1)
    throw new AccountingLiveGateError(
      'ACCOUNTING_ENVIRONMENT_MISMATCH',
      'The provider, mapping and synced document name different accounting environments',
    );
  const connection = await findConnection(target);
  if (!environments.has('production')) {
    // A sandbox label must not reach a company the tenant connected as
    // production: the label is the caller's claim, the connection is the record.
    if (
      target.scope &&
      connection &&
      connection.status !== 'disconnected' &&
      connection.realmId === target.scope.realmId &&
      connection.environment !== target.scope.environment
    )
      throw new AccountingLiveGateError(
        'ACCOUNTING_ENVIRONMENT_MISMATCH',
        'The mapping names a different environment than the tenant connection for this company',
      );
    return;
  }
  if (
    !connection ||
    !connection.isLiveEnabled() ||
    (realmId !== undefined && connection.realmId !== realmId)
  )
    throw new AccountingLiveGateError(
      'LIVE_ACCOUNTING_NOT_ENABLED',
      'Production accounting writes are not enabled for this tenant and company',
    );
}
