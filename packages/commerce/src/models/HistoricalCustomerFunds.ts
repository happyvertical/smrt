import {
  field,
  foreignKey,
  SmrtObject,
  type SmrtObjectOptions,
  type SmrtSaveOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { assertHistoricalCommerceWrite } from '../historical-commerce-internal.js';
export interface HistoricalCustomerFundsOptions extends SmrtObjectOptions {
  tenantId?: string;
  customerId?: string;
  contractId?: string | null;
  sourceKeyHash?: string;
  kind?: 'receipt' | 'refund';
  origin?: 'historical' | 'live';
  paymentId?: string | null;
  currency?: string;
  amountMinor?: number;
  effectiveOn?: string;
  sourceReceiptId?: string | null;
  sourceCreditNoteId?: string | null;
  snapshotJson?: string;
}
/** Retained original cash evidence. It is deliberately not a completed ledger-backed Payment. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'historical_customer_funds',
  indexes: [
    {
      name: 'historical_customer_funds_source',
      columns: ['tenantId', 'sourceKeyHash'],
      unique: true,
    },
  ],
  api: { include: ['get', 'list'] },
  cli: { include: ['get', 'list'] },
  mcp: { include: ['get', 'list'] },
})
export class HistoricalCustomerFunds extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Customer') customerId = '';
  @foreignKey('Contract', { nullable: true }) contractId: string | null = null;
  sourceKeyHash = '';
  kind: 'receipt' | 'refund' = 'receipt';
  origin: 'historical' | 'live' = 'historical';
  @foreignKey('Payment', { nullable: true }) paymentId: string | null = null;
  currency = '';
  @field({ ui: { format: 'money' } }) amountMinor = 0;
  effectiveOn = '';
  @foreignKey('HistoricalCustomerFunds', { nullable: true }) sourceReceiptId:
    | string
    | null = null;
  @foreignKey('Invoice', { nullable: true }) sourceCreditNoteId: string | null =
    null;
  snapshotJson = '';
  constructor(options: HistoricalCustomerFundsOptions = {}) {
    super(options);
    for (const key of [
      'tenantId',
      'customerId',
      'contractId',
      'sourceKeyHash',
      'kind',
      'origin',
      'paymentId',
      'currency',
      'amountMinor',
      'effectiveOn',
      'sourceReceiptId',
      'sourceCreditNoteId',
      'snapshotJson',
    ] as const)
      if (options[key] !== undefined)
        Object.assign(this, { [key]: options[key] });
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    assertHistoricalCommerceWrite(this);
    if (
      !this.tenantId ||
      !this.customerId ||
      !this.sourceKeyHash ||
      !this.snapshotJson ||
      !Number.isSafeInteger(this.amountMinor) ||
      this.amountMinor <= 0
    )
      throw new Error(
        'Historical customer funds require complete exact source evidence',
      );
    if (this.id && (await this.db.get(this.tableName, { id: this.id })))
      throw new Error('Historical customer funds are immutable');
    return super.save(options);
  }
  override async delete(): Promise<void> {
    throw new Error('Historical customer cash evidence cannot be deleted');
  }
}
