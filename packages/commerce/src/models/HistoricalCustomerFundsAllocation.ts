import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtObject,
  type SmrtObjectOptions,
  type SmrtSaveOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { assertHistoricalCommerceWrite } from '../historical-commerce-internal.js';
export interface HistoricalCustomerFundsAllocationOptions
  extends SmrtObjectOptions {
  tenantId?: string;
  receiptId?: string | null;
  creditNoteId?: string | null;
  invoiceId?: string;
  sourceKeyHash?: string;
  amountMinor?: number;
  effectiveOn?: string;
  origin?: 'historical' | 'live';
  effect?: 'payment' | 'credit-audit' | 'refund-audit';
  journalId?: string | null;
  snapshotJson?: string;
}
/** Original applications have concrete identities; credit-audit records never count twice. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'historical_customer_funds_allocations',
  indexes: [
    {
      name: 'historical_funds_allocation_source',
      columns: ['tenantId', 'sourceKeyHash'],
      unique: true,
    },
  ],
  api: { include: ['get', 'list'] },
  cli: { include: ['get', 'list'] },
  mcp: { include: ['get', 'list'] },
})
export class HistoricalCustomerFundsAllocation extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('HistoricalCustomerFunds', { nullable: true }) receiptId:
    | string
    | null = null;
  @foreignKey('Invoice', { nullable: true }) creditNoteId: string | null = null;
  @foreignKey('Invoice') invoiceId = '';
  sourceKeyHash = '';
  @field({ ui: { format: 'money' } }) amountMinor = 0;
  effectiveOn = '';
  origin: 'historical' | 'live' = 'historical';
  effect: 'payment' | 'credit-audit' | 'refund-audit' = 'payment';
  @crossPackageRef('@happyvertical/smrt-ledgers:Journal', { nullable: true })
  journalId: string | null = null;
  snapshotJson = '';
  constructor(options: HistoricalCustomerFundsAllocationOptions = {}) {
    super(options);
    for (const key of [
      'tenantId',
      'receiptId',
      'creditNoteId',
      'invoiceId',
      'sourceKeyHash',
      'amountMinor',
      'effectiveOn',
      'origin',
      'effect',
      'journalId',
      'snapshotJson',
    ] as const)
      if (options[key] !== undefined)
        Object.assign(this, { [key]: options[key] });
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    assertHistoricalCommerceWrite(this);
    if (
      !this.tenantId ||
      !this.invoiceId ||
      !this.sourceKeyHash ||
      !this.snapshotJson ||
      !Number.isSafeInteger(this.amountMinor) ||
      this.amountMinor <= 0 ||
      Boolean(this.receiptId) === Boolean(this.creditNoteId)
    )
      throw new Error(
        'Historical funds allocation requires one exact source and an owned invoice',
      );
    if (this.id && (await this.db.get(this.tableName, { id: this.id })))
      throw new Error('Historical customer funds applications are immutable');
    return super.save(options);
  }
  override async delete(): Promise<void> {
    throw new Error('Historical customer funds applications cannot be deleted');
  }
}
