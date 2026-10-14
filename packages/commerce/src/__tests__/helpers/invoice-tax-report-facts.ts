import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { CustomerCollection } from '../../collections/CustomerCollection.js';
import { DocumentTaxCollection } from '../../collections/DocumentTaxCollection.js';
import { InvoiceCollection } from '../../collections/InvoiceCollection.js';
import { DOCUMENT_MONEY_WRITE } from '../../document-money-internal.js';
import { InvoiceStatus } from '../../types/index.js';

export interface InvoiceTaxReportFactsFixture {
  tenantId: string;
  invoiceAId: string;
  invoiceBId: string;
  foreignInvoiceId: string;
  partyAId: string;
  partyBId: string;
}

async function issueInvoice(
  invoices: InvoiceCollection,
  input: {
    invoiceNumber: string;
    issueDate: Date;
    status: InvoiceStatus;
    currency?: string;
    customerId?: string;
  },
) {
  const invoice = await invoices.create({
    invoiceNumber: input.invoiceNumber,
    issueDate: input.issueDate,
    currency: input.currency ?? 'CAD',
    customerId: input.customerId ?? '',
  });
  invoice.status = input.status;
  await invoice.save();
  if (!invoice.id) throw new Error('Expected persisted invoice id.');
  return invoice;
}

/** Seed the persisted A/B calculator rows without using the calculator itself. */
export async function seedInvoiceTaxReportFacts(
  db: DatabaseInterface,
  tenantId = 'tenant-a',
  foreignTenantId = 'tenant-b',
): Promise<InvoiceTaxReportFactsFixture> {
  const invoices = await InvoiceCollection.create({ db });
  const customers = await CustomerCollection.create({ db });
  const partyA = await customers.create({ profileId: randomUUID() });
  const partyB = await customers.create({ profileId: randomUUID() });
  if (!partyA.id || !partyB.id)
    throw new Error('Expected persisted party ids.');
  const invoiceA = await issueInvoice(invoices, {
    invoiceNumber: 'REPORT-A',
    issueDate: new Date('2026-09-01T00:00:00.000Z'),
    status: InvoiceStatus.SENT,
    customerId: partyA.id,
  });
  const invoiceB = await issueInvoice(invoices, {
    invoiceNumber: 'REPORT-B',
    issueDate: new Date('2026-09-30T23:59:59.999Z'),
    status: InvoiceStatus.WRITTEN_OFF,
    customerId: partyB.id,
  });
  const foreignInvoice = await withTenant({ tenantId: foreignTenantId }, () =>
    issueInvoice(invoices, {
      invoiceNumber: 'REPORT-FOREIGN',
      issueDate: new Date('2026-09-15T00:00:00.000Z'),
      status: InvoiceStatus.SENT,
    }),
  );
  const invoiceAId = invoiceA.id;
  const invoiceBId = invoiceB.id;
  const foreignInvoiceId = foreignInvoice.id;
  if (!invoiceAId || !invoiceBId || !foreignInvoiceId)
    throw new Error('Expected persisted invoice ids.');

  const taxes = await DocumentTaxCollection.create({ db });
  await taxes.replaceDerivedForDocument(DOCUMENT_MONEY_WRITE, {
    tenantId,
    documentType: 'invoice',
    documentId: invoiceAId,
    rows: [
      {
        tenantId,
        documentType: 'invoice',
        documentId: invoiceAId,
        currency: 'CAD',
        taxCodeId: 'gst',
        taxCodeCode: 'GST',
        kind: 'taxable',
        taxComponentId: 'gst',
        taxComponentName: 'GST',
        percent: '5',
        liabilityAccountId: 'gst-payable',
        taxableMinor: 81_000,
        taxMinor: 4_050,
        recoverableMinor: 0,
      },
      {
        tenantId,
        documentType: 'invoice',
        documentId: invoiceAId,
        currency: 'CAD',
        taxCodeId: 'gst-pst',
        taxCodeCode: 'GST/PST',
        kind: 'taxable',
        taxComponentId: 'gst',
        taxComponentName: 'GST',
        percent: '5',
        liabilityAccountId: 'gst-payable',
        taxableMinor: 33_498,
        taxMinor: 1_675,
        recoverableMinor: 0,
      },
      {
        tenantId,
        documentType: 'invoice',
        documentId: invoiceAId,
        currency: 'CAD',
        taxCodeId: 'gst-pst',
        taxCodeCode: 'GST/PST',
        kind: 'taxable',
        taxComponentId: 'pst',
        taxComponentName: 'PST',
        percent: '7',
        liabilityAccountId: 'pst-payable',
        taxableMinor: 33_498,
        taxMinor: 2_345,
        recoverableMinor: 0,
      },
    ],
  });
  await taxes.replaceDerivedForDocument(DOCUMENT_MONEY_WRITE, {
    tenantId,
    documentType: 'invoice',
    documentId: invoiceBId,
    rows: [
      {
        tenantId,
        documentType: 'invoice',
        documentId: invoiceBId,
        currency: 'CAD',
        taxCodeId: 'gst',
        taxCodeCode: 'GST',
        kind: 'taxable',
        taxComponentId: 'gst',
        taxComponentName: 'GST',
        percent: '5',
        liabilityAccountId: 'gst-payable',
        taxableMinor: 77_143,
        taxMinor: 3_857,
        recoverableMinor: 0,
      },
      {
        tenantId,
        documentType: 'invoice',
        documentId: invoiceBId,
        currency: 'CAD',
        taxCodeId: 'gst-pst',
        taxCodeCode: 'GST/PST',
        kind: 'taxable',
        taxComponentId: 'gst',
        taxComponentName: 'GST',
        percent: '5',
        liabilityAccountId: 'gst-payable',
        taxableMinor: 29_908,
        taxMinor: 1_496,
        recoverableMinor: 0,
      },
      {
        tenantId,
        documentType: 'invoice',
        documentId: invoiceBId,
        currency: 'CAD',
        taxCodeId: 'gst-pst',
        taxCodeCode: 'GST/PST',
        kind: 'taxable',
        taxComponentId: 'pst',
        taxComponentName: 'PST',
        percent: '7',
        liabilityAccountId: 'pst-payable',
        taxableMinor: 29_908,
        taxMinor: 2_094,
        recoverableMinor: 0,
      },
    ],
  });
  // Malformed tenant linkage must not cross the explicit join predicate.
  await taxes.replaceDerivedForDocument(DOCUMENT_MONEY_WRITE, {
    tenantId,
    documentType: 'invoice',
    documentId: foreignInvoiceId,
    rows: [
      {
        tenantId,
        documentType: 'invoice',
        documentId: foreignInvoiceId,
        currency: 'CAD',
        taxCodeId: null,
        taxCodeCode: null,
        kind: null,
        taxComponentId: null,
        taxComponentName: null,
        percent: null,
        liabilityAccountId: null,
        taxableMinor: 999,
        taxMinor: 0,
        recoverableMinor: 0,
      },
    ],
  });
  return {
    tenantId,
    invoiceAId,
    invoiceBId,
    foreignInvoiceId,
    partyAId: partyA.id,
    partyBId: partyB.id,
  };
}

