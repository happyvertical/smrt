import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { describe, expect, it } from 'vitest';
import { CustomerCollection } from '../collections/CustomerCollection.js';
import { DocumentTaxCollection } from '../collections/DocumentTaxCollection.js';
import { HistoricalSalesLineCollection } from '../collections/HistoricalSalesLineCollection.js';
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from '../collections/InvoiceLineItemCollection.js';
import { getInvoiceMoneyFacts } from '../document-money.js';
import {
  getHistoricalSalesMoney,
  readHistoricalSalesLines,
  recordHistoricalSalesMoney,
} from '../historical-sales-money.js';
import {
  HistoricalSalesTaxClassificationRequired,
  listHistoricalSalesHeaderFacts,
} from '../historical-sales-reports.js';
import type {
  HistoricalSalesMoneyFacts,
  HistoricalSalesSource,
} from '../historical-sales-types.js';
import { InvoiceStatus } from '../types/index.js';

const facts: HistoricalSalesMoneyFacts = {
  currency: 'CAD',
  kind: 'invoice',
  polarity: 'magnitudes',
  netMinor: 10000,
  taxMinor: 501,
  grossMinor: 10501,
  taxComponents: null,
  detail: { kind: 'header-only' },
};
const source: HistoricalSalesSource = {
  namespace: 'invented-originals',
  key: 'original-1',
  version: 'v1',
  issuedOn: '2020-02-29',
  dueOn: null,
  timeZone: 'America/Edmonton',
  approval: null,
};
describe('historical issued sales money on SQLite', () => {
  it('retains exact original headers, source/importer distinction and frozen source children without posting', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy();
    const tenantId = randomUUID();
    try {
      await withTenant({ tenantId }, async () => {
        const customer = await (await CustomerCollection.create({ db })).create(
          { name: 'Original customer' },
        );
        const invoices = await InvoiceCollection.create({ db });
        const invoice = await invoices.create({
          customerId: customer.id,
          currency: 'CAD',
          invoiceNumber: 'ORIGINAL-1',
        });
        const input = {
          db,
          tenantId,
          invoiceId: String(invoice.id),
          requestId: 'first-import',
          evidenceRef: 'original-source-hash',
          review: { actorId: 'importer-1', policyRef: 'reviewed-policy-v1' },
          source,
          facts,
        };
        const recorded = await recordHistoricalSalesMoney(input);
        expect(recorded).toMatchObject({
          snapshot: {
            source: { approval: null, dueOn: null },
            review: input.review,
            facts,
          },
          lines: [],
        });
        expect(
          await recordHistoricalSalesMoney({
            ...input,
            requestId: 'second-import',
            review: { ...input.review, actorId: 'importer-2' },
          }),
        ).toEqual(recorded);
        const loaded = await invoices.get({ id: invoice.id }, { cache: false });
        if (!loaded) throw new Error('Missing synthetic invoice fixture');
        expect(loaded).toMatchObject({
          moneyAuthority: 'historical',
          subtotal: 10000,
          taxAmount: 501,
          totalAmount: 10501,
          status: InvoiceStatus.SENT,
          amountPaid: 0,
          creditedAmount: 0,
          dueDate: null,
        });
        expect(loaded.isOverdue()).toBe(false);
        expect(loaded.sentAt).toBeNull();
        expect(loaded.arJournalId).toBeFalsy();
        expect(getHistoricalSalesMoney(loaded)).toEqual(recorded.snapshot);
        const scope = {
          tenantId,
          from: new Date('2020-01-01'),
          to: new Date('2020-12-31'),
          currency: 'CAD',
        };
        expect(await listHistoricalSalesHeaderFacts({ ...scope, db })).toEqual([
          expect.objectContaining({
            netMinor: 10000,
            taxMinor: 501,
            grossMinor: 10501,
            taxBreakdownKnown: false,
          }),
        ]);
        await expect(
          (await DocumentTaxCollection.create({ db })).listReportFacts(scope),
        ).rejects.toBeInstanceOf(HistoricalSalesTaxClassificationRequired);

        expect(
          (
            await getInvoiceMoneyFacts({
              db,
              tenantId,
              invoiceId: String(invoice.id),
            })
          ).historical,
        ).toEqual({ snapshot: recorded.snapshot, lines: [] });
        await expect(
          recordHistoricalSalesMoney({
            ...input,
            facts: { ...facts, taxMinor: 500, grossMinor: 10500 },
          }),
        ).rejects.toThrow('retry differs');
        loaded.subtotal = 9999;
        await expect(loaded.save()).rejects.toThrow();
        const changed = await invoices.get(
          { id: invoice.id },
          { cache: false },
        );
        if (!changed) throw new Error('Missing synthetic invoice fixture');
        changed.moneyAuthority = 'calculated';
        await expect(changed.save()).rejects.toThrow(
          'historical sales commands',
        );
        await expect(
          (await InvoiceLineItemCollection.create({ db })).create({
            invoiceId: invoice.id,
            description: 'Invented quantity',
            quantity: 1,
            unitPrice: 10000,
          }),
        ).rejects.toThrow('frozen');
        await expect(
          invoices.create({
            customerId: customer.id,
            currency: 'CAD',
            invoiceNumber: 'FORGED',
            moneyAuthority: 'historical',
            historicalSalesMoneyJson: JSON.stringify(recorded.snapshot),
          }),
        ).rejects.toThrow('historical sales commands');
        const duplicate = await invoices.create({
          customerId: customer.id,
          currency: 'CAD',
          invoiceNumber: 'DUPLICATE',
        });
        await expect(
          recordHistoricalSalesMoney({
            ...input,
            invoiceId: String(duplicate.id),
          }),
        ).rejects.toThrow('already belongs');
        const lineInvoice = await invoices.create({
          customerId: customer.id,
          currency: 'CAD',
          invoiceNumber: 'ORIGINAL-LINES',
        });
        const lineFacts: HistoricalSalesMoneyFacts = {
          ...facts,
          detail: {
            kind: 'lines',
            lines: [
              {
                sourceKey: 'line-1',
                creditedLineId: null,
                description: 'Positive original',
                netMinor: 11000,
                taxMinor: null,
                grossMinor: null,
                quantityText: null,
                unitRateText: null,
                sourceFields: { basis_amount: '110.00' },
              },
              {
                sourceKey: 'line-2',
                creditedLineId: null,
                description: 'Actual adjustment',
                netMinor: -1000,
                taxMinor: null,
                grossMinor: null,
                quantityText: null,
                unitRateText: null,
                sourceFields: { basis_amount: '-10.00' },
              },
            ],
          },
        };
        const withLines = await recordHistoricalSalesMoney({
          ...input,
          invoiceId: String(lineInvoice.id),
          source: { ...source, key: 'original-lines' },
          facts: lineFacts,
        });
        expect(withLines.lines).toHaveLength(2);
        expect(new Set(withLines.lines.map((line) => line.lineId)).size).toBe(
          2,
        );
        const parent = await invoices.get(
          { id: lineInvoice.id },
          { cache: false },
        );
        if (!parent) throw new Error('Missing synthetic invoice fixture');
        const children = await readHistoricalSalesLines(db, parent);
        expect(children.map((line) => line.netMinor)).toEqual([11000, -1000]);
        expect(
          children.every(
            (line) => line.quantityText === null && line.taxMinor === null,
          ),
        ).toBe(true);
        children[0].netMinor = 1;
        await expect(children[0].save()).rejects.toThrow(
          'public historical Commerce command',
        );
        await expect(children[0].delete()).rejects.toThrow('cannot be deleted');
        const rollbackInvoice = await invoices.create({
          customerId: customer.id,
          currency: 'CAD',
          invoiceNumber: 'ROLLBACK-SOURCE',
        });
        const trigger = `historical_fault_${randomUUID().replaceAll('-', '')}`;
        await db.query(
          `CREATE TRIGGER ${trigger} BEFORE INSERT ON historical_sales_lines WHEN NEW.invoice_id='${rollbackInvoice.id}' AND NEW.source_key='line-2' BEGIN SELECT RAISE(ABORT,'owned historical final insert rollback'); END`,
        );
        const rollbackInput = {
          ...input,
          invoiceId: String(rollbackInvoice.id),
          source: { ...source, key: 'rollback-original' },
          facts: lineFacts,
        };
        try {
          await expect(
            recordHistoricalSalesMoney(rollbackInput),
          ).rejects.toThrow('owned historical final insert rollback');
        } finally {
          await db.query(`DROP TRIGGER ${trigger}`);
        }
        const rolledBack = await invoices.get(
          { id: rollbackInvoice.id },
          { cache: false },
        );
        if (!rolledBack) throw new Error('Missing synthetic invoice fixture');
        expect(rolledBack).toMatchObject({
          moneyAuthority: 'calculated',
          totalAmount: 0,
          status: InvoiceStatus.DRAFT,
          historicalSalesMoneyJson: '',
        });
        expect(
          await (await HistoricalSalesLineCollection.create({ db })).list({
            where: { tenantId, invoiceId: rollbackInvoice.id },
            limit: 10,
          }),
        ).toHaveLength(0);
        expect(
          (await recordHistoricalSalesMoney(rollbackInput)).lines,
        ).toHaveLength(2);
        const credit = await invoices.create({
          customerId: customer.id,
          currency: 'CAD',
          invoiceNumber: 'ORIGINAL-CREDIT',
          kind: 'credit_note',
          creditedInvoiceId: invoice.id,
        });
        const creditFacts: HistoricalSalesMoneyFacts = {
          ...facts,
          kind: 'credit_note',
          polarity: 'signed',
          netMinor: -1000,
          taxMinor: -51,
          grossMinor: -1051,
        };
        const creditInput = {
          ...input,
          invoiceId: String(credit.id),
          source: { ...source, key: 'original-credit', issuedOn: '2020-03-01' },
          facts: creditFacts,
          creditedSource: {
            invoiceId: String(invoice.id),
            moneySnapshotId: recorded.moneySnapshotId,
          },
        };
        await recordHistoricalSalesMoney(creditInput);
        const credited = await invoices.get(
          { id: invoice.id },
          { cache: false },
        );
        if (!credited) throw new Error('Missing synthetic invoice fixture');
        expect(credited.creditedAmount).toBe(1051);
        expect(credited.getBalance()).toBe(9450);
        expect(
          (await recordHistoricalSalesMoney(creditInput)).snapshot.facts
            .netMinor,
        ).toBe(-1000);
        const originalAfter = await invoices.get(
          { id: invoice.id },
          { cache: false },
        );
        if (!originalAfter)
          throw new Error('Missing synthetic invoice fixture');
        expect(originalAfter.creditedAmount).toBe(1051);
        const badCredit = await invoices.create({
          customerId: customer.id,
          currency: 'CAD',
          invoiceNumber: 'TOO-MUCH-CREDIT',
          kind: 'credit_note',
          creditedInvoiceId: invoice.id,
        });
        await expect(
          recordHistoricalSalesMoney({
            ...creditInput,
            invoiceId: String(badCredit.id),
            source: { ...source, key: 'over-cap-credit' },
            facts: {
              ...creditFacts,
              netMinor: -10000,
              taxMinor: -501,
              grossMinor: -10501,
            },
          }),
        ).rejects.toThrow('remaining exact');
        expect(
          await (await HistoricalSalesLineCollection.create({ db })).list({
            where: { tenantId, invoiceId: lineInvoice.id },
            limit: 10,
          }),
        ).toHaveLength(2);
      });
    } finally {
      disableTenancy();
      await db.close?.();
    }
  });
});
