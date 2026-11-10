import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { expect } from 'vitest';
import { ContractCollection } from '../../collections/ContractCollection.js';
import { ContractLineItemCollection } from '../../collections/ContractLineItemCollection.js';
import { DocumentTaxCollection } from '../../collections/DocumentTaxCollection.js';
import { PurchaseContractCollection } from '../../collections/PurchaseContractCollection.js';
import { TaxCodeCollection } from '../../collections/TaxCodeCollection.js';
import { TaxComponentCollection } from '../../collections/TaxComponentCollection.js';
import { VendorCollection } from '../../collections/VendorCollection.js';
import {
  getReceivedPurchaseMoney,
  type ReceivedPurchaseMoneyFacts,
  ReceivedPurchaseTaxClassificationRequired,
  recordReceivedPurchaseMoney,
} from '../../received-purchase-money.js';
import { aggregateTaxSummary } from '../../tax-summary.js';
import { ContractStatus } from '../../types/index.js';

export const receivedFacts: ReceivedPurchaseMoneyFacts = {
  currency: 'CAD',
  netMinor: 10000,
  taxMinor: 537,
  grossMinor: 10537,
  taxComponents: null,
  detail: { kind: 'header-only' },
};

/** Native command, aggregate, tenant, report and rollback acceptance shared by SQLite/PostgreSQL. */
export async function proveReceivedPurchaseMoney(
  db: DatabaseInterface,
): Promise<void> {
  const tenantId = randomUUID();
  let quoteId = '';
  await withTenant({ tenantId }, async () => {
    const vendors = await VendorCollection.create({ db });
    const vendor = await vendors.create({ name: 'Received supplier' });
    const purchases = await PurchaseContractCollection.create({ db });
    const contracts = await ContractCollection.create({ db });
    const lines = await ContractLineItemCollection.create({ db });
    const quote = await purchases.create({
      _meta_type: '@happyvertical/smrt-commerce:SupplierQuote',
      vendorId: vendor.id,
      currency: 'CAD',
      reference: 'SQ-1',
      issueDate: new Date('2026-10-01T00:00:00Z'),
    });
    quoteId = quote.id!;
    const input = {
      db,
      tenantId,
      contractId: quoteId,
      requestId: 'receive-1',
      evidenceRef: 'source:revision-1',
      facts: receivedFacts,
    };
    const snapshot = await recordReceivedPurchaseMoney(input);
    expect(snapshot).toMatchObject({
      version: 1,
      facts: receivedFacts,
      sourceQuote: null,
    });
    expect(await recordReceivedPurchaseMoney(input)).toEqual(snapshot);
    await expect(
      recordReceivedPurchaseMoney({ ...input, requestId: 'changed' }),
    ).rejects.toThrow('request changed');
    await expect(
      recordReceivedPurchaseMoney({
        ...input,
        facts: { ...receivedFacts, netMinor: 9999, grossMinor: 10536 },
      }),
    ).rejects.toThrow('request changed');
    const loaded = (await contracts.get({ id: quoteId }, { cache: false }))!;
    expect(loaded).toMatchObject({
      subtotal: 10000,
      taxAmount: 537,
      totalAmount: 10537,
      moneyAuthority: 'received',
    });
    expect(getReceivedPurchaseMoney(loaded)).toEqual(snapshot);
    await expect(
      lines.create({
        contractId: quoteId,
        description: 'Invented',
        quantity: 1,
        unitPrice: 10000,
      }),
    ).rejects.toThrow('calculated lines');
    loaded.totalAmount = 10538;
    await expect(loaded.save()).rejects.toThrow('frozen');
    loaded.totalAmount = 10537;
    loaded.status = ContractStatus.ACCEPTED;
    await loaded.save();
    expect(loaded.moneySnapshotId).toBeTruthy();
    expect(await recordReceivedPurchaseMoney(input)).toEqual(snapshot);
    await expect(loaded.delete()).rejects.toThrow('cannot be deleted');
    const frozen = (await contracts.get({ id: quoteId }, { cache: false }))!;
    frozen.receivedPurchaseMoneyJson = '{}';
    await expect(frozen.save()).rejects.toThrow('frozen');
    const changedMode = (await contracts.get(
      { id: quoteId },
      { cache: false },
    ))!;
    changedMode.moneyAuthority = 'calculated';
    changedMode.receivedPurchaseMoneyJson = '';
    await expect(changedMode.save()).rejects.toThrow('frozen');
    await expect(
      purchases.create({
        _meta_type: '@happyvertical/smrt-commerce:SupplierQuote',
        vendorId: vendor.id,
        currency: 'CAD',
        moneyAuthority: 'received',
        receivedPurchaseMoneyJson: JSON.stringify(snapshot),
      }),
    ).rejects.toThrow('recordReceivedPurchaseMoney');

    const tax = await DocumentTaxCollection.create({ db });
    const report = {
      tenantId,
      from: new Date('2026-10-01'),
      to: new Date('2026-10-31'),
      currency: 'CAD',
    };
    expect(await tax.listReportFacts(report)).toEqual([]);
    const order = await purchases.create({
      _meta_type: '@happyvertical/smrt-commerce:PurchaseOrder',
      vendorId: vendor.id,
      currency: 'CAD',
      reference: 'PO-1',
      issueDate: new Date('2026-10-01T00:00:00Z'),
    });
    const orderInput = {
      ...input,
      contractId: order.id!,
      requestId: 'award-1',
      evidenceRef: 'approved-award:1',
      sourceQuote: { contractId: quoteId, relationship: 'copy' as const },
    };
    await recordReceivedPurchaseMoney(orderInput);
    const awarded = (await contracts.get({ id: order.id! }, { cache: false }))!;
    awarded.status = ContractStatus.ACCEPTED;
    await awarded.save();
    expect(awarded.totalAmount).toBe(10537);
    await expect(tax.listReportFacts(report)).rejects.toBeInstanceOf(
      ReceivedPurchaseTaxClassificationRequired,
    );
    await expect(tax.listReportFacts(report)).rejects.toThrow(order.id!);
    expect(await tax.listReportFacts({ ...report, currency: 'USD' })).toEqual(
      [],
    );
    expect(
      await tax.listReportFacts({
        ...report,
        from: new Date('2026-11-01'),
        to: new Date('2026-11-30'),
      }),
    ).toEqual([]);

    const negotiated = await purchases.create({
      _meta_type: '@happyvertical/smrt-commerce:PurchaseOrder',
      vendorId: vendor.id,
      currency: 'CAD',
    });
    const negotiatedInput = {
      ...orderInput,
      contractId: negotiated.id!,
      requestId: 'award-negotiated',
      facts: { ...receivedFacts, netMinor: 9000, grossMinor: 9537 },
    };
    await expect(recordReceivedPurchaseMoney(negotiatedInput)).rejects.toThrow(
      'match exactly',
    );
    await recordReceivedPurchaseMoney({
      ...negotiatedInput,
      sourceQuote: { contractId: quoteId, relationship: 'negotiated' },
    });
    expect(
      (await contracts.get({ id: negotiated.id! }, { cache: false }))
        ?.totalAmount,
    ).toBe(9537);

    const component = await (
      await TaxComponentCollection.create({ db })
    ).create({
      name: 'Explicit supplier component',
      percent: '7',
      recoverable: false,
    });
    if (!component.id) throw new Error('Tax component identity missing');
    const code = await (await TaxCodeCollection.create({ db })).create({
      code: 'supplier-received',
      name: 'Explicit supplier tax code',
      components: [{ taxComponentId: component.id, compound: false }],
    });
    const known = await purchases.create({
      _meta_type: '@happyvertical/smrt-commerce:PurchaseOrder',
      vendorId: vendor.id,
      currency: 'CAD',
      issueDate: new Date('2026-12-01T00:00:00Z'),
    });
    await recordReceivedPurchaseMoney({
      ...input,
      contractId: known.id!,
      requestId: 'known',
      facts: {
        ...receivedFacts,
        taxComponents: [
          {
            sourceKey: 'supplier-tax',
            label: 'Supplier component',
            amountMinor: 537,
            classification: 'taxable',
            taxableMinor: 10500,
            netMinor: 10000,
            taxCodeId: code.id,
            taxComponentId: component.id!,
            recoverableMinor: 123,
          },
        ],
      },
    });
    const knownLoaded = (await contracts.get(
      { id: known.id! },
      { cache: false },
    ))!;
    knownLoaded.status = ContractStatus.ACCEPTED;
    await knownLoaded.save();
    const knownFacts = await tax.listReportFacts({
      ...report,
      from: new Date('2026-12-01'),
      to: new Date('2026-12-31'),
    });
    expect(knownFacts).toEqual([
      expect.objectContaining({
        documentId: known.id,
        taxMinor: 537,
        taxableMinor: 10500,
        netMinor: 10000,
        recoverableMinor: 123,
        taxComponentId: component.id,
      }),
    ]);
    const summary = aggregateTaxSummary({
      tenantId,
      from: '2026-12-01',
      to: '2026-12-31',
      facts: knownFacts,
      expenses: [],
      expenseComponentMappings: [],
      ledgerMovements: [],
    });
    expect(
      summary.warnings.some(
        (warning) => warning.code === 'unassigned-tax-code',
      ),
    ).toBe(false);
    expect(summary.kindRows[0].taxableMinor).toBe(10000);
    expect(summary.componentRows[0].taxableMinor).toBe(10500);
    const revisedComponent = await (
      await TaxComponentCollection.create({ db })
    ).create({
      name: 'Revised supplier component',
      percent: '8',
      recoverable: false,
    });
    if (!revisedComponent.id)
      throw new Error('Revised tax component identity missing');
    code.components = [
      { taxComponentId: revisedComponent.id, compound: false },
    ];
    await code.save();
    expect(
      await tax.listReportFacts({
        ...report,
        from: new Date('2026-12-01'),
        to: new Date('2026-12-31'),
      }),
    ).toEqual(knownFacts);
    expect(await tax.findByDocument(tenantId, 'contract', known.id!)).toEqual(
      [],
    );

    const rollback = await purchases.create({
      _meta_type: '@happyvertical/smrt-commerce:SupplierQuote',
      vendorId: vendor.id,
      currency: 'CAD',
    });
    if (!db.transaction) throw new Error('Transaction required');
    await expect(
      db.transaction(async (tx) => {
        await recordReceivedPurchaseMoney({
          ...input,
          db: tx,
          contractId: rollback.id!,
          requestId: 'rollback',
        });
        throw new Error('rollback received evidence');
      }),
    ).rejects.toThrow('rollback received evidence');
    expect(
      getReceivedPurchaseMoney(
        (await contracts.get({ id: rollback.id! }, { cache: false }))!,
      ),
    ).toBeNull();
    await recordReceivedPurchaseMoney({
      ...input,
      contractId: rollback.id!,
      requestId: 'rollback',
    });

    const complete = await purchases.create({
      _meta_type: '@happyvertical/smrt-commerce:SupplierQuote',
      vendorId: vendor.id,
      currency: 'CAD',
    });
    await recordReceivedPurchaseMoney({
      ...input,
      contractId: complete.id!,
      requestId: 'lines',
      facts: {
        ...receivedFacts,
        detail: {
          kind: 'lines',
          lines: [
            {
              sourceKey: '1',
              description: 'Actual supplier line',
              netMinor: 10000,
              taxMinor: 537,
              grossMinor: 10537,
              quantityText: '0.0100',
              unitRateText: '10.0050',
            },
          ],
        },
      },
    });
    expect(
      getReceivedPurchaseMoney(
        (await contracts.get({ id: complete.id! }, { cache: false }))!,
      )?.facts.detail,
    ).toMatchObject({
      kind: 'lines',
      lines: [{ quantityText: '0.0100', unitRateText: '10.0050' }],
    });
    expect(await lines.findByContract(complete.id!)).toEqual([]);
  });
  await withTenant({ tenantId: randomUUID() }, async () => {
    await expect(
      recordReceivedPurchaseMoney({
        db,
        tenantId,
        contractId: quoteId,
        requestId: 'receive-1',
        evidenceRef: 'source:revision-1',
        facts: receivedFacts,
      }),
    ).rejects.toThrow('active tenant');
    await expect(
      recordReceivedPurchaseMoney({
        db,
        tenantId: (await import('@happyvertical/smrt-tenancy')).getTenantId()!,
        contractId: quoteId,
        requestId: 'foreign',
        evidenceRef: 'foreign',
        facts: receivedFacts,
      }),
    ).rejects.toThrow('was not found in tenant');
  });
}