/** Add one positive stored credit snapshot; report aggregation supplies its sign. */
export async function seedInvoiceTaxReportCredit(
  db: DatabaseInterface,
  fixture: InvoiceTaxReportFactsFixture,
): Promise<string> {
  const invoices = await InvoiceCollection.create({ db });
  const credit = await invoices.create({
    kind: 'credit_note',
    creditedInvoiceId: fixture.invoiceAId,
    customerId: fixture.partyAId,
    invoiceNumber: 'CN-REPORT-A',
    issueDate: new Date('2026-09-20T00:00:00.000Z'),
    currency: 'CAD',
  });
  credit.status = InvoiceStatus.SENT;
  await credit.save();
  if (!credit.id) throw new Error('Expected persisted credit-note id.');

  const taxes = await DocumentTaxCollection.create({ db });
  await taxes.replaceDerivedForDocument(DOCUMENT_MONEY_WRITE, {
    tenantId: fixture.tenantId,
    documentType: 'credit_note',
    documentId: credit.id,
    rows: [
      {
        tenantId: fixture.tenantId,
        documentType: 'credit_note',
        documentId: credit.id,
        currency: 'CAD',
        taxCodeId: 'gst',
        taxCodeCode: 'GST',
        kind: 'taxable',
        taxComponentId: 'gst',
        taxComponentName: 'GST',
        percent: '5',
        liabilityAccountId: 'gst-payable',
        taxableMinor: 10_000,
        taxMinor: 500,
        recoverableMinor: 0,
      },
    ],
  });
  return credit.id;
}
