/** Pure report contracts for the commerce line-amount migration. */

export type CommerceLineAmountReasonCode =
  | 'DRAFT_RECOMPUTED'
  | 'ISSUED_BACKFILLED'
  | 'UNRECONCILED'
  | 'TAX_RATE_OVER_ONE'
  | 'HAND_ENTERED_AMOUNT'
  | 'NEGATIVE_HALF_UNIT_GROSS'
  | 'MISSING_HEADER_TOTALS'
  | 'STALE_EDITOR_BLOB';

export interface CommerceMoneyTotals {
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
}
export interface CommerceLineAmountDocumentReport {
  tenantId: string;
  documentType: 'invoice' | 'contract';
  documentId: string;
  status: string;
  arJournalIdSet: boolean;
  old: CommerceMoneyTotals;
  next: CommerceMoneyTotals;
  delta: CommerceMoneyTotals;
  reasons: CommerceLineAmountReasonCode[];
}

export interface CommerceLineAmountTenantSummary {
  tenantId: string;
  documentCount: number;
  changingDraftCount: number;
  issuedUnpostedFallbackTaxCount: number;
  reasonCounts: Partial<Record<CommerceLineAmountReasonCode, number>>;
}

export interface CommerceLineAmountsReport {
  version: 1;
  documents: CommerceLineAmountDocumentReport[];
  tenants: CommerceLineAmountTenantSummary[];
}

/** Explicit report destinations. Omit `out` to receive only structured data. */
export interface CommerceLineAmountsReportOutput {
  jsonPath: string;
  csvPath: string;
}

export interface PreflightCommerceLineAmountsOptions {
  /**
   * Optional artifact paths. Omitting this never writes files; the preflight
   * still returns the complete structured CommerceLineAmountsReport.
   */
  out?: CommerceLineAmountsReportOutput;
}

const REASON_ORDER: readonly CommerceLineAmountReasonCode[] = [
  'DRAFT_RECOMPUTED',
  'ISSUED_BACKFILLED',
  'UNRECONCILED',
  'TAX_RATE_OVER_ONE',
  'HAND_ENTERED_AMOUNT',
  'NEGATIVE_HALF_UNIT_GROSS',
  'MISSING_HEADER_TOTALS',
  'STALE_EDITOR_BLOB',
];

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertSafeTotals(totals: CommerceMoneyTotals, label: string): void {
  for (const [field, value] of Object.entries(totals)) {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`${label}.${field} must be safe integer minor units`);
    }
  }
}

function canonicalReport(
  report: CommerceLineAmountsReport,
): CommerceLineAmountsReport {
  if (report.version !== 1) throw new TypeError('Unsupported report version');
  const documentKeys = new Set<string>();
  const documents = report.documents.map((document) => {
    if (!document.tenantId || !document.documentId || !document.status) {
      throw new TypeError(
        'Report documents require tenant, document and status',
      );
    }
    assertSafeTotals(document.old, 'old');
    assertSafeTotals(document.next, 'next');
    assertSafeTotals(document.delta, 'delta');
    for (const field of ['subtotalMinor', 'taxMinor', 'totalMinor'] as const) {
      if (
        document.delta[field] !==
        document.next[field] - document.old[field]
      ) {
        throw new TypeError(`Report delta.${field} does not match next - old`);
      }
    }
    const key = `${document.tenantId}\u0000${document.documentType}\u0000${document.documentId}`;
    if (documentKeys.has(key))
      throw new TypeError(`Duplicate report document: ${key}`);
    documentKeys.add(key);
    const reasons = [...new Set(document.reasons)].sort(
      (left, right) => REASON_ORDER.indexOf(left) - REASON_ORDER.indexOf(right),
    );
    if (reasons.some((reason) => !REASON_ORDER.includes(reason))) {
      throw new TypeError('Unknown commerce line-amount reason code');
    }
    return { ...document, reasons };
  });
  documents.sort(
    (left, right) =>
      compareCodeUnits(left.tenantId, right.tenantId) ||
      compareCodeUnits(left.documentType, right.documentType) ||
      compareCodeUnits(left.documentId, right.documentId),
  );
  const tenantIds = new Set<string>();
  const tenants = report.tenants.map((tenant) => {
    if (!tenant.tenantId || tenantIds.has(tenant.tenantId)) {
      throw new TypeError(
        `Invalid or duplicate report tenant: ${tenant.tenantId}`,
      );
    }
    tenantIds.add(tenant.tenantId);
    for (const [field, value] of [
      ['documentCount', tenant.documentCount],
      ['changingDraftCount', tenant.changingDraftCount],
      ['issuedUnpostedFallbackTaxCount', tenant.issuedUnpostedFallbackTaxCount],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${field} must be a nonnegative safe integer`);
      }
    }
    const suppliedReasons = Object.keys(tenant.reasonCounts);
    if (
      suppliedReasons.some(
        (reason) =>
          !REASON_ORDER.includes(reason as CommerceLineAmountReasonCode),
      )
    ) {
      throw new TypeError('Unknown tenant-summary reason code');
    }
    const reasonCounts = Object.fromEntries(
      REASON_ORDER.filter(
        (reason) => tenant.reasonCounts[reason] !== undefined,
      ).map((reason) => {
        const count = tenant.reasonCounts[reason];
        if (!Number.isSafeInteger(count) || Number(count) < 0) {
          throw new TypeError(`Invalid reason count for ${reason}`);
        }
        return [reason, count];
      }),
    );
    return { ...tenant, reasonCounts };
  });
  tenants.sort((left, right) =>
    compareCodeUnits(left.tenantId, right.tenantId),
  );
  return { version: 1, documents, tenants };
}
/** Stable JSON bytes for review artifacts and retry comparisons. */
export function serializeCommerceLineAmountsReportJson(
  report: CommerceLineAmountsReport,
): string {
  return `${JSON.stringify(canonicalReport(report), null, 2)}\n`;
}

function csvCell(value: string | number | boolean): string {
  const rendered = String(value);
  return /[",\r\n]/.test(rendered)
    ? `"${rendered.replaceAll('"', '""')}"`
    : rendered;
}

/** Stable one-row-per-document CSV bytes. Tenant summaries remain in JSON. */
export function serializeCommerceLineAmountsReportCsv(
  report: CommerceLineAmountsReport,
): string {
  const canonical = canonicalReport(report);
  const header = [
    'tenantId',
    'documentType',
    'documentId',
    'status',
    'arJournalIdSet',
    'oldSubtotalMinor',
    'oldTaxMinor',
    'oldTotalMinor',
    'nextSubtotalMinor',
    'nextTaxMinor',
    'nextTotalMinor',
    'deltaSubtotalMinor',
    'deltaTaxMinor',
    'deltaTotalMinor',
    'reasons',
  ];
  const rows = canonical.documents.map((document) => [
    document.tenantId,
    document.documentType,
    document.documentId,
    document.status,
    document.arJournalIdSet,
    document.old.subtotalMinor,
    document.old.taxMinor,
    document.old.totalMinor,
    document.next.subtotalMinor,
    document.next.taxMinor,
    document.next.totalMinor,
    document.delta.subtotalMinor,
    document.delta.taxMinor,
    document.delta.totalMinor,
    document.reasons.join('|'),
  ]);
  return `${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}
