/** Commerce line-amount preflight, migration and rollback. */

import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { ContractCollection } from '../collections/ContractCollection.js';
import {
  DocumentTaxCollection,
  type DocumentTaxWriteInput,
} from '../collections/DocumentTaxCollection.js';
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from '../collections/InvoiceLineItemCollection.js';
import { MoneyMigrationDocumentCollection } from '../collections/MoneyMigrationDocumentCollection.js';
import { TaxSettingsCollection } from '../collections/TaxSettingsCollection.js';
import { materializeContractMoneySnapshot } from '../contract-money.js';
import { materializeInvoiceMoneyDraft } from '../document-money.js';
import { DOCUMENT_MONEY_WRITE } from '../document-money-internal.js';
import type { MoneyMigrationDocument } from '../models/MoneyMigrationDocument.js';
import { MoneyValidationError } from '../money.js';
import { type LegacyTaxMapReport, mapLegacyTaxRates } from '../tax/legacy.js';
import { withTenantMoneyMigration } from '../tenant-money-barrier.js';

export type CommerceLineAmountReasonCode =
  | 'DRAFT_RECOMPUTED'
  | 'ISSUED_BACKFILLED'
  | 'UNRECONCILED'
  | 'TAX_RATE_OVER_ONE'
  | 'HAND_ENTERED_AMOUNT'
  | 'NEGATIVE_HALF_UNIT_GROSS'
  | 'MISSING_HEADER_TOTALS'
  | 'STALE_EDITOR_BLOB'
  | 'ORPHAN_LINE'
  | 'CROSS_TENANT_LINE'
  | 'MISSING_LINE_TENANT'
  | 'CONTRACT_DIRECTION_UNKNOWN'
  | 'ACCOUNTING_SYNC_UNSETTLED';

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
  /** Optional tenant restriction. Omit only from a system migration context. */
  tenantId?: string;
}

export interface MigrateCommerceLineAmountsOptions {
  tenantId: string;
  acceptDraftChanges?: boolean;
  /**
   * Stable owner identity chosen before the attempt starts. Supplying it on
   * the first call makes failures after the tenant claim safely resumable;
   * a retry must present the same identity.
   */
  migrationId?: string;
}

export interface CommerceLineAmountsMigrationResult {
  tenantId: string;
  migrationId: string;
  migrated: number;
  resumed: number;
  activated: boolean;
  report: CommerceLineAmountsReport;
}

export interface RollbackCommerceLineAmountsOptions {
  tenantId: string;
  migrationId: string;
}

export interface CommerceLineAmountsRollbackResult {
  tenantId: string;
  migrationId: string;
  restored: number;
  alreadyRestored: number;
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
  'ORPHAN_LINE',
  'CROSS_TENANT_LINE',
  'MISSING_LINE_TENANT',
  'CONTRACT_DIRECTION_UNKNOWN',
  'ACCOUNTING_SYNC_UNSETTLED',
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

type StoredRow = Record<string, unknown>;
type MigrationImage = {
  version: 1;
  header: StoredRow;
  lines: StoredRow[];
  taxes: StoredRow[];
};

const BLOCKING_REASONS = new Set<CommerceLineAmountReasonCode>([
  'UNRECONCILED',
  'ORPHAN_LINE',
  'CROSS_TENANT_LINE',
  'MISSING_LINE_TENANT',
  'CONTRACT_DIRECTION_UNKNOWN',
  'ACCOUNTING_SYNC_UNSETTLED',
]);

function storedNumber(value: unknown, label: string): number {
  const result =
    typeof value === 'bigint'
      ? Number(value)
      : typeof value === 'number'
        ? value
        : typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value)
          ? Number(value)
          : Number.NaN;
  if (!Number.isFinite(result)) throw new Error(`${label} is not numeric`);
  return result;
}

function storedMinor(value: unknown, label: string): number {
  const result = storedNumber(value, label);
  if (!Number.isSafeInteger(result))
    throw new MoneyValidationError(
      'UNSAFE_MONEY',
      `${label} must be safe integer minor units`,
    );
  return result;
}

function roundHalfAwayFromZero(value: number): number {
  if (!Number.isFinite(value))
    throw new MoneyValidationError(
      'UNSAFE_MONEY',
      'Legacy gross is not finite',
    );
  const rounded = Math.sign(value) * Math.floor(Math.abs(value) + 0.5);
  if (!Number.isSafeInteger(rounded))
    throw new MoneyValidationError(
      'UNSAFE_MONEY',
      'Legacy gross exceeds safe integer minor units',
    );
  return rounded;
}

function lineNet(row: StoredRow): number {
  return (
    roundHalfAwayFromZero(
      storedNumber(row.quantity, 'line quantity') *
        storedMinor(row.unit_price, 'line unit price'),
    ) - storedMinor(row.discount ?? 0, 'line discount')
  );
}

function normalizeJson(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([key, item]) => [key, normalizeJson(item)]),
    );
  return value;
}

function imageJson(image: MigrationImage): string {
  return JSON.stringify(normalizeJson(image));
}

function checksum(json: string): string {
  return createHash('sha256').update(json).digest('hex');
}

function rows(
  result: Awaited<ReturnType<DatabaseInterface['query']>>,
): StoredRow[] {
  return result.rows as StoredRow[];
}

