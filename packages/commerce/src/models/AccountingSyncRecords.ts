/**
 * AccountingPaymentSync and AccountingInvoiceReadback (#5139): the durable
 * coordination state for pushing a recorded payment to the accounting provider
 * exactly once, and the stored readback of a synced invoice.
 *
 * Both are command-owned (`accounting-payment-sync.ts`): `save()` refuses any
 * other writer, and neither is deleted. See `agents/accounting-payment-sync.md`.
 *
 * @packageDocumentation
 */

import {
  field,
  type SmrtDeleteOptions,
  SmrtObject,
  type SmrtSaveOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type {
  AccountingConnectionEnvironment,
  AccountingConnectionProvider,
} from './AccountingConnection.js';

/**
 * Payment push state. `in_flight` and `unknown` block a retry until the owner
 * is reconciled; `rejected` (provider refused, or nothing was sent) may retry;
 * `synced` is final.
 */
export type AccountingPaymentSyncStatus =
  | 'in_flight'
  | 'unknown'
  | 'rejected'
  | 'synced';

/**
 * Readback status of a synced invoice.
 *
 * - `in_step`: the provider's paid and credited amounts equal Commerce's.
 * - `drift`: the provider disagrees (for example a payment recorded only in the
 *   provider, or a local payment the provider lacks).
 * - `needs_reconciliation`: the provider evidence is incomplete or
 *   inconsistent, so no conclusion is drawn.
 */
export type AccountingReadbackStatus =
  | 'in_step'
  | 'drift'
  | 'needs_reconciliation';

const writing = new WeakSet<object>();

/** @internal Run a write owned by the accounting payment-sync commands. */
export async function writeAccountingSyncRecord<T>(
  record: AccountingPaymentSync | AccountingInvoiceReadback,
  write: () => Promise<T>,
): Promise<T> {
  writing.add(record);
  try {
    return await write();
  } finally {
    writing.delete(record);
  }
}

/** One recorded payment's push to the accounting provider. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'accounting_payment_syncs',
  indexes: [
    {
      name: 'accounting_payment_syncs_scope_payment',
      columns: ['tenantId', 'provider', 'realmId', 'environment', 'paymentId'],
      unique: true,
    },
  ],
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'], skipApiCheck: true },
})
export class AccountingPaymentSync extends SmrtObject {
  /** Tenant that owns the payment. */
  @tenantId()
  tenantId: string = '';

  /** Accounting provider. */
  provider: AccountingConnectionProvider = 'quickbooks';

  /** Provider company the payment was pushed to. */
  realmId: string = '';

  /** Provider mode. */
  environment: AccountingConnectionEnvironment = 'sandbox';

  /** Local `Payment` id. */
  paymentId: string = '';

  /** Push state; see {@link AccountingPaymentSyncStatus}. */
  status: AccountingPaymentSyncStatus = 'in_flight';

  /** Provider request id, persisted before the push. */
  requestId: string = '';

  /** Owner of the current attempt; a reconcile must name it. */
  attemptId: string = '';

  /** Hash of the exact request facts. */
  payloadHash: string = '';

  /** The persisted request (JSON) a reconciler looks up at the provider. */
  @field({ type: 'text' })
  requestJson: string = '';

  /** Provider payment id once synced. */
  externalId: string = '';

  /** Provider timestamp once synced. */
  @field({ type: 'datetime', nullable: true })
  syncedAt: Date | null = null;

  /** When the current attempt started. */
  @field({ type: 'datetime', nullable: true })
  startedAt: Date | null = null;

  /** Short error code of the last failure (never provider text). */
  lastError: string = '';

  /**
   * Request id of a push that was `unknown` and then released as absent at the
   * provider. Never cleared: every later attempt must reuse it, because the
   * provider dedups on it and the original may still land late.
   */
  pinnedRequestId: string = '';

  /** Refuses writes outside the commands and any change of key. */
  override async save(options?: SmrtSaveOptions): Promise<this> {
    if (!writing.has(this))
      throw new Error(
        'AccountingPaymentSync is written only by the accounting payment-sync commands',
      );
    if (!this.tenantId || !this.realmId || !this.paymentId)
      throw new Error(
        'AccountingPaymentSync requires tenant, realm and payment',
      );
    if (this.id) {
      const prior = await this.getCanonicalPersistedRow({ id: this.id });
      if (prior) {
        const key: Array<[string, unknown, unknown]> = [
          ['tenantId', prior.tenant_id, this.tenantId],
          ['realmId', prior.realm_id, this.realmId],
          ['environment', prior.environment, this.environment],
          ['paymentId', prior.payment_id, this.paymentId],
        ];
        for (const [name, before, after] of key)
          if (String(before ?? '') !== String(after))
            throw new Error(`AccountingPaymentSync ${name} cannot change`);
      }
    }
    return super.save(options);
  }

  /** Never deleted: it is the exactly-once record. */
  override async delete(_options?: SmrtDeleteOptions): Promise<void> {
    throw new Error('AccountingPaymentSync cannot be deleted');
  }
}

/** The stored provider readback of one synced invoice. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'accounting_invoice_readbacks',
  indexes: [
    {
      name: 'accounting_invoice_readbacks_tenant_invoice',
      columns: ['tenantId', 'invoiceId'],
      unique: true,
    },
  ],
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'], skipApiCheck: true },
})
export class AccountingInvoiceReadback extends SmrtObject {
  /** Tenant that owns the invoice. */
  @tenantId()
  tenantId: string = '';

  /** Local `Invoice` id. */
  invoiceId: string = '';

  /** Provider company read. */
  realmId: string = '';

  /** Provider mode read. */
  environment: AccountingConnectionEnvironment = 'sandbox';

  /** Provider invoice id read. */
  externalId: string = '';

  /** Outcome; see {@link AccountingReadbackStatus}. */
  status: AccountingReadbackStatus = 'needs_reconciliation';

  /** The projection (balance, paid, credited, refunded, state, transactions), JSON. */
  @field({ type: 'text' })
  projectionJson: string = '';

  /** What Commerce expects paid on the invoice, in minor units. */
  localPaidMinor: number = 0;

  /** Provider payment ids with no local counterpart (payments recorded only there), JSON. */
  @field({ type: 'text' })
  providerOnlyJson: string = '';

  /** When the provider was read. */
  @field({ type: 'datetime', nullable: true })
  observedAt: Date | null = null;

  /** Short code explaining `drift` or `needs_reconciliation`. */
  lastError: string = '';

  /** Refuses writes outside the commands. */
  override async save(options?: SmrtSaveOptions): Promise<this> {
    if (!writing.has(this))
      throw new Error(
        'AccountingInvoiceReadback is written only by the accounting payment-sync commands',
      );
    if (!this.tenantId || !this.invoiceId)
      throw new Error('AccountingInvoiceReadback requires tenant and invoice');
    return super.save(options);
  }

  /** Never deleted. */
  override async delete(_options?: SmrtDeleteOptions): Promise<void> {
    throw new Error('AccountingInvoiceReadback cannot be deleted');
  }
}