/** Two connections contend on the tenant/document lock; one fact revision wins. */
export async function proveReceivedPurchaseRaces(
  db: DatabaseInterface,
): Promise<void> {
  const tenantId = randomUUID();
  await withTenant({ tenantId }, async () => {
    const vendor = await (await VendorCollection.create({ db })).create({
      name: 'Race supplier',
    });
    const purchases = await PurchaseContractCollection.create({ db });
    const quote = await purchases.create({
      _meta_type: '@happyvertical/smrt-commerce:SupplierQuote',
      vendorId: vendor.id,
      currency: 'CAD',
    });
    if (!quote.id) throw new Error('Quote identity missing');
    const input = {
      db,
      tenantId,
      contractId: quote.id,
      requestId: 'race',
      evidenceRef: 'source:race',
      facts: receivedFacts,
    };
    const raced = await Promise.allSettled([
      recordReceivedPurchaseMoney(input),
      recordReceivedPurchaseMoney({
        ...input,
        facts: { ...receivedFacts, netMinor: 9999, grossMinor: 10536 },
      }),
    ]);
    expect(
      raced.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(raced.filter((result) => result.status === 'rejected')).toHaveLength(
      1,
    );
    const contracts = await ContractCollection.create({ db });
    const stored = await contracts.get({ id: quote.id }, { cache: false });
    if (!stored) throw new Error('Quote missing');
    const snapshot = getReceivedPurchaseMoney(stored);
    if (!snapshot) throw new Error('Received evidence missing');
    const replay = { ...input, facts: snapshot.facts };
    expect(
      await Promise.all([
        recordReceivedPurchaseMoney(replay),
        recordReceivedPurchaseMoney(replay),
      ]),
    ).toEqual([snapshot, snapshot]);
  });
}