async function tableExists(
  db: DatabaseInterface,
  table: string,
): Promise<boolean> {
  return !db.tableExists || db.tableExists(table);
}

async function captureDocument(
  db: DatabaseInterface,
  tenantId: string,
  documentType: 'invoice' | 'contract',
  documentId: string,
): Promise<MigrationImage> {
  const headerTable = documentType === 'invoice' ? 'invoices' : 'contracts';
  const lineTable =
    documentType === 'invoice' ? 'invoice_line_items' : 'contract_line_items';
  const parentColumn =
    documentType === 'invoice' ? 'invoice_id' : 'contract_id';
  const header = rows(
    await db.query(
      `SELECT * FROM ${headerTable} WHERE CAST(id AS TEXT) = ? AND CAST(tenant_id AS TEXT) = ?`,
      documentId,
      tenantId,
    ),
  )[0];
  if (!header)
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      `${documentType} ${documentId} was not found in tenant ${tenantId}`,
    );
  const lines = rows(
    await db.query(
      `SELECT * FROM ${lineTable} WHERE CAST(${parentColumn} AS TEXT) = ? ORDER BY id ASC`,
      documentId,
    ),
  );
  const taxes = (await tableExists(db, 'document_taxes'))
    ? rows(
        await db.query(
          `SELECT * FROM document_taxes
            WHERE CAST(tenant_id AS TEXT) = ?
              AND document_type = ?
              AND CAST(document_id AS TEXT) = ?
            ORDER BY tax_code_id ASC, tax_component_id ASC, id ASC`,
          tenantId,
          documentType,
          documentId,
        ),
      )
    : [];
  return { version: 1, header, lines, taxes };
}

function documentReport(
  tenantId: string,
  documentType: 'invoice' | 'contract',
  header: StoredRow,
  lines: StoredRow[],
): CommerceLineAmountDocumentReport {
  const old: CommerceMoneyTotals = {
    subtotalMinor: storedMinor(header.subtotal ?? 0, 'header subtotal'),
    taxMinor: storedMinor(header.tax_amount ?? 0, 'header tax'),
    totalMinor: storedMinor(header.total_amount ?? 0, 'header total'),
  };
  const status = String(header.status ?? 'unknown');
  const frozen = status !== 'draft' || Boolean(header.ar_journal_id);
  const providerTax = storedMinor(
    header.provider_tax_amount ?? 0,
    'provider tax',
  );
  let subtotal = 0;
  let lineTax = 0;
  const reasons: CommerceLineAmountReasonCode[] = [];
  for (const line of lines) {
    const net = lineNet(line);
    const prior = storedMinor(line.amount ?? 0, 'legacy line amount');
    const tax = prior - net;
    subtotal += net;
    lineTax += tax;
    const rate = storedNumber(line.tax_rate ?? 0, 'legacy tax rate');
    if (rate > 1) reasons.push('TAX_RATE_OVER_ONE');
    const exactGross =
      storedNumber(line.quantity, 'line quantity') *
      storedMinor(line.unit_price, 'line unit price');
    if (exactGross < 0 && Math.abs(exactGross % 1) === 0.5)
      reasons.push('NEGATIVE_HALF_UNIT_GROSS');
    if (
      documentType === 'contract' &&
      prior !== net &&
      prior !== net + roundHalfAwayFromZero(net * rate)
    )
      reasons.push('HAND_ENTERED_AMOUNT');
    if (String(line.invoice_editor_state_json ?? '').trim())
      reasons.push('STALE_EDITOR_BLOB');
  }
  const next: CommerceMoneyTotals = frozen
    ? {
        subtotalMinor: old.subtotalMinor,
        taxMinor: lineTax + providerTax,
        totalMinor: old.totalMinor,
      }
    : {
        subtotalMinor: subtotal,
        taxMinor: lineTax + providerTax,
        totalMinor: subtotal + lineTax + providerTax,
      };
  if (frozen) {
    reasons.push('ISSUED_BACKFILLED');
    if (lineTax < 0 || lineTax !== old.taxMinor - providerTax)
      reasons.push('UNRECONCILED');
  } else if (
    next.subtotalMinor !== old.subtotalMinor ||
    next.taxMinor !== old.taxMinor ||
    next.totalMinor !== old.totalMinor
  ) {
    reasons.push('DRAFT_RECOMPUTED');
  }
  if (documentType === 'contract' && lines.length && old.totalMinor === 0)
    reasons.push('MISSING_HEADER_TOTALS');
  if (documentType === 'contract') {
    const customer = Boolean(header.customer_id);
    const vendor = Boolean(header.vendor_id);
    const leaf =
      String(header._meta_type ?? '')
        .split(':')
        .at(-1) ?? '';
    if (customer === vendor || leaf === 'Contract')
      reasons.push('CONTRACT_DIRECTION_UNKNOWN');
  }
  if (documentType === 'invoice') {
    const encodedState = String(header.accounting_sync_state_json ?? '').trim();
    try {
      const state = JSON.parse(encodedState || '{}') as {
        status?: unknown;
      };
      if (state.status === 'in_flight' || state.status === 'unknown')
        reasons.push('ACCOUNTING_SYNC_UNSETTLED');
    } catch {
      reasons.push('ACCOUNTING_SYNC_UNSETTLED');
    }
  }
  return {
    tenantId,
    documentType,
    documentId: String(header.id),
    status,
    arJournalIdSet: Boolean(header.ar_journal_id),
    old,
    next,
    delta: {
      subtotalMinor: next.subtotalMinor - old.subtotalMinor,
      taxMinor: next.taxMinor - old.taxMinor,
      totalMinor: next.totalMinor - old.totalMinor,
    },
    reasons: [...new Set(reasons)],
  };
}

