import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { ProductCollection } from '@happyvertical/smrt-products/collections';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { expect } from 'vitest';
import { ContractCollection } from '../../collections/ContractCollection.js';
import { ContractLineItemCollection } from '../../collections/ContractLineItemCollection.js';
import { CustomerCollection } from '../../collections/CustomerCollection.js';
import { InvoiceCollection } from '../../collections/InvoiceCollection.js';
import { TaxCodeCollection } from '../../collections/TaxCodeCollection.js';
import { TaxComponentCollection } from '../../collections/TaxComponentCollection.js';
import { TaxSettingsCollection } from '../../collections/TaxSettingsCollection.js';
import {
  convertEstimateToOrder,
  findOrderForEstimate,
} from '../../estimate-conversion.js';
import { Order } from '../../models/Contract.js';
import { MoneyValidationError } from '../../money.js';
import { withTenantMoneyRuntime } from '../../tenant-money-barrier.js';
import { ContractStatus, ContractType } from '../../types/index.js';

/** Public conversion commands exercised against native collections and the caller's executor. */
export async function proveEstimateConversion(
  db: DatabaseInterface,
): Promise<void> {
  const tenantId = randomUUID();
  await withTenant({ tenantId }, async () => {
    const customer = await (await CustomerCollection.create({ db })).create({
      name: 'Quoted customer',
    });
    const component = await (
      await TaxComponentCollection.create({ db })
    ).create({ name: 'GST', percent: '5' });
    const code = await (await TaxCodeCollection.create({ db })).create({
      code: 'gst',
      name: 'GST',
      components: [{ taxComponentId: component.id!, compound: false }],
    });
    const product = await (await ProductCollection.create({ db })).create({
      name: 'Discovery workshop',
    });
    const contracts = await ContractCollection.create({ db });
    const lines = await ContractLineItemCollection.create({ db });

    async function estimate(
      options: { status?: ContractStatus; withLines?: boolean } = {},
    ) {
      const created = await contracts.create({
        _meta_type: '@happyvertical/smrt-commerce:Estimate',
        customerId: customer.id!,
        currency: 'CAD',
        terms: 'Net 15',
        reference: 'Q-1',
        notes: 'Portal quote',
        channelId: 'portal',
      });
      if (options.withLines !== false) {
        await (
          await lines.create({
            contractId: created.id!,
            description: 'Discovery',
            quantity: 2,
            unitPrice: 5000,
            discount: 500,
            discountType: 'amount',
            taxMode: 'override',
            taxCodeId: code.id,
            productId: product.id!,
            sku: 'DISC',
            billingPeriod: 'once',
            sortOrder: 1,
          })
        ).save();
        await (
          await lines.create({
            contractId: created.id!,
            description: 'Build',
            quantity: 1,
            unitPrice: 20000,
            taxMode: 'override',
            taxCodeId: code.id,
            sortOrder: 2,
          })
        ).save();
      }
      const loaded = (await contracts.get(
        { id: created.id! },
        { cache: false },
      ))!;
      const status = options.status ?? ContractStatus.ACCEPTED;
      if (status !== ContractStatus.DRAFT) {
        loaded.status = status;
        await loaded.save();
      }
      return (await contracts.get({ id: created.id! }, { cache: false }))!;
    }
    const input = (estimateId: string, requestId = 'convert-1') => ({
      db,
      tenantId,
      estimateId,
      requestId,
      acceptanceEvidenceRef: 'portal-accept:1',
    });

    // Happy path: copied lines, equal totals, lineage, no invoice.
    const quote = await estimate();
    expect(quote.totalAmount).toBe(30975);
    const converted = await convertEstimateToOrder(input(quote.id!));
    expect(converted).toEqual({
      orderId: expect.any(String),
      estimateId: quote.id,
      requestId: 'convert-1',
    });
    const order = (await contracts.get(
      { id: converted.orderId },
      { cache: false },
    )) as Order;
    expect(order).toBeInstanceOf(Order);
    expect(order).toMatchObject({
      status: ContractStatus.ACCEPTED,
      customerId: customer.id,
      currency: 'CAD',
      terms: 'Net 15',
      reference: 'Q-1',
      notes: 'Portal quote',
      channelId: 'portal',
      subtotal: quote.subtotal,
      taxAmount: quote.taxAmount,
      totalAmount: quote.totalAmount,
      sourceEstimateId: quote.id,
      conversionRequestId: 'convert-1',
      acceptanceEvidenceRef: 'portal-accept:1',
    });
    expect(order.moneySnapshotId).toBeTruthy();
    expect(order.moneySnapshotId).not.toBe(quote.moneySnapshotId);
    const copied = await lines.findByContract(converted.orderId);
    expect(copied).toHaveLength(2);
    expect(copied[0]).toMatchObject({
      description: 'Discovery',
      quantity: 2,
      unitPrice: 5000,
      discount: 500,
      discountType: 'amount',
      taxMode: 'override',
      taxCodeId: code.id,
      productId: product.id!,
      sku: 'DISC',
      billingPeriod: 'once',
      sortOrder: 1,
    });
    expect(copied[1]).toMatchObject({ description: 'Build', sortOrder: 2 });
    expect(
      await (await InvoiceCollection.create({ db })).findByContract(
        converted.orderId,
      ),
    ).toEqual([]);
    const untouched = (await contracts.get(
      { id: quote.id! },
      { cache: false },
    ))!;
    expect(untouched.totalAmount).toBe(quote.totalAmount);
    expect((await findOrderForEstimate(db, tenantId, quote.id!))?.id).toBe(
      converted.orderId,
    );

    // Replay and refusal vocabulary.
    expect(await convertEstimateToOrder(input(quote.id!))).toEqual(converted);
    await expect(
      convertEstimateToOrder({
        ...input(quote.id!),
        acceptanceEvidenceRef: 'portal-accept:2',
      }),
    ).rejects.toThrow('request changed');
    await expect(
      convertEstimateToOrder(input(quote.id!, 'convert-2')),
    ).rejects.toThrow('already converted');
    const other = await estimate();
    await expect(
      convertEstimateToOrder(input(other.id!, 'convert-1')),
    ).rejects.toThrow('already used');
    expect(await findOrderForEstimate(db, tenantId, other.id!)).toBeNull();
    expect((await lines.findByContract(converted.orderId)).length).toBe(2);

    // Lineage is written only by the command and immutable afterwards.
    for (const field of [
      'sourceEstimateId',
      'conversionRequestId',
      'acceptanceEvidenceRef',
    ] as const) {
      const tampered = (await contracts.get(
        { id: converted.orderId },
        { cache: false },
      )) as Order;
      tampered[field] = '';
      await expect(tampered.save()).rejects.toThrow('immutable');
      tampered[field] = 'forged';
      await expect(tampered.save()).rejects.toThrow('immutable');
    }
    const retyped = (await contracts.get(
      { id: converted.orderId },
      { cache: false },
    )) as Order;
    retyped.contractType = ContractType.LEASE;
    await expect(retyped.save()).rejects.toThrow('immutable');
    await expect(
      (
        (await contracts.get(
          { id: converted.orderId },
          { cache: false },
        )) as Order
      ).delete(),
    ).rejects.toThrow('cannot be deleted');
    expect(await findOrderForEstimate(db, tenantId, quote.id!)).not.toBeNull();
    await expect(
      contracts.create({
        _meta_type: '@happyvertical/smrt-commerce:Order',
        customerId: customer.id!,
        sourceEstimateId: quote.id!,
      }),
    ).rejects.toThrow('immutable');
    expect(await convertEstimateToOrder(input(quote.id!))).toEqual(converted);

    // Ineligible Estimates.
    for (const bad of [
      await estimate({ status: ContractStatus.DRAFT }),
      await estimate({ status: ContractStatus.SENT }),
    ])
      await expect(
        convertEstimateToOrder(input(bad.id!, `bad-${bad.id}`)),
      ).rejects.toBeInstanceOf(MoneyValidationError);
    await expect(
      convertEstimateToOrder(input(converted.orderId, 'order-as-source')),
    ).rejects.toThrow('not found');
    await expect(
      convertEstimateToOrder(input(randomUUID(), 'missing')),
    ).rejects.toThrow('not found');
    await expect(
      convertEstimateToOrder({ ...input(quote.id!), requestId: ' ' }),
    ).rejects.toThrow('Request');

    // Transaction rollback leaves no Order behind.
    const rolled = await estimate();
    if (!db.transaction) throw new Error('Transaction required');
    await expect(
      db.transaction(async (tx) => {
        await convertEstimateToOrder({
          ...input(rolled.id!, 'rolled'),
          db: tx,
        });
        throw new Error('parent rollback');
      }),
    ).rejects.toThrow('parent rollback');
    expect(await findOrderForEstimate(db, tenantId, rolled.id!)).toBeNull();
    const again = await convertEstimateToOrder(input(rolled.id!, 'rolled'));
    expect(again.orderId).not.toBe(converted.orderId);

    // Totals mismatch (tax default changed since the quote froze) rolls back.
    const settings = await (
      await TaxSettingsCollection.create({ db })
    ).getOrCreateForTenant(tenantId);
    settings.defaultSalesTaxCodeId = code.id!;
    await settings.save();
    const drifting = await estimate({
      withLines: false,
      status: ContractStatus.DRAFT,
    });
    await (
      await lines.create({
        contractId: drifting.id!,
        description: 'Inherits default tax',
        unitPrice: 10000,
      })
    ).save();
    const driftingLoaded = (await contracts.get(
      { id: drifting.id! },
      { cache: false },
    ))!;
    driftingLoaded.status = ContractStatus.ACCEPTED;
    await driftingLoaded.save();
    const wider = await (await TaxComponentCollection.create({ db })).create({
      name: 'PST',
      percent: '7',
    });
    const widerCode = await (await TaxCodeCollection.create({ db })).create({
      code: 'pst',
      name: 'PST',
      components: [{ taxComponentId: wider.id!, compound: false }],
    });
    settings.defaultSalesTaxCodeId = widerCode.id!;
    await settings.save();
    await expect(
      convertEstimateToOrder(input(drifting.id!, 'drift')),
    ).rejects.toThrow('totals differ');
    expect(await findOrderForEstimate(db, tenantId, drifting.id!)).toBeNull();

    // A caller that swallows the failure inside its own money runtime keeps no
    // Order: the command rolls back to its own savepoint. Some adapters also
    // fail the enclosing transaction; either way nothing survives.
    await withTenantMoneyRuntime(db, tenantId, async ({ db: tx }) => {
      try {
        await convertEstimateToOrder({
          ...input(drifting.id!, 'drift-2'),
          db: tx,
        });
        throw new Error('drifted conversion must not succeed');
      } catch (error) {
        expect(error).toBeInstanceOf(MoneyValidationError);
      }
    }).catch((error: unknown) => {
      expect(error).toBeInstanceOf(MoneyValidationError);
    });
    expect(await findOrderForEstimate(db, tenantId, drifting.id!)).toBeNull();
    await expect(
      convertEstimateToOrder(input(drifting.id!, 'drift-2')),
    ).rejects.toThrow('totals differ');
    expect(await findOrderForEstimate(db, tenantId, drifting.id!)).toBeNull();
  });

  // Cross-tenant: another tenant cannot convert or see the Estimate.
  const foreign = randomUUID();
  const sourceEstimateId = await withTenant({ tenantId }, async () => {
    const customer = await (await CustomerCollection.create({ db })).create({
      name: 'Other',
    });
    const created = await (await ContractCollection.create({ db })).create({
      _meta_type: '@happyvertical/smrt-commerce:Estimate',
      customerId: customer.id!,
    });
    await (await ContractLineItemCollection.create({ db }))
      .create({ contractId: created.id!, description: 'x', unitPrice: 100 })
      .then((line) => line.save());
    const loaded = (await (
      await ContractCollection.create({ db })
    ).get({ id: created.id! }, { cache: false }))!;
    loaded.status = ContractStatus.ACCEPTED;
    await loaded.save();
    return created.id!;
  });
  await withTenant({ tenantId: foreign }, async () => {
    await expect(
      convertEstimateToOrder({
        db,
        tenantId: foreign,
        estimateId: sourceEstimateId,
        requestId: 'cross',
        acceptanceEvidenceRef: 'e',
      }),
    ).rejects.toThrow('not found');
    expect(
      await findOrderForEstimate(db, foreign, sourceEstimateId),
    ).toBeNull();
  });
  await expect(
    convertEstimateToOrder({
      db,
      tenantId: foreign,
      estimateId: sourceEstimateId,
      requestId: 'no-context',
      acceptanceEvidenceRef: 'e',
    }),
  ).rejects.toThrow('active tenant');
}
