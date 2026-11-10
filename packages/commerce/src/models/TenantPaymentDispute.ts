/** Durable connected dispute projection; written only by signed reconciliation. */
import type { PaymentDisputeStatus } from '@happyvertical/payments';
import {
  field,
  foreignKey,
  SmrtCollection,
  type SmrtDeleteOptions,
  SmrtObject,
  type SmrtSaveOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { hasConnectedPaymentAuthority } from '../connected-payments-internal.js';
import type { TenantPaymentEnvironment } from './TenantPaymentAccount.js';

/** One authoritative dispute snapshot and its immutable balance evidence. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'tenant_payment_disputes',
  api: false,
  cli: false,
  mcp: false,
})
export class TenantPaymentDispute extends SmrtObject {
  /** Owning settlement tenant. */
  @tenantId() tenantId: string = '';
  /** Provider adapter identifier. */
  backendId: string = '';
  /** Provider environment. */
  environment: TenantPaymentEnvironment = 'test';
  /** Provider connected account. */
  providerAccountId: string = '';
  /** Provider dispute identity. */
  disputeId: string = '';
  /** Original immutable settlement. */
  @foreignKey('Payment')
  paymentId: string = '';
  /** Last authoritative provider lifecycle. */
  status: PaymentDisputeStatus = 'unknown';
  /** Validated snapshot, including balance transaction posting identity. */
  @field({ type: 'text' }) snapshotJson: string = '';
  /** Financial projection writes require the owning command. */
  override async save(options?: SmrtSaveOptions): Promise<this> {
    if (!hasConnectedPaymentAuthority(this.tenantId))
      throw new Error(
        'Disputes are written only by connected-payments commands',
      );
    return super.save(options);
  }
  /** Financial evidence is retained permanently. */
  override async delete(_options?: SmrtDeleteOptions): Promise<void> {
    throw new Error('Connected dispute evidence cannot be deleted');
  }
}
/** @internal Command-owned projection collection. */
export class TenantPaymentDisputeCollection extends SmrtCollection<TenantPaymentDispute> {
  static readonly _itemClass = TenantPaymentDispute;
}