async function structuralReports(
  db: DatabaseInterface,
  tenantId?: string,
): Promise<CommerceLineAmountDocumentReport[]> {
  const output: CommerceLineAmountDocumentReport[] = [];
  for (const [documentType, lineTable, headerTable, parentColumn] of [
    ['invoice', 'invoice_line_items', 'invoices', 'invoice_id'],
    ['contract', 'contract_line_items', 'contracts', 'contract_id'],
  ] as const) {
    if (
      !(await tableExists(db, lineTable)) ||
      !(await tableExists(db, headerTable))
    )
      continue;
    const tenantClause = tenantId
      ? ' AND (CAST(line.tenant_id AS TEXT) = ? OR CAST(parent.tenant_id AS TEXT) = ?)'
      : '';
    const malformed = rows(
      await db.query(
        `SELECT line.id AS line_id, line.${parentColumn} AS parent_id,
                line.tenant_id AS line_tenant_id, parent.tenant_id AS parent_tenant_id,
                parent.id AS found_parent_id
           FROM ${lineTable} line
           LEFT JOIN ${headerTable} parent
             ON CAST(parent.id AS TEXT) = CAST(line.${parentColumn} AS TEXT)
          WHERE (parent.id IS NULL OR line.tenant_id IS NULL
             OR CAST(line.tenant_id AS TEXT) = ''
             OR parent.tenant_id IS NULL
             OR CAST(parent.tenant_id AS TEXT) = ''
             OR CAST(line.tenant_id AS TEXT) <> CAST(parent.tenant_id AS TEXT))${tenantClause}
          ORDER BY line.id ASC`,
        ...(tenantId ? [tenantId, tenantId] : []),
      ),
    );
    for (const row of malformed) {
      const reason: CommerceLineAmountReasonCode = !row.found_parent_id
        ? 'ORPHAN_LINE'
        : !row.line_tenant_id || !row.parent_tenant_id
          ? 'MISSING_LINE_TENANT'
          : 'CROSS_TENANT_LINE';
      output.push({
        tenantId: String(
          row.parent_tenant_id ?? row.line_tenant_id ?? tenantId ?? 'unknown',
        ),
        documentType,
        documentId: String(row.parent_id ?? `line:${row.line_id}`),
        status: 'invalid-relationship',
        arJournalIdSet: false,
        old: { subtotalMinor: 0, taxMinor: 0, totalMinor: 0 },
        next: { subtotalMinor: 0, taxMinor: 0, totalMinor: 0 },
        delta: { subtotalMinor: 0, taxMinor: 0, totalMinor: 0 },
        reasons: [reason],
      });
    }
  }
  return output;
}

function summarize(
  documents: CommerceLineAmountDocumentReport[],
): CommerceLineAmountTenantSummary[] {
  const byTenant = new Map<string, CommerceLineAmountDocumentReport[]>();
  for (const document of documents) {
    const current = byTenant.get(document.tenantId) ?? [];
    current.push(document);
    byTenant.set(document.tenantId, current);
  }
  return [...byTenant].map(([tenantId, tenantDocuments]) => ({
    tenantId,
    documentCount: tenantDocuments.length,
    changingDraftCount: tenantDocuments.filter(
      (document) =>
        document.status === 'draft' &&
        document.reasons.includes('DRAFT_RECOMPUTED'),
    ).length,
    issuedUnpostedFallbackTaxCount: tenantDocuments.filter(
      (document) =>
        document.reasons.includes('ISSUED_BACKFILLED') &&
        !document.arJournalIdSet,
    ).length,
    reasonCounts: Object.fromEntries(
      REASON_ORDER.flatMap((reason) => {
        const count = tenantDocuments.filter((document) =>
          document.reasons.includes(reason),
        ).length;
        return count ? [[reason, count]] : [];
      }),
    ),
  }));
}

