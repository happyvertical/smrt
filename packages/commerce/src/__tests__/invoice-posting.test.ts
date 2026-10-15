import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  AccountCollection,
  JournalCollection,
  JournalEntryCollection,
} from '@happyvertical/smrt-ledgers';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomerCollection } from '../collections/CustomerCollection.js';
import { DocumentTaxCollection } from '../collections/DocumentTaxCollection.js';
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from '../collections/InvoiceLineItemCollection.js';
import { TaxCodeCollection } from '../collections/TaxCodeCollection.js';
import { TaxComponentCollection } from '../collections/TaxComponentCollection.js';
import { TaxSettingsCollection } from '../collections/TaxSettingsCollection.js';
import { Invoice } from '../models/Invoice.js';
import { MoneyValidationError } from '../money.js';
import { ensureTenantTaxCodes } from '../tax/legacy.js';
import { InvoiceStatus } from '../types/index.js';

describe('money-v2 invoice posting integration (#3935)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    disableTenancy();
    await db.close?.();
  });

  async function seed(tenantId: string) {
    await ensureTenantTaxCodes(db, tenantId);
    return withTenant({ tenantId }, async () => {
      const accounts = await AccountCollection.create({ db });
      const createAccount = async (
        number: string,
        type: 'asset' | 'revenue' | 'liability',
      ) => {
        const account = await accounts.create({ number, name: number, type });
        account.tenantId = tenantId;
        await account.save();
        return account;
      };
      const ar = await createAccount('1100', 'asset');
      const fallbackRevenue = await createAccount('4000', 'revenue');
      const revenues = await Promise.all(
        ['4101', '4102', '4103', '4104'].map((number) =>
          createAccount(number, 'revenue'),
        ),
      );
      const gstAccount = await createAccount('2101', 'liability');
      const pstAccount = await createAccount('2102', 'liability');
      const fallbackTax = await createAccount('2199', 'liability');
      const components = await TaxComponentCollection.create({ db });
      const gst = await components.create({
        tenantId,
        name: 'GST',
        percent: '5',
        liabilityAccountId: gstAccount.id,
      });
      const pst = await components.create({
        tenantId,
        name: 'PST',
        percent: '7',
        liabilityAccountId: pstAccount.id,
      });
      const codes = await TaxCodeCollection.create({ db });
      const gstCode = await codes.create({
        code: 'gst',
        name: 'GST',
        components: [{ taxComponentId: gst.id, compound: false }],
      });
      const gstPstCode = await codes.create({
        code: 'gst-pst',
        name: 'GST + PST',
        components: [
          { taxComponentId: gst.id, compound: false },
          { taxComponentId: pst.id, compound: false },
        ],
      });
      const settings = await TaxSettingsCollection.create({ db });
      const current = await settings.getOrCreateForTenant(tenantId);
      current.defaultSalesTaxCodeId = gstCode.id;
      await current.save();
      // A clean tenant starts on money v2 (#4009); no migration needed.
      if ((await settings.getOrCreateForTenant(tenantId)).moneyModel !== 'v2')
        throw new Error('Expected a clean tenant on money v2');
      const customer = await (await CustomerCollection.create({ db })).create({
        defaultTaxCodeId: gstCode.id,
      });
      return {
        ar,
        fallbackRevenue,
        fallbackTax,
        revenues,
        gst,
        gstAccount,
        pstAccount,
        gstCode,
        gstPstCode,
        customer,
      };
    });
  }

  async function epicInvoice(
    tenantId: string,
    fixture: Awaited<ReturnType<typeof seed>>,
    lineAmountType: 'exclusive' | 'inclusive',
    taxRoundingScope: 'line' | 'document',
    suffix: string,
  ) {
    return withTenant({ tenantId }, async () => {
      const invoices = await InvoiceCollection.create({ db });
      const invoice = await invoices.create({
        customerId: fixture.customer.id,
        invoiceNumber: `EPIC-${suffix}`,
        currency: 'CAD',
      });
      invoice.lineAmountType = lineAmountType;
      invoice.taxRoundingScope = taxRoundingScope;
      await invoice.save();
      const lines = await InvoiceLineItemCollection.create({ db });
      const inputs = [
        {
          quantity: 10,
          unitPrice: 8500,
          discountType: 'percent' as const,
          discountRate: '10',
          taxCodeId: fixture.gstCode.id,
        },
        {
          quantity: 2,
          unitPrice: 4999,
          discountType: 'amount' as const,
          discount: 500,
          taxCodeId: fixture.gstPstCode.id,
        },
        {
          quantity: 12,
          unitPrice: 2000,
          discountType: 'none' as const,
          taxCodeId: fixture.gstPstCode.id,
        },
        {
          quantity: 1,
          unitPrice: 4500,
          discountType: 'none' as const,
          taxCodeId: fixture.gstCode.id,
        },
      ];
      const scenario = `${lineAmountType === 'exclusive' ? 1 : 2}${
        taxRoundingScope === 'line' ? 1 : 2
      }`;
      for (const [index, input] of inputs.entries()) {
        await lines.create({
          id: `00000000-0000-4000-8000-${scenario}${String(index + 1).padStart(10, '0')}`,
          invoiceId: invoice.id,
          description: `Epic line ${index + 1}`,
          taxMode: 'override',
          revenueAccountId: fixture.revenues[index]?.id,
          ...input,
        });
      }
      const stored = await invoices.get({ id: invoice.id }, { cache: false });
      if (!stored) throw new Error('Expected persisted invoice');
      stored.status = InvoiceStatus.SENT;
      stored.sentAt = new Date('2026-10-13T12:00:00.000Z');
      await stored.save();
      return stored;
    });
  }

  async function recognize(
    tenantId: string,
    fixture: Awaited<ReturnType<typeof seed>>,
    invoice: Invoice,
  ) {
    return withTenant({ tenantId }, () =>
      invoice.recognizeRevenue({
        arAccountId: fixture.ar.id,
        revenueAccountId: fixture.fallbackRevenue.id,
        taxAccountId: fixture.fallbackTax.id,
        bookCurrency: 'CAD',
      }),
    );
  }

  it('posts persisted epic A/B snapshots for both scopes without recalculation', async () => {
    const tenantId = randomUUID();
    const fixture = await seed(tenantId);
    for (const [mode, scope] of [
      ['exclusive', 'line'],
      ['exclusive', 'document'],
      ['inclusive', 'line'],
      ['inclusive', 'document'],
    ] as const) {
      const invoice = await epicInvoice(
        tenantId,
        fixture,
        mode,
        scope,
        `${mode}-${scope}`,
      );
      const lines = await withTenant({ tenantId }, () =>
        InvoiceLineItemCollection.create({ db }).then((rows) =>
          rows.findByInvoice(invoice.id),
        ),
      );
      const taxes = await withTenant({ tenantId }, () =>
        DocumentTaxCollection.create({ db }).then((rows) =>
          rows.findByDocument(tenantId, 'invoice', invoice.id),
        ),
      );
      if (mode === 'inclusive' && scope === 'document') {
        expect(lines[2]).toMatchObject({ taxAmount: 2572, amount: 24000 });
        expect(taxes.map((row) => row.taxMinor).sort((a, b) => a - b)).toEqual([
          1496, 2094, 3857,
        ]);
      }

      const snapshotBefore = JSON.stringify({
        invoice: [invoice.subtotal, invoice.taxAmount, invoice.totalAmount],
        lines: lines.map((line) => [line.amount, line.taxAmount]),
        taxes: taxes.map((tax) => [tax.taxableMinor, tax.taxMinor]),
      });
      if (mode === 'inclusive' && scope === 'document') {
        await withTenant({ tenantId }, async () => {
          const components = await TaxComponentCollection.create({ db });
          const liveGst = await components.get(
            { id: fixture.gst.id },
            { cache: false },
          );
          if (!liveGst) throw new Error('Expected live GST component');
          liveGst.liabilityAccountId = fixture.fallbackTax.id;
          await liveGst.save();
        });
      }
      const journal = await recognize(tenantId, fixture, invoice);
      if (!journal.id) throw new Error('Expected posted journal identity');
      const entries = await withTenant({ tenantId }, () =>
        JournalEntryCollection.create({ db }).then((rows) =>
          rows.findByJournal(journal.id),
        ),
      );
      expect(entries.every((entry) => entry.currency === 'CAD')).toBe(true);
      expect(entries.reduce((sum, row) => sum + row.debit, 0)).toBe(
        invoice.totalAmount,
      );
      expect(entries.reduce((sum, row) => sum + row.credit, 0)).toBe(
        invoice.totalAmount,
      );
      for (const [index, line] of lines.entries()) {
        expect(
          entries.find(
            (entry) => entry.accountId === fixture.revenues[index]?.id,
          )?.credit,
        ).toBe(
          mode === 'inclusive' ? line.amount - line.taxAmount : line.amount,
        );
      }
      expect(
        entries.find((entry) => entry.accountId === fixture.gstAccount.id)
          ?.credit,
      ).toBe(mode === 'exclusive' ? 5725 : scope === 'line' ? 5352 : 5353);
      expect(
        entries.find((entry) => entry.accountId === fixture.pstAccount.id)
          ?.credit,
      ).toBe(mode === 'exclusive' ? 2345 : 2094);
      const afterInvoice = await withTenant({ tenantId }, () =>
        InvoiceCollection.create({ db }).then((rows) =>
          rows.get({ id: invoice.id }, { cache: false }),
        ),
      );
      expect(
        JSON.stringify({
          invoice: [
            afterInvoice?.subtotal,
            afterInvoice?.taxAmount,
            afterInvoice?.totalAmount,
          ],
          lines: lines.map((line) => [line.amount, line.taxAmount]),
          taxes: taxes.map((tax) => [tax.taxableMinor, tax.taxMinor]),
        }),
      ).toBe(snapshotBefore);
    }
  });

  it('posts once on retry and reverses the exact original entries once', async () => {
    const tenantId = randomUUID();
    const fixture = await seed(tenantId);
    const invoice = await epicInvoice(
      tenantId,
      fixture,
      'inclusive',
      'document',
      'reversal',
    );
    const invoices = await InvoiceCollection.create({ db });
    const [racerA, racerB] = await withTenant({ tenantId }, async () => [
      await invoices.get({ id: invoice.id }, { cache: false }),
      await invoices.get({ id: invoice.id }, { cache: false }),
    ]);
    if (!racerA || !racerB) throw new Error('Expected posting racers');
    const [first, retry] = await Promise.all([
      recognize(tenantId, fixture, racerA),
      recognize(tenantId, fixture, racerB),
    ]);
    expect(retry.id).toBe(first.id);

    const loaded = await withTenant({ tenantId }, () =>
      InvoiceCollection.create({ db }).then((rows) =>
        rows.get({ id: invoice.id }, { cache: false }),
      ),
    );
    if (!loaded) throw new Error('Expected posted invoice');
    loaded.cancel();
    await expect(
      withTenant({ tenantId }, () => loaded.save()),
    ).rejects.toMatchObject({ code: 'FROZEN_DOCUMENT' });
    loaded.status = InvoiceStatus.SENT;

    const reversalSave = vi
      .spyOn(Invoice.prototype, 'saveDerived')
      .mockRejectedValueOnce(new Error('injected reversal link failure'));
    await expect(
      withTenant({ tenantId }, () =>
        loaded.cancelWithRevenueReversal({ bookCurrency: 'CAD' }),
      ),
    ).rejects.toThrow('injected reversal link failure');
    reversalSave.mockRestore();
    const afterFailedReversal = await withTenant({ tenantId }, () =>
      invoices.get({ id: invoice.id }, { cache: false }),
    );
    expect(afterFailedReversal).toMatchObject({
      status: InvoiceStatus.SENT,
      arJournalId: first.id,
    });
    expect(afterFailedReversal?.arReversalJournalId).toBeFalsy();
    expect(
      await withTenant({ tenantId }, () =>
        JournalCollection.create({ db }).then((rows) =>
          rows.list({ where: { sourceModule: 'smrt-commerce' } }),
        ),
      ),
    ).toHaveLength(1);

    const reversal = await withTenant({ tenantId }, () =>
      loaded.cancelWithRevenueReversal({ bookCurrency: 'CAD' }),
    );
    if (!reversal) throw new Error('Expected reversal');
    const reversalRetry = await withTenant({ tenantId }, () =>
      loaded.cancelWithRevenueReversal({ bookCurrency: 'CAD' }),
    );
    expect(reversalRetry?.id).toBe(reversal.id);

    const entries = await JournalEntryCollection.create({ db });
    if (!first.id || !reversal.id)
      throw new Error('Expected original and reversal identities');
    const originalRows = await withTenant({ tenantId }, () =>
      entries.findByJournal(first.id),
    );
    const reversalRows = await withTenant({ tenantId }, () =>
      entries.findByJournal(reversal.id),
    );
    expect(
      reversalRows.map((row) => [row.accountId, row.debit, row.credit]),
    ).toEqual(
      originalRows.map((row) => [row.accountId, row.credit, row.debit]),
    );
    expect(first.status).toBe('posted');
    expect(reversal.status).toBe('posted');
    const stored = await withTenant({ tenantId }, () =>
      InvoiceCollection.create({ db }).then((rows) =>
        rows.get({ id: invoice.id }, { cache: false }),
      ),
    );
    expect(stored).toMatchObject({
      status: InvoiceStatus.CANCELLED,
      arJournalId: first.id,
      arReversalJournalId: reversal.id,
      moneySnapshotId: invoice.moneySnapshotId,
    });
  });

  it('rejects currency/account violations and rolls back a failed link write', async () => {
    const tenantId = randomUUID();
    const fixture = await seed(tenantId);
    const invoice = await epicInvoice(
      tenantId,
      fixture,
      'exclusive',
      'line',
      'rollback',
    );
    await expect(
      withTenant({ tenantId }, () =>
        invoice.recognizeRevenue({
          arAccountId: fixture.ar.id,
          revenueAccountId: fixture.fallbackRevenue.id,
          taxAccountId: fixture.fallbackTax.id,
          bookCurrency: 'USD',
        }),
      ),
    ).rejects.toMatchObject({ code: 'CURRENCY_MISMATCH' });
    await expect(
      withTenant({ tenantId }, () =>
        invoice.recognizeRevenue({
          arAccountId: randomUUID(),
          revenueAccountId: fixture.fallbackRevenue.id,
          taxAccountId: fixture.fallbackTax.id,
          bookCurrency: 'CAD',
        }),
      ),
    ).rejects.toBeInstanceOf(MoneyValidationError);

    const foreignTenantId = randomUUID();
    const foreignAr = await withTenant(
      { tenantId: foreignTenantId },
      async () => {
        const account = await (await AccountCollection.create({ db })).create({
          number: '1199',
          name: 'Foreign AR',
          type: 'asset',
        });
        account.tenantId = foreignTenantId;
        await account.save();
        return account;
      },
    );
    await expect(
      withTenant({ tenantId }, () =>
        invoice.recognizeRevenue({
          arAccountId: foreignAr.id,
          revenueAccountId: fixture.fallbackRevenue.id,
          taxAccountId: fixture.fallbackTax.id,
          bookCurrency: 'CAD',
        }),
      ),
    ).rejects.toBeInstanceOf(MoneyValidationError);

    const firstRevenue = fixture.revenues[0];
    if (!firstRevenue) throw new Error('Expected first revenue account');
    firstRevenue.active = false;
    await withTenant({ tenantId }, () => firstRevenue.save());
    await expect(recognize(tenantId, fixture, invoice)).rejects.toBeInstanceOf(
      MoneyValidationError,
    );
    firstRevenue.active = true;
    await withTenant({ tenantId }, () => firstRevenue.save());

    const originalSave = Invoice.prototype.saveDerived;
    const saveSpy = vi
      .spyOn(Invoice.prototype, 'saveDerived')
      .mockImplementationOnce(async function (...args) {
        if (this.arJournalId) throw new Error('injected link failure');
        return originalSave.apply(this, args);
      });
    await expect(recognize(tenantId, fixture, invoice)).rejects.toThrow(
      'injected link failure',
    );
    saveSpy.mockRestore();
    const journals = await withTenant({ tenantId }, () =>
      JournalCollection.create({ db }).then((rows) =>
        rows.list({ where: { sourceModule: 'smrt-commerce' } }),
      ),
    );
    expect(journals).toHaveLength(0);
    const stored = await withTenant({ tenantId }, () =>
      InvoiceCollection.create({ db }).then((rows) =>
        rows.get({ id: invoice.id }, { cache: false }),
      ),
    );
    expect(stored?.arJournalId).toBeFalsy();
    expect(stored?.status).toBe(InvoiceStatus.SENT);
  });
});
