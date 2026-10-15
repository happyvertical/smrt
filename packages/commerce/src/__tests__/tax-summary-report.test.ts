import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { queryReportMaterializedRows } from '@happyvertical/smrt-reports';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../collections/ContractCollection.js';
import { DocumentTaxCollection } from '../collections/DocumentTaxCollection.js';
import { TaxSettingsCollection } from '../collections/TaxSettingsCollection.js';
import {
  materializeTaxSummaryRows,
  TaxSummaryReportCollection,
} from '../collections/TaxSummaryReportCollection.js';
import { DOCUMENT_MONEY_WRITE } from '../document-money-internal.js';
import { TaxSummaryReport } from '../models/TaxSummaryReport.js';
import { aggregateTaxSummary } from '../tax-summary.js';
import {
  buildTaxSummaryReportAdapterDescriptor,
  createTaxSummaryMaterializedReportHost,
  drilldownTaxSummaryContributors,
  drilldownTaxSummaryInvoiceFacts,
  presentTaxSummaryDrilldown,
  TAX_SUMMARY_REPORT_ADAPTER,
} from '../tax-summary-report-adapter.js';
import {
  seedInvoiceTaxReportCredit,
  seedInvoiceTaxReportFacts,
} from './helpers/invoice-tax-report-facts.js';
import { defineTaxSummaryLedgerHostSuite } from './helpers/tax-summary-ledger-host-suite.js';

const from = new Date('2026-09-01T00:00:00.000Z');
const to = new Date('2026-09-30T23:59:59.999Z');