/** Read-only migration inventory. It never creates TaxSettings or claims a barrier. */
export async function preflightCommerceLineAmounts(
  db: DatabaseInterface,
  options: PreflightCommerceLineAmountsOptions = {},
): Promise<CommerceLineAmountsReport> {
  const documents: CommerceLineAmountDocumentReport[] = [];
  for (const [documentType, headerTable, lineTable, parentColumn] of [
    ['invoice', 'invoices', 'invoice_line_items', 'invoice_id'],
    ['contract', 'contracts', 'contract_line_items', 'contract_id'],
  ] as const) {
    if (
      !(await tableExists(db, headerTable)) ||
      !(await tableExists(db, lineTable))
    )
      continue;
    const headers = rows(
      await db.query(
        `SELECT * FROM ${headerTable}${options.tenantId ? ' WHERE CAST(tenant_id AS TEXT) = ?' : ''} ORDER BY tenant_id ASC, id ASC`,
        ...(options.tenantId ? [options.tenantId] : []),
      ),
    );
    for (const header of headers) {
      const tenantId = String(header.tenant_id ?? '');
      if (!tenantId) continue;
      const lines = rows(
        await db.query(
          `SELECT * FROM ${lineTable} WHERE CAST(${parentColumn} AS TEXT) = ? ORDER BY id ASC`,
          String(header.id),
        ),
      ).filter((line) => String(line.tenant_id ?? '') === tenantId);
      documents.push(documentReport(tenantId, documentType, header, lines));
    }
  }
  for (const malformed of await structuralReports(db, options.tenantId)) {
    const existing = documents.find(
      (document) =>
        document.tenantId === malformed.tenantId &&
        document.documentType === malformed.documentType &&
        document.documentId === malformed.documentId,
    );
    if (existing)
      existing.reasons = [
        ...new Set([...existing.reasons, ...malformed.reasons]),
      ];
    else documents.push(malformed);
  }
  const report = canonicalReport({
    version: 1,
    documents,
    tenants: summarize(documents),
  });
  if (options.out) {
    await Promise.all([
      writeFile(
        options.out.jsonPath,
        serializeCommerceLineAmountsReportJson(report),
      ),
      writeFile(
        options.out.csvPath,
        serializeCommerceLineAmountsReportCsv(report),
      ),
    ]);
  }
  return report;
}

async function journalFor(
  db: DatabaseInterface,
  input: {
    tenantId: string;
    migrationId: string;
    documentType: 'invoice' | 'contract';
    documentId: string;
  },
): Promise<MoneyMigrationDocument | null> {
  return (await MoneyMigrationDocumentCollection.create({ db })).findDocument(
    input,
  );
}

async function prepareDocumentJournal(
  db: DatabaseInterface,
  input: {
    tenantId: string;
    migrationId: string;
    documentType: 'invoice' | 'contract';
    documentId: string;
  },
): Promise<'prepared' | 'resumed' | 'applied'> {
  return withTenant({ tenantId: input.tenantId }, () =>
    withTenantMoneyMigration(
      db,
      input.tenantId,
      input.migrationId,
      async (scope) => {
        const image = await captureDocument(
          scope.db,
          input.tenantId,
          input.documentType,
          input.documentId,
        );
        const json = imageJson(image);
        const digest = checksum(json);
        const existing = await journalFor(scope.db, input);
        if (!existing) {
          await (
            await MoneyMigrationDocumentCollection.create({ db: scope.db })
          ).create({
            ...input,
            state: 'prepared',
            preImageJson: json,
            preChecksum: digest,
          });
          return 'prepared';
        }
        if (existing.state === 'applied' && existing.postChecksum === digest)
          return 'applied';
        if (existing.state === 'prepared' && existing.preChecksum === digest)
          return 'resumed';
        throw new MoneyValidationError(
          'FROZEN_DOCUMENT',
          `Migration journal checksum does not match ${input.documentType} ${input.documentId}`,
        );
      },
    ),
  );
}

function rateMapping(report: LegacyTaxMapReport, value: unknown) {
  const source = String(value ?? '');
  const mapping = report.mappings.find(
    (candidate) => candidate.sourceRate === source,
  );
  if (!mapping)
    throw new MoneyValidationError(
      'TAX_CODE_NOT_FOUND',
      `Legacy tax rate ${source} has no durable mapping`,
    );
  return mapping;
}

async function taxMetadata(
  db: DatabaseInterface,
  taxCodeId: string,
  taxComponentId: string | null,
): Promise<{
  code: string;
  name: string;
  kind: 'taxable' | 'zero-rated' | 'exempt' | 'out-of-scope';
  componentName: string | null;
  percent: string | null;
  liabilityAccountId: string | null;
  recoverable: boolean;
}> {
  const code = rows(
    await db.query(
      'SELECT * FROM tax_codes WHERE CAST(id AS TEXT) = ?',
      taxCodeId,
    ),
  )[0];
  if (!code)
    throw new MoneyValidationError(
      'TAX_CODE_NOT_FOUND',
      `Tax code ${taxCodeId} was not found`,
    );
  const component = taxComponentId
    ? rows(
        await db.query(
          'SELECT * FROM tax_components WHERE CAST(id AS TEXT) = ?',
          taxComponentId,
        ),
      )[0]
    : null;
  if (taxComponentId && !component)
    throw new MoneyValidationError(
      'TAX_CODE_NOT_FOUND',
      `Tax component ${taxComponentId} was not found`,
    );
  return {
    code: String(code.code),
    name: String(code.name),
    kind: String(code.kind) as
      | 'taxable'
      | 'zero-rated'
      | 'exempt'
      | 'out-of-scope',
    componentName: component ? String(component.name) : null,
    percent: component ? String(component.percent) : null,
    liabilityAccountId: component?.liability_account_id
      ? String(component.liability_account_id)
      : null,
    recoverable: Boolean(component?.recoverable),
  };
}

