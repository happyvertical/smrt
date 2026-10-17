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
import type { HistoricalSalesLineInput } from '../historical-sales-types.js';
export interface HistoricalSalesLineOptions
  extends SmrtObjectOptions,
    Partial<HistoricalSalesLineInput> {
  tenantId?: string;
  invoiceId?: string;
  sourceKeyHash?: string;
  sourceFieldsJson?: string;
  moneySnapshotId?: string;
}
/** An immutable source line with explicit unknowns, never a calculated InvoiceLineItem. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'historical_sales_lines',
  indexes: [
    {
      name: 'historical_sales_line_source_key',
      columns: ['tenantId', 'invoiceId', 'sourceKeyHash'],
      unique: true,
    },
  ],
  api: { include: ['get', 'list'] },
  cli: { include: ['get', 'list'] },
  mcp: { include: ['get', 'list'] },
})
export class HistoricalSalesLine extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Invoice') invoiceId = '';
  @foreignKey('HistoricalSalesLine', { nullable: true }) creditedLineId:
    | string
    | null = null;
  sourceKey = '';
  sourceKeyHash = '';
  description = '';
  @field({ ui: { format: 'money' } }) netMinor = 0;
  @field({ type: 'integer', nullable: true, ui: { format: 'money' } }) taxMinor:
    | number
    | null = null;
  @field({ type: 'integer', nullable: true, ui: { format: 'money' } })
  grossMinor: number | null = null;
  @field({ type: 'text', nullable: true }) quantityText: string | null = null;
  @field({ type: 'text', nullable: true }) unitRateText: string | null = null;
  sourceFieldsJson = '{}';
  moneySnapshotId = '';
  constructor(options: HistoricalSalesLineOptions = {}) {
    super(options);
    for (const key of [
      'tenantId',
      'invoiceId',
      'creditedLineId',
      'sourceKey',
      'sourceKeyHash',
      'description',
      'netMinor',
      'taxMinor',
      'grossMinor',
      'quantityText',
      'unitRateText',
      'sourceFieldsJson',
      'moneySnapshotId',
    ] as const)
      if (options[key] !== undefined)
        Object.assign(this, { [key]: options[key] });
    if (options.sourceFields !== undefined)
      this.sourceFieldsJson = JSON.stringify(options.sourceFields);
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    assertHistoricalCommerceWrite(this);
    if (
      !this.tenantId ||
      !this.invoiceId ||
      !this.sourceKey ||
      !this.sourceKeyHash ||
      !this.moneySnapshotId
    )
      throw new Error('Historical source line identity is incomplete');
    if (this.id && (await this.db.get(this.tableName, { id: this.id })))
      throw new Error('Historical sales source lines are immutable');
    return super.save(options);
  }
  override async delete(): Promise<void> {
    throw new Error('Historical sales source lines cannot be deleted');
  }
}