describe('TaxSummaryReport invoice source (#3940)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy();
  });

  afterEach(async () => {
    disableTenancy();
    await db.close?.();
  });

  async function activateV2(tenantId: string): Promise<void> {
    const settings = await TaxSettingsCollection.create({ db });
  }

  defineTaxSummaryLedgerHostSuite(() => db);

  it('binds the production tax-summary host to its principal tenant and closed cells', async () => {
    const fixture = await withTenant({ tenantId: 'tenant-a' }, () =>
      seedInvoiceTaxReportFacts(db),
    );
    await withTenant({ tenantId: fixture.tenantId }, () =>
      activateV2(fixture.tenantId),
    );
    await withTenant({ tenantId: 'tenant-b' }, () => activateV2('tenant-b'));
    const reports = await TaxSummaryReportCollection.create({ db });
    await reports.refreshTaxSummary({
      tenantId: fixture.tenantId,
      from,
      to,
      expenseSource: { listReviewedTaxFacts: async () => [] },
      ledgerSource: { listPostedMovements: async () => [] },
      expenseComponentMappings: [],
    });
    const host = createTaxSummaryMaterializedReportHost(db);
    const principal = {
      userId: 'user-a',
      tenantId: fixture.tenantId,
      permissions: ['taxsummaryreports.read'],
    };
    const denied = { ...principal, permissions: [] };
    const oneRow = {
      version: 1,
      requestId: 'denied',
      mode: 'rows' as const,
      projection: ['id'],
      page: { kind: 'offset' as const, offset: 0, limit: 1 },
    };
    await expect(host.descriptor(denied)).rejects.toThrow(/access denied/i);
    expect(() => host.query(denied, oneRow)).toThrow(/access denied/i);
    await expect(
      host.drilldown(denied, { id: 'missing', columnId: 'tax_minor' }),
    ).rejects.toThrow(/access denied/i);
    await expect(host.descriptor({ ...principal, userId: '' })).rejects.toThrow(
      /access denied/i,
    );
    await expect(
      host.descriptor({ ...principal, tenantId: '' }),
    ).rejects.toThrow(/access denied/i);
    expect(() => host.query({ ...principal, userId: '' }, oneRow)).toThrow(
      /access denied/i,
    );
    expect(() => host.query({ ...principal, tenantId: '' }, oneRow)).toThrow(
      /access denied/i,
    );
    await expect(
      host.drilldown(
        { ...principal, userId: '' },
        { id: 'missing', columnId: 'tax_minor' },
      ),
    ).rejects.toThrow(/access denied/i);
    await expect(
      host.drilldown(
        { ...principal, tenantId: '' },
        { id: 'missing', columnId: 'tax_minor' },
      ),
    ).rejects.toThrow(/access denied/i);
    const page = await host.query(principal, {
      version: 1,
      requestId: 'host-page',
      mode: 'rows',
      projection: ['id', 'tax_minor', 'row_kind'],
      page: { kind: 'offset', offset: 0, limit: 20 },
    });
    expect(page.rows.length).toBeGreaterThan(0);
    const id = String(
      page.rows.find((row) => row.row_kind === 'component')?.id,
    );
    await expect(
      host.drilldown(principal, { id, columnId: 'currency' }),
    ).rejects.toThrow(/not drilldown-capable/i);
    await expect(
      host.drilldown(
        { ...principal, tenantId: 'tenant-b' },
        { id, columnId: 'tax_minor' },
      ),
    ).rejects.toThrow(/unavailable/i);
    await expect(
      host.drilldown(principal, { id, columnId: 'tax_minor' }),
    ).resolves.toMatchObject({
      version: 1,
      selectedMeasure: { id: 'tax', label: 'Tax' },
      currency: 'CAD',
      contributors: expect.arrayContaining([
        expect.objectContaining({
          source: 'invoice',
          identity: expect.any(String),
          date: expect.any(String),
          values: expect.objectContaining({
            valueMinor: expect.any(Number),
            taxableMinor: expect.any(Number),
            taxMinor: expect.any(Number),
          }),
        }),
      ]),
    });
  });

  it('normalizes incomplete and diverged contributor evidence for the generic report host', () => {
    const presentation = presentTaxSummaryDrilldown({
      measure: 'tax',
      row: { currency: 'CAD' },
      contributors: [
        {
          source: 'invoice',
          valueMinor: 125,
          fact: {
            documentType: 'invoice',
            documentId: 'invoice-a',
            documentNumber: 'INV-001',
            partyId: 'customer-a',
            taxCodeId: 'gst',
            taxComponentId: 'gst',
            issueDate: '2026-09-01',
            taxableMinor: 2_500,
            taxMinor: 125,
          },
        },
      ],
      complete: false,
      pending: ['source-state-diverged', 'expense-source'],
    } as never);

    expect(presentation).toEqual({
      version: 1,
      selectedMeasure: { id: 'tax', label: 'Tax' },
      currency: 'CAD',
      contributors: [
        {
          id: 'invoice:invoice:invoice-a:gst:gst',
          source: 'invoice',
          identity: 'INV-001',
          date: '2026-09-01',
          party: 'customer-a',
          values: { valueMinor: 125, taxableMinor: 2_500, taxMinor: 125 },
        },
      ],
      complete: false,
      warnings: [
        expect.objectContaining({
          code: 'source-state-diverged',
          kind: 'drift',
        }),
        expect.objectContaining({ code: 'expense-source', kind: 'incomplete' }),
      ],
    });
  });

  it('materializes exact persisted A/B sales rows, DataTable descriptor, and a tenant-bound drilldown', async () => {
    const fixture = await withTenant({ tenantId: 'tenant-a' }, () =>
      seedInvoiceTaxReportFacts(db),
    );
    await withTenant({ tenantId: fixture.tenantId }, () =>
      activateV2(fixture.tenantId),
    );
    const expenses = {
      listReviewedTaxFacts: vi.fn().mockResolvedValue([]),
    };
    const ledgers = {
      listPostedMovements: vi
        .fn()
        .mockImplementation(({ accountIds }: { accountIds: string[] }) =>
          Promise.resolve(
            accountIds.map((accountId) => ({
              tenantId: fixture.tenantId,
              entryId: `entry-${accountId}`,
              accountId,
              currency: 'CAD',
              creditMinusDebit: accountId === 'gst-payable' ? 11_078 : 4_439,
            })),
          ),
        ),
    };
    const reports = await TaxSummaryReportCollection.create({ db });
    const result = await reports.refreshTaxSummary({
      tenantId: fixture.tenantId,
      from,
      to,
      expenseSource: expenses,
      ledgerSource: ledgers,
      expenseComponentMappings: [],
    });

    expect(result).toEqual({ rowCount: 5, complete: true });
    expect(expenses.listReviewedTaxFacts).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: fixture.tenantId,
        from: '2026-09-01',
        to: '2026-09-30',
        db: expect.anything(),
      }),
    );
    const rows = await withTenant({ tenantId: fixture.tenantId }, () =>
      reports.list({ where: { tenantId: fixture.tenantId } }),
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rowKind: 'component',
          taxComponentId: 'gst',
          taxableMinor: 221_549,
          taxMinor: 11_078,
          netTaxMinor: 11_078,
          documentCount: 2,
        }),
        expect.objectContaining({
          rowKind: 'component',
          taxComponentId: 'pst',
          taxableMinor: 63_406,
          taxMinor: 4_439,
          netTaxMinor: 4_439,
          documentCount: 2,
        }),
        expect.objectContaining({
          rowKind: 'kind',
          taxCodeKind: 'taxable',
          taxableMinor: 221_549,
          documentCount: 2,
        }),
        expect.objectContaining({
          rowKind: 'reconciliation',
          taxComponentId: 'gst',
          differenceMinor: 0,
        }),
      ]),
    );

    const gstRow = rows.find(
      (row) => row.rowKind === 'component' && row.taxComponentId === 'gst',
    );
    if (!gstRow?.id) throw new Error('Expected GST materialized report row.');
    const drilldown = await drilldownTaxSummaryInvoiceFacts(db, {
      tenantId: fixture.tenantId,
      reportId: gstRow.id,
    });
    expect(drilldown).toHaveLength(4);
    expect(drilldown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          documentId: fixture.invoiceAId,
          documentNumber: 'REPORT-A',
          partyId: fixture.partyAId,
          issueDate: from.toISOString(),
          taxableMinor: 81_000,
          taxMinor: 4_050,
        }),
      ]),
    );
    const gstReconciliation = rows.find(
      (row) => row.rowKind === 'reconciliation' && row.taxComponentId === 'gst',
    );
    if (!gstReconciliation?.id)
      throw new Error('Expected GST reconciliation report row.');
    await expect(
      drilldownTaxSummaryInvoiceFacts(db, {
        tenantId: fixture.tenantId,
        reportId: gstReconciliation.id,
      }),
    ).resolves.toHaveLength(4);
    await withTenant({ tenantId: 'tenant-b' }, () => activateV2('tenant-b'));
    await expect(
      drilldownTaxSummaryInvoiceFacts(db, {
        tenantId: 'tenant-b',
        reportId: gstRow.id,
      }),
    ).rejects.toThrow('not visible to this tenant');

    const descriptor = await buildTaxSummaryReportAdapterDescriptor();
    expect(descriptor.tenantScoped).toBe(true);
    expect(descriptor.dataTable.columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'period_from', valueFormat: 'datetime' }),
        expect.objectContaining({ id: 'net_tax_minor', valueFormat: 'money' }),
      ]),
    );
    const dataTableRows = await withTenant({ tenantId: fixture.tenantId }, () =>
      queryReportMaterializedRows(
        TaxSummaryReport,
        {
          version: 1,
          requestId: 'tax-summary-visible',
          mode: 'rows',
          projection: ['id', 'tax_component_id', 'taxable_minor'],
          page: { kind: 'offset', offset: 0, limit: 10 },
        },
        {
          db,
          collection: reports,
          adapter: TAX_SUMMARY_REPORT_ADAPTER,
          execution: 'visible',
        },
      ),
    );
    expect(dataTableRows).toMatchObject({
      execution: 'visible',
      rows: expect.arrayContaining([
        expect.objectContaining({
          tax_component_id: 'gst',
          taxable_minor: 221_549,
        }),
      ]),
      total: { kind: 'exact', value: 5 },
    });
  });

  it('negates a positive stored credit-note snapshot exactly once', async () => {
    const fixture = await withTenant({ tenantId: 'tenant-a' }, () =>
      seedInvoiceTaxReportFacts(db),
    );
    const creditId = await withTenant({ tenantId: fixture.tenantId }, () =>
      seedInvoiceTaxReportCredit(db, fixture),
    );
    await withTenant({ tenantId: fixture.tenantId }, () =>
      activateV2(fixture.tenantId),
    );
    const reports = await TaxSummaryReportCollection.create({ db });
    const result = await reports.refreshTaxSummary({
      tenantId: fixture.tenantId,
      from,
      to,
      expenseSource: { listReviewedTaxFacts: async () => [] },
      ledgerSource: {
        listPostedMovements: async ({ accountIds }) =>
          accountIds.map((accountId) => ({
            tenantId: fixture.tenantId,
            entryId: `credit-${accountId}`,
            accountId,
            currency: 'CAD',
            creditMinusDebit: accountId === 'gst-payable' ? 10_578 : 4_439,
          })),
      },
      expenseComponentMappings: [],
    });
    expect(result).toEqual({ rowCount: 5, complete: true });
    const rows = await withTenant({ tenantId: fixture.tenantId }, () =>
      reports.list({ where: { tenantId: fixture.tenantId } }),
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rowKind: 'component',
          taxComponentId: 'gst',
          taxableMinor: 211_549,
          taxMinor: 10_578,
        }),
        expect.objectContaining({
          rowKind: 'kind',
          taxCodeKind: 'taxable',
          taxableMinor: 211_549,
        }),
      ]),
    );
    const gst = rows.find(
      (row) => row.rowKind === 'component' && row.taxComponentId === 'gst',
    );
    if (!gst?.id) throw new Error('Expected GST report row.');
    await expect(
      drilldownTaxSummaryInvoiceFacts(db, {
        tenantId: fixture.tenantId,
        reportId: gst.id,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          documentId: creditId,
          documentKind: 'credit_note',
          taxableMinor: 10_000,
          taxMinor: 500,
        }),
      ]),
    );
  });

  it('selects only the requested component or reconciliation contributors and marks stale sources incomplete', async () => {
    const fixture = await withTenant({ tenantId: 'tenant-a' }, () =>
      seedInvoiceTaxReportFacts(db),
    );
    await withTenant({ tenantId: fixture.tenantId }, () =>
      activateV2(fixture.tenantId),
    );
    const expense = {
      tenantId: fixture.tenantId,
      expenseId: 'expense-gst',
      incurredOn: '2026-09-01',
      currency: 'CAD',
      commitmentId: null,
      commitmentLineId: null,
      financialBreakdown: {
        taxes: [{ code: 'GST', amount: 50, recoverableAmount: 50 }],
      },
    };
    const mapping = {
      tenantId: fixture.tenantId,
      expenseCode: 'GST',
      taxComponentId: 'gst',
      componentName: 'GST',
      liabilityAccountId: 'gst-payable',
    };
    const reports = await TaxSummaryReportCollection.create({ db });
    await reports.refreshTaxSummary({
      tenantId: fixture.tenantId,
      from,
      to,
      expenseSource: { listReviewedTaxFacts: async () => [expense] },
      ledgerSource: {
        listPostedMovements: async ({ accountIds }) =>
          accountIds.map((accountId) => ({
            tenantId: fixture.tenantId,
            entryId: `refresh-${accountId}`,
            accountId,
            currency: 'CAD',
            creditMinusDebit: accountId === 'gst-payable' ? 11_078 : 4_439,
          })),
      },
      expenseComponentMappings: [mapping],
    });
    const rows = await withTenant({ tenantId: fixture.tenantId }, () =>
      reports.list({ where: { tenantId: fixture.tenantId } }),
    );
    const gst = rows.find(
      (row) => row.rowKind === 'component' && row.taxComponentId === 'gst',
    );
    const reconciliation = rows.find(
      (row) => row.rowKind === 'reconciliation' && row.taxComponentId === 'gst',
    );
    if (!gst?.id || !reconciliation?.id)
      throw new Error('Expected GST report rows.');
    expect(gst).toMatchObject({
      recoverableMinor: 50,
      netTaxMinor: 11_028,
      complete: true,
    });

    const recoverable = await drilldownTaxSummaryContributors(db, {
      tenantId: fixture.tenantId,
      reportId: gst.id,
      measure: 'recoverable',
      expenseSource: {
        listReviewedTaxFacts: async () => [
          expense,
          { ...expense, tenantId: 'tenant-b', expenseId: 'foreign' },
          { ...expense, currency: 'USD', expenseId: 'usd' },
        ],
      },
      expenseComponentMappings: [mapping],
    });
    expect(recoverable).toMatchObject({ complete: true, pending: [] });
    expect(recoverable.contributors).toEqual([
      expect.objectContaining({
        source: 'expense',
        valueMinor: 50,
        expense: expect.objectContaining({ expenseId: 'expense-gst' }),
      }),
    ]);

    const drilldownSources = vi.fn(async (context) => {
      expect(context).toMatchObject({
        userId: 'user-a',
        tenantId: fixture.tenantId,
      });
      return {
        expenseSource: { listReviewedTaxFacts: async () => [expense] },
        ledgerSource: {
          listPostedMovements: async () => [
            {
              tenantId: fixture.tenantId,
              entryId: 'host-manual-gst',
              journalId: 'host-journal-manual',
              accountId: 'gst-payable',
              journalDate: from,
              journalNumber: 'JNL-host',
              sourceModule: 'manual',
              sourceRef: null,
              currency: 'CAD',
              debit: 0,
              credit: 11_078,
              creditMinusDebit: 11_078,
            },
          ],
        },
        expenseComponentMappings: [mapping],
      };
    });
    const host = createTaxSummaryMaterializedReportHost(db, {
      drilldownSources,
    });
    const principal = {
      userId: 'user-a',
      tenantId: fixture.tenantId,
      permissions: ['taxsummaryreports.read'],
    };
    await expect(
      host.drilldown(principal, {
        id: gst.id,
        columnId: 'recoverable_minor',
      }),
    ).resolves.toMatchObject({
      complete: true,
      contributors: [
        expect.objectContaining({
          source: 'expense',
          identity: 'expense-gst',
          values: expect.objectContaining({ valueMinor: 50 }),
        }),
      ],
    });
    await expect(
      host.drilldown(principal, {
        id: reconciliation.id,
        columnId: 'difference_minor',
      }),
    ).resolves.toMatchObject({
      complete: true,
      contributors: expect.arrayContaining([
        expect.objectContaining({
          source: 'ledger',
          identity: 'JNL-host',
          values: expect.objectContaining({ valueMinor: 11_078 }),
        }),
      ]),
    });
    expect(drilldownSources).toHaveBeenCalledTimes(2);
    await withTenant({ tenantId: 'tenant-b' }, () => activateV2('tenant-b'));
    await expect(
      host.drilldown(
        {
          userId: 'user-b',
          tenantId: 'tenant-b',
          permissions: ['taxsummaryreports.read'],
        },
        { id: gst.id, columnId: 'recoverable_minor' },
      ),
    ).rejects.toThrow(/unavailable/i);
    expect(drilldownSources).toHaveBeenCalledTimes(2);

    const collected = await drilldownTaxSummaryContributors(db, {
      tenantId: fixture.tenantId,
      reportId: gst.id,
      measure: 'tax',
    });
    expect(collected).toMatchObject({ complete: true, pending: [] });
    expect(collected.contributors).toHaveLength(4);
    expect(
      collected.contributors.reduce(
        (sum, contributor) => sum + contributor.valueMinor,
        0,
      ),
    ).toBe(11_078);

    const difference = await drilldownTaxSummaryContributors(db, {
      tenantId: fixture.tenantId,
      reportId: reconciliation.id,
      measure: 'difference',
      ledgerSource: {
        listPostedMovements: async () => [
          {
            tenantId: fixture.tenantId,
            entryId: 'manual-gst',
            journalId: 'journal-manual',
            accountId: 'gst-payable',
            journalDate: from,
            journalNumber: 'JNL-1',
            sourceModule: 'manual',
            sourceRef: null,
            currency: 'CAD',
            debit: 0,
            credit: 11_078,
            creditMinusDebit: 11_078,
          },
          {
            tenantId: fixture.tenantId,
            entryId: 'wrong-account',
            journalId: 'journal-other',
            accountId: 'other',
            journalDate: from,
            journalNumber: 'JNL-2',
            sourceModule: 'manual',
            sourceRef: null,
            currency: 'CAD',
            debit: 0,
            credit: 99,
            creditMinusDebit: 99,
          },
          {
            tenantId: fixture.tenantId,
            entryId: 'out-of-period',
            journalId: 'journal-old',
            accountId: 'gst-payable',
            journalDate: new Date('2026-08-31T23:59:59.999Z'),
            journalNumber: 'JNL-3',
            sourceModule: 'manual',
            sourceRef: null,
            currency: 'CAD',
            debit: 0,
            credit: 99,
            creditMinusDebit: 99,
          },
        ],
      },
    });
    expect(difference).toMatchObject({ complete: true, pending: [] });
    expect(difference.contributors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'ledger', valueMinor: 11_078 }),
        expect.objectContaining({ source: 'invoice', valueMinor: -4_050 }),
      ]),
    );
    expect(difference.contributors).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'ledger',
          movement: expect.objectContaining({ entryId: 'out-of-period' }),
        }),
      ]),
    );
    await expect(
      drilldownTaxSummaryContributors(db, {
        tenantId: fixture.tenantId,
        reportId: gst.id,
        measure: 'recoverable',
      }),
    ).resolves.toMatchObject({
      complete: false,
      pending: expect.arrayContaining(['expense-source']),
    });
    await expect(
      drilldownTaxSummaryContributors(db, {
        tenantId: fixture.tenantId,
        reportId: gst.id,
        measure: 'recoverable',
        expenseSource: {
          listReviewedTaxFacts: async () => [
            {
              ...expense,
              financialBreakdown: {
                taxes: [{ code: 'GST', amount: 51, recoverableAmount: 51 }],
              },
            },
          ],
        },
        expenseComponentMappings: [mapping],
      }),
    ).resolves.toMatchObject({
      complete: false,
      pending: expect.arrayContaining(['source-state-diverged']),
    });
    await expect(
      drilldownTaxSummaryContributors(db, {
        tenantId: fixture.tenantId,
        reportId: gst.id,
        measure: 'ledgerMovement',
      }),
    ).rejects.toThrow('not available for component rows');
  });

  it('persists null recoverable and net tax for an ambiguous linked purchase and expense', async () => {
    const tenantId = 'tenant-a';
    const result = aggregateTaxSummary({
      tenantId,
      from: from.toISOString(),
      to: to.toISOString(),
      facts: [
        {
          tenantId,
          documentType: 'contract',
          documentId: 'purchase-order-1',
          documentKind: 'contract',
          issueDate: '2026-09-10T00:00:00.000Z',
          status: 'sent',
          direction: 'purchase',
          currency: 'CAD',
          taxCodeId: 'gst',
          taxCodeKind: 'taxable',
          taxableMinor: 1_000,
          taxMinor: 50,
          recoverableMinor: 50,
          taxComponentId: 'gst',
          componentName: 'GST',
          liabilityAccountId: 'gst-payable',
          commitmentId: 'purchase-order-1',
          commitmentLineId: null,
        },
      ],
      expenses: [
        {
          tenantId,
          expenseId: 'expense-1',
          incurredOn: '2026-09-11T00:00:00.000Z',
          currency: 'CAD',
          commitmentId: 'purchase-order-1',
          commitmentLineId: 'purchase-line-1',
          financialBreakdown: {
            taxes: [{ code: 'GST', amount: 50, recoverableAmount: 50 }],
          },
        },
      ],
      expenseComponentMappings: [
        {
          tenantId,
          expenseCode: 'GST',
          taxComponentId: 'gst',
          componentName: 'GST',
          liabilityAccountId: 'gst-payable',
        },
      ],
      ledgerMovements: [],
    });
    expect(result.complete).toBe(false);
    expect(result.componentRows).toEqual([
      expect.objectContaining({
        taxComponentId: 'gst',
        inputTaxCreditMinor: null,
        netTaxMinor: null,
      }),
    ]);
    const rows = await materializeTaxSummaryRows(
      { tenantId, from, to },
      result,
    );
    const component = rows.find(
      (row) => row.rowKind === 'component' && row.taxComponentId === 'gst',
    );
    expect(component).toMatchObject({
      recoverableMinor: null,
      netTaxMinor: null,
      complete: false,
    });
    if (!component) throw new Error('Expected incomplete GST component row.');

    await withTenant({ tenantId }, () => activateV2(tenantId));
    const reports = await TaxSummaryReportCollection.create({ db });
    await withTenant({ tenantId }, () => reports.create(component));
    const persisted = await withTenant({ tenantId }, () =>
      reports.get({ id: component.id as string }, { cache: false }),
    );
    expect(persisted).toMatchObject({
      recoverableMinor: null,
      netTaxMinor: null,
      complete: false,
    });
  });

  it('reports a diverged purchase source instead of treating a materialized ITC as zero', async () => {
    const tenantId = 'tenant-a';
    await withTenant({ tenantId }, () => activateV2(tenantId));
    const aggregate = aggregateTaxSummary({
      tenantId,
      from: from.toISOString(),
      to: to.toISOString(),
      facts: [
        {
          tenantId,
          documentType: 'contract',
          documentId: 'purchase-1',
          documentKind: 'contract',
          issueDate: '2026-09-10T00:00:00.000Z',
          status: 'sent',
          direction: 'purchase',
          currency: 'CAD',
          taxCodeId: 'purchase-gst',
          taxCodeKind: 'taxable',
          taxableMinor: 1_000,
          taxMinor: 50,
          recoverableMinor: 50,
          taxComponentId: 'gst',
          componentName: 'GST',
          liabilityAccountId: 'gst-payable',
          commitmentId: null,
          commitmentLineId: null,
        },
      ],
      expenses: [],
      expenseComponentMappings: [],
      ledgerMovements: [],
    });
    expect(aggregate.complete).toBe(true);
    const rows = await materializeTaxSummaryRows(
      { tenantId, from, to },
      aggregate,
    );
    const component = rows.find(
      (row) => row.rowKind === 'component' && row.taxComponentId === 'gst',
    );
    if (!component?.id) throw new Error('Expected purchase component row.');
    const reports = await TaxSummaryReportCollection.create({ db });
    await withTenant({ tenantId }, () => reports.create(component));
    await expect(
      drilldownTaxSummaryContributors(db, {
        tenantId,
        reportId: component.id as string,
        measure: 'recoverable',
      }),
    ).resolves.toMatchObject({
      complete: false,
      pending: expect.arrayContaining(['source-state-diverged']),
      contributors: [],
    });
  });

  it('refuses missing owner adapters instead of presenting an incomplete total', async () => {
    const reports = await TaxSummaryReportCollection.create({ db });
    await withTenant({ tenantId: 'tenant-a' }, () => activateV2('tenant-a'));
    await expect(
      reports.refreshTaxSummary({
        tenantId: 'tenant-a',
        from,
        to,
        expenseSource: undefined as never,
        ledgerSource: { listPostedMovements: async () => [] },
        expenseComponentMappings: [],
      }),
    ).rejects.toThrow('explicit expense and ledger source adapters');
  });

  it('materializes an unknown nullable tax-code kind as an incomplete warning', async () => {
    const fixture = await withTenant({ tenantId: 'tenant-a' }, () =>
      seedInvoiceTaxReportFacts(db),
    );
    await withTenant({ tenantId: fixture.tenantId }, async () => {
      const taxes = await DocumentTaxCollection.create({ db });
      await taxes.replaceDerivedForDocument(DOCUMENT_MONEY_WRITE, {
        tenantId: fixture.tenantId,
        documentType: 'invoice',
        documentId: fixture.invoiceAId,
        rows: [
          {
            tenantId: fixture.tenantId,
            documentType: 'invoice',
            documentId: fixture.invoiceAId,
            currency: 'CAD',
            taxCodeId: null,
            taxCodeCode: null,
            kind: null,
            taxComponentId: null,
            taxComponentName: null,
            percent: null,
            liabilityAccountId: null,
            taxableMinor: 1,
            taxMinor: 0,
            recoverableMinor: 0,
          },
        ],
      });
      await activateV2(fixture.tenantId);
    });
    const reports = await TaxSummaryReportCollection.create({ db });
    const result = await reports.refreshTaxSummary({
      tenantId: fixture.tenantId,
      from,
      to,
      expenseSource: { listReviewedTaxFacts: async () => [] },
      ledgerSource: { listPostedMovements: async () => [] },
      expenseComponentMappings: [],
    });
    expect(result.complete).toBe(false);
    const rows = await withTenant({ tenantId: fixture.tenantId }, () =>
      reports.list({ where: { tenantId: fixture.tenantId } }),
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rowKind: 'warning',
          warningCode: 'unassigned-tax-code',
          warningSourceType: 'document',
          warningSourceId: JSON.stringify(['invoice', fixture.invoiceAId]),
          taxCodeKind: null,
          complete: false,
        }),
      ]),
    );
    const warning = rows.find(
      (row) => row.warningCode === 'unassigned-tax-code',
    );
    if (!warning?.id) throw new Error('Expected unassigned tax warning row.');
    await expect(
      drilldownTaxSummaryContributors(db, {
        tenantId: fixture.tenantId,
        reportId: warning.id,
        measure: 'warning',
      }),
    ).resolves.toMatchObject({
      complete: false,
      pending: expect.arrayContaining(['materialized-incomplete']),
      contributors: [
        expect.objectContaining({
          source: 'invoice',
          fact: expect.objectContaining({ documentId: fixture.invoiceAId }),
        }),
      ],
    });
    expect(rows).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rowKind: 'kind',
          taxCodeKind: 'out-of-scope',
        }),
      ]),
    );
  });
});