async function updateRowsExact(
  collection:
    | InvoiceCollection
    | InvoiceLineItemCollection
    | ContractCollection,
  table: string,
  id: string,
  values: StoredRow,
): Promise<void> {
  const entries = Object.entries(values).filter(([key]) => key !== 'id');
  const assignments = entries.map(([key]) => `"${key}" = ?`).join(', ');
  const result = await collection.query(
    `UPDATE "${table}" SET ${assignments} WHERE CAST("id" AS TEXT) = ? RETURNING "id"`,
    [...entries.map(([, value]) => value), id],
    { allowRawOnTenantScoped: true },
  );
  if (result.length !== 1)
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      `${table} ${id} disappeared during migration`,
    );
}

async function partyTaxId(
  db: DatabaseInterface,
  header: StoredRow,
): Promise<string> {
  const [table, id] = header.customer_id
    ? ['customers', header.customer_id]
    : header.vendor_id
      ? ['vendors', header.vendor_id]
      : [null, null];
  if (!table || !id) return '';
  const row = rows(
    await db.query(
      `SELECT tax_id FROM ${table} WHERE CAST(id AS TEXT) = ?`,
      String(id),
    ),
  )[0];
  return String(row?.tax_id ?? '');
}

async function migrateIssuedDocument(
  db: DatabaseInterface,
  input: {
    tenantId: string;
    migrationId: string;
    documentType: 'invoice' | 'contract';
    documentId: string;
    taxMap: LegacyTaxMapReport;
  },
): Promise<void> {
  const image = await captureDocument(
    db,
    input.tenantId,
    input.documentType,
    input.documentId,
  );
  const snapshotId = `migration-${checksum(`${input.tenantId}\0${input.documentType}\0${input.documentId}`).slice(0, 32)}`;
  const taxGroups = new Map<string, DocumentTaxWriteInput>();
  let discountTotal = 0;
  const lineCollection =
    input.documentType === 'invoice'
      ? await InvoiceLineItemCollection.create({ db })
      : await ContractCollection.create({ db });
  const lineTable =
    input.documentType === 'invoice'
      ? 'invoice_line_items'
      : 'contract_line_items';
  for (const line of image.lines) {
    const prior = storedMinor(line.amount, 'legacy line amount');
    const net = lineNet(line);
    const tax = prior - net;
    if (tax < 0)
      throw new MoneyValidationError(
        'INVALID_MONEY_INPUT',
        'Issued line has negative derived legacy tax',
      );
    const mapping = rateMapping(input.taxMap, line.tax_rate);
    const metadata = await taxMetadata(
      db,
      mapping.taxCodeId,
      mapping.taxComponentId,
    );
    const componentSnapshot = mapping.taxComponentId
      ? [
          {
            taxComponentId: mapping.taxComponentId,
            name: metadata.componentName ?? metadata.name,
            percent: metadata.percent ?? '0',
            taxMinor: tax,
          },
        ]
      : [];
    discountTotal += storedMinor(line.discount ?? 0, 'line discount');
    await updateRowsExact(lineCollection, lineTable, String(line.id), {
      legacy_amount: prior,
      amount: net,
      tax_amount: tax,
      tax_mode: 'override',
      tax_code_id: mapping.taxCodeId,
      tax_code_code: metadata.code,
      tax_code_name: metadata.name,
      tax_components_json: JSON.stringify(componentSnapshot),
      money_snapshot_id: snapshotId,
    });
    const key = `${mapping.taxCodeId}\0${mapping.taxComponentId ?? ''}`;
    const current = taxGroups.get(key);
    if (current) {
      current.taxableMinor += net;
      current.taxMinor += tax;
    } else {
      taxGroups.set(key, {
        tenantId: input.tenantId,
        documentType: input.documentType,
        documentId: input.documentId,
        currency: String(image.header.currency),
        taxCodeId: mapping.taxCodeId,
        taxCodeCode: metadata.code,
        kind: metadata.kind,
        taxComponentId: mapping.taxComponentId,
        taxComponentName: metadata.componentName,
        percent: metadata.percent,
        liabilityAccountId: metadata.liabilityAccountId,
        taxableMinor: net,
        taxMinor: tax,
        recoverableMinor:
          input.documentType === 'contract' &&
          image.header.vendor_id &&
          metadata.recoverable
            ? tax
            : 0,
      });
    }
  }
  await (await DocumentTaxCollection.create({ db })).replaceDerivedForDocument(
    DOCUMENT_MONEY_WRITE,
    {
      tenantId: input.tenantId,
      documentType: input.documentType,
      documentId: input.documentId,
      rows: [...taxGroups.values()],
    },
  );
  const settings = await (
    await TaxSettingsCollection.create({ db })
  ).getForTenant(input.tenantId);
  if (!settings)
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Migration settings disappeared',
    );
  const headerCollection =
    input.documentType === 'invoice'
      ? await InvoiceCollection.create({ db })
      : await ContractCollection.create({ db });
  const headerTable =
    input.documentType === 'invoice' ? 'invoices' : 'contracts';
  // These are the only issued-header exceptions: additive v2 snapshot columns.
  // Existing totals, lifecycle fields, revision and timestamps are untouched.
  await updateRowsExact(headerCollection, headerTable, input.documentId, {
    discount_total: discountTotal,
    line_amount_type: settings.defaultLineAmountType,
    tax_rounding_scope: settings.taxRoundingScope,
    seller_tax_registrations_json: settings.taxRegistrationsJson,
    party_tax_id: await partyTaxId(db, image.header),
    money_snapshot_id: snapshotId,
  });
}

