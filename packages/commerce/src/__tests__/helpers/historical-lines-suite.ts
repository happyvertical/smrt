import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { expect } from 'vitest';
import { CustomerCollection } from '../../collections/CustomerCollection.js';
import { DocumentTaxCollection } from '../../collections/DocumentTaxCollection.js';
import { HistoricalSalesLineCollection } from '../../collections/HistoricalSalesLineCollection.js';
import { InvoiceCollection } from '../../collections/InvoiceCollection.js';
import { TaxCodeCollection } from '../../collections/TaxCodeCollection.js';
import { TaxComponentCollection } from '../../collections/TaxComponentCollection.js';
import {
  readHistoricalSalesLines,
  recordHistoricalSalesMoney,
} from '../../historical-sales-money.js';

export async function proveHistoricalSourceChildren(db: DatabaseInterface) {
  const tenantId = randomUUID();
  await withTenant({ tenantId }, async () => {
    const customer = await (await CustomerCollection.create({ db })).create({
      name: 'Synthetic large source',
    });
    const invoices = await InvoiceCollection.create({ db });
    const draft = await invoices.create({
      customerId: String(customer.id),
      currency: 'CAD',
      invoiceNumber: 'LARGE-SOURCE',
    });
    const lines = Array.from({ length: 1110 }, (_, index) => ({
      creditedLineId: null,
      sourceKey: `source-line-${index}`,
      description: 'Actual retained source child',
      netMinor: 1,
      taxMinor: null,
      grossMinor: null,
      quantityText: null,
      unitRateText: null,
      sourceFields: { originalDescription: 'Retained exact source text' },
    }));
    const input = {
      db,
      tenantId,
      invoiceId: String(draft.id),
      requestId: 'large-source',
      evidenceRef: 'original-cohort-evidence',
      review: {
        actorId: 'import-recorder',
        policyRef: 'reviewed-source-policy',
      },
      source: {
        namespace: 'invented-source-children',
        key: 'large-source',
        version: 'v1',
        issuedOn: '2020-01-01',
        dueOn: null,
        timeZone: 'America/Edmonton',
        approval: null,
      },
      facts: {
        kind: 'invoice' as const,
        currency: 'CAD',
        polarity: 'magnitudes' as const,
        netMinor: 1110,
        taxMinor: 0,
        grossMinor: 1110,
        taxComponents: null,
        detail: { kind: 'lines' as const, lines },
      },
    };
    const recorded = await recordHistoricalSalesMoney(input);
    expect(recorded.lines).toHaveLength(1110);
    expect(new Set(recorded.lines.map((line) => line.lineId)).size).toBe(1110);
    const loaded = await invoices.get({ id: draft.id }, { cache: false });
    if (!loaded) throw new Error('Missing source invoice');
    const children = await readHistoricalSalesLines(db, loaded);
    expect(children).toHaveLength(1110);
    expect(
      children.every(
        (line) =>
          line.quantityText === null &&
          line.unitRateText === null &&
          line.taxMinor === null &&
          line.grossMinor === null,
      ),
    ).toBe(true);
    expect(
      (
        await recordHistoricalSalesMoney({
          ...input,
          requestId: 'recovered-run',
        })
      ).lines,
    ).toEqual(recorded.lines);
    await withTenant({ tenantId: randomUUID() }, async () => {
      expect(
        await (await HistoricalSalesLineCollection.create({ db })).list({
          where: { invoiceId: draft.id },
          limit: 2000,
        }),
      ).toHaveLength(0);
    });

    const originalLineId = recorded.lines[0]?.lineId;
    if (!originalLineId || !loaded.moneySnapshotId)
      throw new Error('Missing concrete original child');
    const sourceLine = lines.find(
      (line) => line.sourceKey === recorded.lines[0]?.sourceKey,
    );
    if (!sourceLine) throw new Error('Missing concrete original source key');
    const creditDraft = await invoices.create({
      customerId: String(customer.id),
      currency: 'CAD',
      invoiceNumber: 'SOURCE-LINE-CREDIT',
      kind: 'credit_note',
      creditedInvoiceId: String(draft.id),
    });
    const creditInput = {
      ...input,
      invoiceId: String(creditDraft.id),
      requestId: 'concrete-line-credit',
      source: {
        ...input.source,
        key: 'concrete-line-credit',
        issuedOn: '2020-03-01',
      },
      creditedSource: {
        invoiceId: String(draft.id),
        moneySnapshotId: loaded.moneySnapshotId,
      },
      facts: {
        ...input.facts,
        kind: 'credit_note' as const,
        netMinor: 2,
        grossMinor: 2,
        detail: {
          kind: 'lines' as const,
          lines: [
            {
              ...sourceLine,
              sourceKey: 'credit-part-1',
              creditedLineId: originalLineId,
            },
            {
              ...sourceLine,
              sourceKey: 'credit-part-2',
              creditedLineId: originalLineId,
            },
          ],
        },
      },
    };
    await expect(recordHistoricalSalesMoney(creditInput)).rejects.toThrow(
      /line.*capacity|remaining.*line/,
    );
    const credited = await recordHistoricalSalesMoney({
      ...creditInput,
      facts: {
        ...creditInput.facts,
        netMinor: 1,
        grossMinor: 1,
        detail: { kind: 'lines', lines: [creditInput.facts.detail.lines[0]] },
      },
    });
    expect(credited.lines).toHaveLength(1);
    const creditParent = await invoices.get(
      { id: creditDraft.id },
      { cache: false },
    );
    if (!creditParent) throw new Error('Missing concrete credit parent');
    expect(
      (await readHistoricalSalesLines(db, creditParent))[0]?.creditedLineId,
    ).toBe(originalLineId);
    const component = await (
      await TaxComponentCollection.create({ db })
    ).create({ name: 'Current reusable rate', percent: '7' });
    const code = await (await TaxCodeCollection.create({ db })).create({
      code: 'reviewed-original-classification',
      name: 'Reviewed original class',
      kind: 'taxable',
      components: [{ taxComponentId: String(component.id), compound: false }],
    });
    const classifiedDraft = await invoices.create({
      customerId: String(customer.id),
      currency: 'CAD',
      invoiceNumber: 'EXACT-TAX-SOURCE',
    });
    await recordHistoricalSalesMoney({
      ...input,
      invoiceId: String(classifiedDraft.id),
      requestId: 'known-tax',
      source: { ...input.source, key: 'known-tax', issuedOn: '2020-02-01' },
      facts: {
        ...input.facts,
        netMinor: 10000,
        taxMinor: 501,
        grossMinor: 10501,
        detail: { kind: 'header-only' },
        taxComponents: [
          {
            sourceKey: 'original-component',
            label: 'Original assessed tax',
            amountMinor: 501,
            classification: 'taxable',
            taxCodeId: String(code.id),
            taxComponentId: String(component.id),
            taxableMinor: 10000,
            netMinor: 10000,
            liabilityAccountId: null,
          },
        ],
      },
    });
    const report = await (
      await DocumentTaxCollection.create({ db })
    ).listReportFacts({
      tenantId,
      from: new Date('2020-02-01'),
      to: new Date('2020-02-02'),
      currency: 'CAD',
    });
    expect(report).toHaveLength(1);
    expect(report[0]).toMatchObject({
      taxableMinor: 10000,
      netMinor: 10000,
      taxMinor: 501,
      taxCodeId: code.id,
      taxComponentId: component.id,
    });
  });
}
