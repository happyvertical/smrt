/** Materialized tax-summary rows compiled from immutable commerce snapshots. */

import { field, smrt } from '@happyvertical/smrt-core';
import { groupBy, report, SmrtReport } from '@happyvertical/smrt-reports';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { DocumentTax } from './DocumentTax.js';

export type TaxSummaryReportRowKind =
  | 'component'
  | 'kind'
  | 'reconciliation'
  | 'warning';

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'tax_summary_reports',
  conflictColumns: [
    'tenant_id',
    'period_from',
    'period_to',
    'currency',
    'row_kind',
    'dimension_key',
  ],
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
})
@report({ source: DocumentTax, refresh: { manual: true, mode: 'rebuild' } })
export class TaxSummaryReport extends SmrtReport {
  @tenantId()
  tenantId = '';

  /** Inclusive report window, stored as an RFC3339 instant. */
  @field({
    type: 'datetime',
    description: 'The inclusive start of this report period.',
  })
  @groupBy('issueDate')
  periodFrom: Date = new Date(0);

  /** Inclusive report window, stored as an RFC3339 instant. */
  @field({
    type: 'datetime',
    description: 'The inclusive end of this report period.',
  })
  @groupBy('issueDate')
  periodTo: Date = new Date(0);

  @field({
    description: 'The currency group; report rows never mix currencies.',
  })
  @groupBy('currency')
  currency = '';

  @field({ description: 'The materialized tax-summary row category.' })
  @groupBy('kind')
  rowKind: TaxSummaryReportRowKind = 'component';

  /** Stable key for replacement and a source drilldown dimension. */
  @field({
    description: 'The stable dimension identity inside this report row.',
  })
  @groupBy('taxCodeId')
  dimensionKey = '';

  @field({
    description: 'Sales, purchase, expense or reconciliation direction.',
  })
  @groupBy('documentType')
  direction = '';

  @field({
    nullable: true,
    description: 'Tenant tax component snapshot identity.',
  })
  @groupBy('taxComponentId')
  taxComponentId: string | null = null;

  @field({ nullable: true, description: 'Stored tax-code kind snapshot.' })
  @groupBy('kind')
  taxCodeKind: string | null = null;

  @field({
    nullable: true,
    description: 'Liability account used for reconciliation.',
  })
  @groupBy('liabilityAccountId')
  liabilityAccountId: string | null = null;

  @field({ description: 'Stored taxable base in integer minor units.' })
  @groupBy('taxableMinor')
  taxableMinor = 0;

  @field({
    description:
      'Collected tax or reconciliation tax amount in integer minor units.',
  })
  @groupBy('taxMinor')
  taxMinor = 0;

  @field({
    description: 'Recoverable tax in integer minor units when complete.',
  })
  @groupBy('recoverableMinor')
  recoverableMinor = 0;

  @field({
    nullable: true,
    description: 'Posted ledger movement in raw commerce minor units.',
  })
  @groupBy('ledgerMovementMinor')
  ledgerMovementMinor: number | null = null;

  @field({
    nullable: true,
    description: 'Collected less recoverable tax in integer minor units.',
  })
  @groupBy('taxMinor')
  netTaxMinor: number | null = null;

  @field({
    nullable: true,
    description: 'Ledger movement minus collected tax.',
  })
  @groupBy('differenceMinor')
  differenceMinor: number | null = null;

  @field({ description: 'Distinct stored document count.' })
  @groupBy('documentCount')
  documentCount = 0;

  @field({
    description: 'Whether this row belongs to a complete tax-summary result.',
  })
  @groupBy('complete')
  complete = true;

  @field({ nullable: true, description: 'Incomplete-source warning code.' })
  @groupBy('taxCodeCode')
  warningCode: string | null = null;

  @field({
    nullable: true,
    description: 'Operator-facing incomplete-source warning.',
  })
  @groupBy('taxComponentName')
  warningMessage: string | null = null;
}