async function promoteDraftTaxOverrides(
  db: DatabaseInterface,
  input: {
    documentType: 'invoice' | 'contract';
    documentId: string;
    taxMap: LegacyTaxMapReport;
  },
): Promise<void> {
  const lineTable =
    input.documentType === 'invoice'
      ? 'invoice_line_items'
      : 'contract_line_items';
  const parentColumn =
    input.documentType === 'invoice' ? 'invoice_id' : 'contract_id';
  const collection =
    input.documentType === 'invoice'
      ? await InvoiceLineItemCollection.create({ db })
      : await ContractCollection.create({ db });
  const draftLines = rows(
    await db.query(
      `SELECT id, tax_rate FROM ${lineTable} WHERE CAST(${parentColumn} AS TEXT) = ? ORDER BY id ASC`,
      input.documentId,
    ),
  );
  for (const line of draftLines) {
    const mapping = rateMapping(input.taxMap, line.tax_rate);
    await updateRowsExact(collection, lineTable, String(line.id), {
      tax_mode: 'override',
      tax_code_id: mapping.taxCodeId,
    });
  }
}

async function applyDocument(
  db: DatabaseInterface,
  input: {
    tenantId: string;
    migrationId: string;
    document: CommerceLineAmountDocumentReport;
    taxMap: LegacyTaxMapReport;
  },
): Promise<void> {
  await withTenant({ tenantId: input.tenantId }, () =>
    withTenantMoneyMigration(
      db,
      input.tenantId,
      input.migrationId,
      async (scope) => {
        const journal = await journalFor(scope.db, {
          tenantId: input.tenantId,
          migrationId: input.migrationId,
          documentType: input.document.documentType,
          documentId: input.document.documentId,
        });
        if (journal?.state !== 'prepared')
          throw new MoneyValidationError(
            'INVALID_MONEY_INPUT',
            'Prepared migration journal is required',
          );
        const current = await captureDocument(
          scope.db,
          input.tenantId,
          input.document.documentType,
          input.document.documentId,
        );
        if (checksum(imageJson(current)) !== journal.preChecksum)
          throw new MoneyValidationError(
            'FROZEN_DOCUMENT',
            'Document changed after migration preparation',
          );
        if (
          input.document.status === 'draft' &&
          !input.document.arJournalIdSet
        ) {
          await promoteDraftTaxOverrides(scope.db, {
            documentType: input.document.documentType,
            documentId: input.document.documentId,
            taxMap: input.taxMap,
          });
          if (input.document.documentType === 'invoice')
            await materializeInvoiceMoneyDraft({
              db: scope.db,
              invoiceId: input.document.documentId,
              tenantId: input.tenantId,
              migrationId: input.migrationId,
            });
          else
            await materializeContractMoneySnapshot({
              db: scope.db,
              contractId: input.document.documentId,
              tenantId: input.tenantId,
              migrationId: input.migrationId,
            });
        } else {
          await migrateIssuedDocument(scope.db, {
            tenantId: input.tenantId,
            migrationId: input.migrationId,
            documentType: input.document.documentType,
            documentId: input.document.documentId,
            taxMap: input.taxMap,
          });
        }
        const post = await captureDocument(
          scope.db,
          input.tenantId,
          input.document.documentType,
          input.document.documentId,
        );
        journal.postImageJson = imageJson(post);
        journal.postChecksum = checksum(journal.postImageJson);
        journal.state = 'applied';
        await journal.save();
      },
    ),
  );
}

async function verifyTenant(
  db: DatabaseInterface,
  tenantId: string,
): Promise<void> {
  for (const [documentType, headerTable, lineTable, parentColumn] of [
    ['invoice', 'invoices', 'invoice_line_items', 'invoice_id'],
    ['contract', 'contracts', 'contract_line_items', 'contract_id'],
  ] as const) {
    const headers = rows(
      await db.query(
        `SELECT id, tax_amount, ${documentType === 'invoice' ? 'provider_tax_amount' : '0 AS provider_tax_amount'}
           FROM ${headerTable} WHERE CAST(tenant_id AS TEXT) = ? AND status <> 'draft'`,
        tenantId,
      ),
    );
    for (const header of headers) {
      const lineSum = rows(
        await db.query(
          `SELECT COALESCE(SUM(tax_amount), 0) AS total FROM ${lineTable} WHERE CAST(${parentColumn} AS TEXT) = ?`,
          String(header.id),
        ),
      )[0];
      const taxSum = rows(
        await db.query(
          `SELECT COALESCE(SUM(tax_minor), 0) AS total FROM document_taxes
            WHERE CAST(tenant_id AS TEXT) = ? AND document_type = ? AND CAST(document_id AS TEXT) = ?`,
          tenantId,
          documentType,
          String(header.id),
        ),
      )[0];
      const expected =
        storedMinor(header.tax_amount, 'header tax') -
        storedMinor(header.provider_tax_amount, 'provider tax');
      const actualLines = storedMinor(lineSum?.total ?? 0, 'line tax sum');
      const actualTaxes = storedMinor(taxSum?.total ?? 0, 'DocumentTax sum');
      if (actualLines !== expected || actualTaxes !== actualLines)
        throw new MoneyValidationError(
          'INVALID_MONEY_INPUT',
          `${documentType} ${header.id} failed post-migration tax verification`,
        );
    }
  }
}

