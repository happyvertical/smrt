/** Original header totals remain readable even when detailed tax classifications are unknown. */
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { getTenantId } from '@happyvertical/smrt-tenancy';
import type {
  DocumentTaxReportFact,
  DocumentTaxReportFactsOptions,
} from './collections/DocumentTaxCollection.js';
import { InvoiceCollection } from './collections/InvoiceCollection.js';
import { getHistoricalSalesMoney } from './historical-sales-money.js';
import { historicalSalesMagnitudes } from './historical-sales-validation.js';
import type { Invoice } from './models/Invoice.js';
import { withTenantMoneyRuntime } from './tenant-money-barrier.js';

export interface HistoricalSalesHeaderReportFact {
  invoiceId: string;
  moneySnapshotId: string;
  customerId: string;
  invoiceNumber: string;
  kind: Invoice['kind'];
  issueDate: string;
  currency: string;
  netMinor: number;
  taxMinor: number;
  grossMinor: number;
  taxBreakdownKnown: boolean;
}
export class HistoricalSalesTaxClassificationRequired extends Error {
  readonly code = 'HISTORICAL_SALES_TAX_CLASSIFICATION_REQUIRED';
  constructor(readonly invoiceId: string) {
    super(
      `Historical invoice ${invoiceId} retains exact header totals, but this tax breakdown requires explicit reviewed source classification, tax identity and taxable basis. Read the historical header facts or resolve the source assessment; never infer a rate or line allocation.`,
    );
    this.name = 'HistoricalSalesTaxClassificationRequired';
  }
}
function classified(invoice: Invoice) {
  const snapshot = getHistoricalSalesMoney(invoice);
  if (!snapshot) return false;
  const components = snapshot.facts.taxComponents;
  return Boolean(
    components?.length &&
      components.every(
        (component) =>
          component.classification !== null &&
          component.taxCodeId &&
          component.taxableMinor !== null &&
          component.netMinor !== null &&
          (component.classification !== 'taxable' || component.taxComponentId),
      ),
  );
}
/** @internal Project explicit source detail only; a known header is not a component classification. */
export function historicalSalesTaxReportFacts(
  invoice: Invoice,
): DocumentTaxReportFact[] {
  const snapshot = getHistoricalSalesMoney(invoice);
  if (!snapshot) return [];
  if (snapshot.facts.netMinor === 0 && snapshot.facts.taxMinor === 0) return [];
  if (!classified(invoice))
    throw new HistoricalSalesTaxClassificationRequired(String(invoice.id));
  const sign =
    snapshot.facts.kind === 'credit_note' &&
    snapshot.facts.polarity === 'signed'
      ? -1
      : 1;
  return (snapshot.facts.taxComponents ?? []).map((component) => {
    if (
      component.classification === null ||
      !component.taxCodeId ||
      component.taxableMinor === null
    )
      throw new HistoricalSalesTaxClassificationRequired(String(invoice.id));
    return {
      tenantId: String(invoice.tenantId),
      documentType: invoice.kind,
      documentId: String(invoice.id),
      documentNumber: invoice.invoiceNumber,
      partyId: invoice.customerId,
      documentKind: invoice.kind,
      issueDate: invoice.issueDate.toISOString(),
      status: invoice.status,
      direction: 'sales',
      currency: invoice.currency,
      taxCodeId: component.taxCodeId,
      taxCodeKind: component.classification,
      taxableMinor: component.taxableMinor * sign,
      ...(component.netMinor === null
        ? {}
        : { netMinor: component.netMinor * sign }),
      taxMinor: component.amountMinor * sign,
      recoverableMinor: 0,
      taxComponentId: component.taxComponentId,
      componentName: component.label,
      liabilityAccountId: component.liabilityAccountId,
      commitmentId: null,
      commitmentLineId: null,
    };
  });
}
/** @internal Invoice source rows for the same public report scope; never silently truncate. */
export async function historicalSalesReportInvoices(
  db: DatabaseInterface,
  options: DocumentTaxReportFactsOptions,
) {
  const rows = await (await InvoiceCollection.create({ db })).list({
    where: { tenantId: options.tenantId, moneyAuthority: 'historical' },
    limit: 100001,
  });
  if (rows.length > 100000)
    throw new Error(
      'Historical sales report scope exceeds the bounded document limit; select a smaller scope',
    );
  return rows.filter(
    (invoice) =>
      invoice.status !== 'draft' &&
      invoice.status !== 'cancelled' &&
      invoice.issueDate >= options.from &&
      invoice.issueDate <= options.to &&
      (!options.currency || invoice.currency === options.currency),
  );
}
/** Exact generic header reporting does not require a fabricated tax breakdown. */
export async function listHistoricalSalesHeaderFacts(
  input: DocumentTaxReportFactsOptions & { db: DatabaseInterface },
): Promise<HistoricalSalesHeaderReportFact[]> {
  if (getTenantId() !== input.tenantId)
    throw new Error(
      'Historical sales reporting requires the explicit active tenant',
    );
  if (
    !(input.from instanceof Date) ||
    !(input.to instanceof Date) ||
    !Number.isFinite(input.from.getTime()) ||
    !Number.isFinite(input.to.getTime()) ||
    input.from > input.to
  )
    throw new Error(
      'Historical sales report requires an explicit valid period',
    );
  return withTenantMoneyRuntime(input.db, input.tenantId, async ({ db }) =>
    (await historicalSalesReportInvoices(db, input)).map((invoice) => {
      const snapshot = getHistoricalSalesMoney(invoice);
      if (!snapshot)
        throw new Error('Historical source monetary authority is unavailable');
      return {
        invoiceId: String(invoice.id),
        moneySnapshotId: invoice.moneySnapshotId,
        customerId: invoice.customerId,
        invoiceNumber: invoice.invoiceNumber,
        kind: invoice.kind,
        issueDate: invoice.issueDate.toISOString(),
        currency: invoice.currency,
        ...historicalSalesMagnitudes(snapshot.facts),
        taxBreakdownKnown: classified(invoice),
      };
    }),
  );
}