/** Claim one tenant, migrate each document durably, verify, then activate v2. */
export async function migrateCommerceLineAmounts(
  db: DatabaseInterface,
  options: MigrateCommerceLineAmountsOptions,
): Promise<CommerceLineAmountsMigrationResult> {
  if (!options.tenantId?.trim())
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Migration tenant is required',
    );
  const report = await preflightCommerceLineAmounts(db, {
    tenantId: options.tenantId,
  });
  const tenantDocuments = report.documents.filter(
    (document) => document.tenantId === options.tenantId,
  );
  const settings = await withTenant({ tenantId: options.tenantId }, () =>
    TaxSettingsCollection.create({ db }),
  );
  const persistedSettings = await withTenant(
    { tenantId: options.tenantId },
    () => settings.getForTenant(options.tenantId),
  );
  let migrationId = options.migrationId;
  const applied = new Set<string>();
  if (persistedSettings?.moneyModel === 'migrating') {
    if (!migrationId || persistedSettings.moneyMigrationId !== migrationId)
      throw new MoneyValidationError(
        'FROZEN_DOCUMENT',
        'Resuming migration requires the active owner identity',
      );
    const journals = await withTenant(
      { tenantId: options.tenantId },
      async () =>
        (await MoneyMigrationDocumentCollection.create({ db })).list({
          where: { tenantId: options.tenantId, migrationId, state: 'applied' },
        }),
    );
    for (const journal of journals)
      applied.add(`${journal.documentType}\0${journal.documentId}`);
  } else if (persistedSettings?.moneyModel === 'v2') {
    throw new MoneyValidationError(
      'FROZEN_DOCUMENT',
      'Tenant money model is already v2',
    );
  }
  const pendingDocuments = tenantDocuments.filter(
    (document) =>
      !applied.has(`${document.documentType}\0${document.documentId}`),
  );
  const blockers = pendingDocuments.filter((document) =>
    document.reasons.some((reason) => BLOCKING_REASONS.has(reason)),
  );
  if (blockers.length)
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      `Migration preflight blocked by ${blockers.map((document) => `${document.documentType}:${document.documentId}:${document.reasons.filter((reason) => BLOCKING_REASONS.has(reason)).join('+')}`).join(', ')}`,
    );
  if (
    !options.acceptDraftChanges &&
    pendingDocuments.some((document) =>
      document.reasons.includes('DRAFT_RECOMPUTED'),
    )
  )
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Migration changes draft totals; pass acceptDraftChanges after reviewing preflight',
    );
  if (!persistedSettings || persistedSettings.moneyModel === 'legacy')
    migrationId = await withTenant({ tenantId: options.tenantId }, () =>
      settings.beginMoneyMigration(options.tenantId, migrationId),
    );
  if (!migrationId)
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Migration owner identity was not established',
    );
  const taxMap = (
    await mapLegacyTaxRates(db, { tenantId: options.tenantId })
  )[0];
  if (!taxMap)
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Legacy tax mapping returned no tenant report',
    );
  let migrated = 0;
  let resumed = 0;
  for (const document of tenantDocuments) {
    const state = await prepareDocumentJournal(db, {
      tenantId: options.tenantId,
      migrationId,
      documentType: document.documentType,
      documentId: document.documentId,
    });
    if (state === 'applied') {
      resumed++;
      continue;
    }
    if (state === 'resumed') resumed++;
    await applyDocument(db, {
      tenantId: options.tenantId,
      migrationId,
      document,
      taxMap,
    });
    migrated++;
  }
  await withTenant({ tenantId: options.tenantId }, () =>
    withTenantMoneyMigration(db, options.tenantId, migrationId, (scope) =>
      verifyTenant(scope.db, options.tenantId),
    ),
  );
  await withTenant({ tenantId: options.tenantId }, () =>
    settings.activateMoneyV2(options.tenantId, migrationId),
  );
  return {
    tenantId: options.tenantId,
    migrationId,
    migrated,
    resumed,
    activated: true,
    report,
  };
}

async function restoreRows(
  db: DatabaseInterface,
  image: MigrationImage,
  documentType: 'invoice' | 'contract',
): Promise<void> {
  const headerTable = documentType === 'invoice' ? 'invoices' : 'contracts';
  const lineTable =
    documentType === 'invoice' ? 'invoice_line_items' : 'contract_line_items';
  const headerCollection =
    documentType === 'invoice'
      ? await InvoiceCollection.create({ db })
      : await ContractCollection.create({ db });
  const lineCollection =
    documentType === 'invoice'
      ? await InvoiceLineItemCollection.create({ db })
      : await ContractCollection.create({ db });
  await updateRowsExact(
    headerCollection,
    headerTable,
    String(image.header.id),
    image.header,
  );
  for (const line of image.lines)
    await updateRowsExact(lineCollection, lineTable, String(line.id), line);
  const taxes = await DocumentTaxCollection.create({ db });
  await taxes.query(
    `DELETE FROM document_taxes
      WHERE CAST(tenant_id AS TEXT) = ? AND document_type = ? AND CAST(document_id AS TEXT) = ?`,
    [String(image.header.tenant_id), documentType, String(image.header.id)],
    { allowRawOnTenantScoped: true },
  );
  for (const tax of image.taxes) {
    const entries = Object.entries(tax);
    await taxes.query(
      `INSERT INTO document_taxes (${entries.map(([key]) => `"${key}"`).join(', ')})
       VALUES (${entries.map(() => '?').join(', ')}) RETURNING id`,
      entries.map(([, value]) => value),
      { allowRawOnTenantScoped: true },
    );
  }
}

/** Restore exact pre-images only while every current document still matches its post-image. */
export async function rollbackCommerceLineAmounts(
  db: DatabaseInterface,
  options: RollbackCommerceLineAmountsOptions,
): Promise<CommerceLineAmountsRollbackResult> {
  if (!options.tenantId?.trim() || !options.migrationId?.trim())
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Rollback requires tenant and migration identities',
    );
  const settings = await withTenant({ tenantId: options.tenantId }, () =>
    TaxSettingsCollection.create({ db }),
  );
  const current = await withTenant({ tenantId: options.tenantId }, () =>
    settings.getForTenant(options.tenantId),
  );
  if (current?.moneyModel === 'v2')
    await withTenant({ tenantId: options.tenantId }, () =>
      settings.beginMoneyRollback(options.tenantId, options.migrationId),
    );
  else if (
    current?.moneyModel !== 'migrating' ||
    current.moneyMigrationId !== options.migrationId
  )
    throw new MoneyValidationError(
      'FROZEN_DOCUMENT',
      'Rollback does not own the tenant money marker',
    );
  const journalCollection = await MoneyMigrationDocumentCollection.create({
    db,
  });
  const journals = await withTenant({ tenantId: options.tenantId }, () =>
    journalCollection.list({
      where: { tenantId: options.tenantId, migrationId: options.migrationId },
      orderBy: ['documentType ASC', 'documentId ASC'],
    }),
  );
  if (!journals.length)
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Rollback journal is empty',
    );
  // Validate the entire rollback set before restoring any document. A later
  // mismatch must not leave an earlier document rolled back under the same
  // still-migrating tenant marker.
  for (const journal of journals) {
    if (journal.state === 'rolled_back') continue;
    await withTenant({ tenantId: options.tenantId }, () =>
      withTenantMoneyMigration(
        db,
        options.tenantId,
        options.migrationId,
        async (scope) => {
          const currentImage = await captureDocument(
            scope.db,
            options.tenantId,
            journal.documentType,
            journal.documentId,
          );
          if (checksum(imageJson(currentImage)) !== journal.postChecksum)
            throw new MoneyValidationError(
              'FROZEN_DOCUMENT',
              `${journal.documentType} ${journal.documentId} changed after migration; rollback refused`,
            );
        },
      ),
    );
  }
  let restored = 0;
  let alreadyRestored = 0;
  for (const journal of journals) {
    if (journal.state === 'rolled_back') {
      alreadyRestored++;
      continue;
    }
    await withTenant({ tenantId: options.tenantId }, () =>
      withTenantMoneyMigration(
        db,
        options.tenantId,
        options.migrationId,
        async (scope) => {
          const locked = await journalFor(scope.db, {
            tenantId: options.tenantId,
            migrationId: options.migrationId,
            documentType: journal.documentType,
            documentId: journal.documentId,
          });
          if (locked?.state !== 'applied')
            throw new MoneyValidationError(
              'FROZEN_DOCUMENT',
              'Rollback journal is not applied',
            );
          const currentImage = await captureDocument(
            scope.db,
            options.tenantId,
            locked.documentType,
            locked.documentId,
          );
          if (checksum(imageJson(currentImage)) !== locked.postChecksum)
            throw new MoneyValidationError(
              'FROZEN_DOCUMENT',
              `${locked.documentType} ${locked.documentId} changed after migration; rollback refused`,
            );
          const preImage = JSON.parse(locked.preImageJson) as MigrationImage;
          if (checksum(imageJson(preImage)) !== locked.preChecksum)
            throw new MoneyValidationError(
              'INVALID_MONEY_INPUT',
              'Rollback pre-image checksum is invalid',
            );
          await restoreRows(scope.db, preImage, locked.documentType);
          const restoredImage = await captureDocument(
            scope.db,
            options.tenantId,
            locked.documentType,
            locked.documentId,
          );
          if (checksum(imageJson(restoredImage)) !== locked.preChecksum)
            throw new MoneyValidationError(
              'INVALID_MONEY_INPUT',
              'Rollback did not restore the exact pre-image',
            );
          locked.state = 'rolled_back';
          await locked.save();
        },
      ),
    );
    restored++;
  }
  await withTenant({ tenantId: options.tenantId }, () =>
    settings.restoreLegacyMoneyModel(options.tenantId, options.migrationId),
  );
  return {
    tenantId: options.tenantId,
    migrationId: options.migrationId,
    restored,
    alreadyRestored,
  };
}
