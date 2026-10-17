import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { expect } from 'vitest';
import { ContractCollection } from '../../collections/ContractCollection.js';
import { ContractLineItemCollection } from '../../collections/ContractLineItemCollection.js';
import { CustomerCollection } from '../../collections/CustomerCollection.js';
import { DocumentTaxCollection } from '../../collections/DocumentTaxCollection.js';
import { SalesContractCollection } from '../../collections/SalesContractCollection.js';
import {
  getReceivedSalesContractMoney,
  recordReceivedPurchaseMoney,
  recordReceivedSalesContractMoney,
} from '../../received-purchase-money.js';
import { ContractStatus } from '../../types/index.js';
export async function proveReceivedSalesContractMoney(
  db: DatabaseInterface,
): Promise<void> {
  const tenantId = randomUUID();
  let foreignId = '';
  let contractId = '';
  await withTenant({ tenantId: randomUUID() }, async () => {
    foreignId = (
      await (
        await CustomerCollection.create({ db })
      ).create({ name: 'Other tenant' })
    ).id!;
  });
  await withTenant({ tenantId }, async () => {
    const customer = await (await CustomerCollection.create({ db })).create({
      name: 'Original customer',
    });
    const sales = await SalesContractCollection.create({ db }),
      contracts = await ContractCollection.create({ db });
    const create = (type = 'Agreement', customerId = customer.id!) =>
      sales.create({
        _meta_type: `@happyvertical/smrt-commerce:${type}`,
        customerId,
        currency: 'CAD',
        issueDate: new Date('2026-10-01T00:00:00Z'),
      });
    const contract = await create();
    contractId = contract.id!;
    const input = {
      db,
      tenantId,
      contractId,
      requestId: 'reviewed-completion',
      evidenceRef: 'reviewed:original:complete',
      facts: {
        currency: 'CAD',
        netMinor: 2001,
        taxMinor: 101,
        grossMinor: 2102,
        taxComponents: null,
        detail: { kind: 'header-only' as const },
      },
    };
    const recorded = await recordReceivedSalesContractMoney(input);
    expect(recorded.facts).toEqual(input.facts);
    expect(await recordReceivedSalesContractMoney(input)).toEqual(recorded);
    await expect(recordReceivedPurchaseMoney(input)).rejects.toThrow(
      'supplier quote or purchase order',
    );
    await expect(
      recordReceivedSalesContractMoney({ ...input, requestId: 'changed' }),
    ).rejects.toThrow('request changed');
    await expect(
      recordReceivedSalesContractMoney({
        ...input,
        facts: { ...input.facts, taxMinor: 100, grossMinor: 2101 },
      }),
    ).rejects.toThrow('request changed');
    const loaded = (await contracts.get({ id: contractId }, { cache: false }))!;
    expect(getReceivedSalesContractMoney(loaded)).toEqual(recorded);
    expect(loaded).toMatchObject({
      subtotal: 2001,
      taxAmount: 101,
      totalAmount: 2102,
      moneyAuthority: 'received',
    });
    loaded.totalAmount = 2103;
    await expect(loaded.save()).rejects.toThrow('frozen');
    loaded.totalAmount = 2102;
    loaded.status = ContractStatus.ACCEPTED;
    await loaded.save();
    expect(loaded.moneySnapshotId).toBeTruthy();
    expect(await recordReceivedSalesContractMoney(input)).toEqual(recorded);
    await expect(loaded.delete()).rejects.toThrow('cannot be deleted');
    const lines = await ContractLineItemCollection.create({ db });
    await expect(
      lines.create({
        contractId,
        description: 'Synthetic',
        quantity: 1,
        unitPrice: 2001,
      }),
    ).rejects.toThrow('calculated lines');
    expect(
      await (await DocumentTaxCollection.create({ db })).listReportFacts({
        tenantId,
        from: new Date('2026-10-01'),
        to: new Date('2026-10-31'),
        currency: 'CAD',
      }),
    ).toEqual([]);
    const order = await create('Order');
    expect(
      (
        await recordReceivedSalesContractMoney({
          ...input,
          contractId: order.id!,
          requestId: 'zero',
          facts: {
            ...input.facts,
            netMinor: 0,
            taxMinor: 0,
            grossMinor: 0,
            taxComponents: [],
          },
        })
      ).facts.grossMinor,
    ).toBe(0);
    const replacement = await (await CustomerCollection.create({ db })).create({
      name: 'Replacement customer',
    });
    for (const original of [loaded, order]) {
      for (const status of [ContractStatus.DRAFT, ContractStatus.ACCEPTED]) {
        // The Agreement is already accepted; the Order proves the draft boundary too.
        if (original === loaded && status === ContractStatus.DRAFT) continue;
        const current = (await sales.get(
          { id: original.id! },
          { cache: false },
        ))!;
        current.status = status;
        await current.save();
        const snapshot = current.receivedPurchaseMoneyJson;
        const snapshotId = current.moneySnapshotId;
        current.customerId = replacement.id!;
        await expect(current.save()).rejects.toThrow('frozen');
        const retained = (await sales.get(
          { id: original.id! },
          { cache: false },
        ))!;
        expect(retained.customerId).toBe(customer.id);
        expect(retained.receivedPurchaseMoneyJson).toBe(snapshot);
        expect(retained.moneySnapshotId).toBe(snapshotId);
      }
    }
    const calculated = await create();
    await lines.create({
      contractId: calculated.id!,
      description: 'Real work',
      quantity: 2,
      unitPrice: 100,
    });
    await expect(
      recordReceivedSalesContractMoney({
        ...input,
        contractId: calculated.id!,
      }),
    ).rejects.toThrow('calculated contract lines');
    const foreign = await create('Agreement', foreignId);
    await expect(
      recordReceivedSalesContractMoney({ ...input, contractId: foreign.id! }),
    ).rejects.toThrow('Customer must belong');
    await expect(
      recordReceivedSalesContractMoney({
        ...input,
        sourceQuote: { contractId: 'no', relationship: 'copy' },
      } as typeof input),
    ).rejects.toThrow('supplier quote');
    const rollback = await create();
    await expect(
      db.transaction!(async (transaction) => {
        await recordReceivedSalesContractMoney({
          ...input,
          db: transaction,
          contractId: rollback.id!,
        });
        throw new Error('outer rollback');
      }),
    ).rejects.toThrow('outer rollback');
    expect(
      getReceivedSalesContractMoney(
        (await contracts.get({ id: rollback.id! }, { cache: false }))!,
      ),
    ).toBeNull();
  });
  await withTenant({ tenantId: randomUUID() }, async () => {
    await expect(
      recordReceivedSalesContractMoney({
        db,
        tenantId,
        contractId,
        requestId: 'reviewed-completion',
        evidenceRef: 'reviewed:original:complete',
        facts: {
          currency: 'CAD',
          netMinor: 2001,
          taxMinor: 101,
          grossMinor: 2102,
          taxComponents: null,
          detail: { kind: 'header-only' },
        },
      }),
    ).rejects.toThrow('active tenant');
  });
}

export async function proveReceivedSalesContractRaces(
  db: DatabaseInterface,
): Promise<void> {
  const tenantId = randomUUID();
  await withTenant({ tenantId }, async () => {
    const customer = await (await CustomerCollection.create({ db })).create({
      name: 'Concurrent customer',
    });
    const sales = await SalesContractCollection.create({ db });
    const create = () =>
      sales.create({
        _meta_type: '@happyvertical/smrt-commerce:Order',
        customerId: customer.id,
        currency: 'CAD',
      });
    const order = await create();
    const input = {
      db,
      tenantId,
      contractId: order.id!,
      requestId: 'same',
      evidenceRef: 'same-reviewed-evidence',
      facts: {
        currency: 'CAD',
        netMinor: 2001,
        taxMinor: 101,
        grossMinor: 2102,
        taxComponents: null,
        detail: { kind: 'header-only' as const },
      },
    };
    const replay = await Promise.all([
      recordReceivedSalesContractMoney(input),
      recordReceivedSalesContractMoney(input),
    ]);
    expect(replay[0]).toEqual(replay[1]);
    const competing = await create();
    const result = await Promise.allSettled([
      recordReceivedSalesContractMoney({ ...input, contractId: competing.id! }),
      recordReceivedSalesContractMoney({
        ...input,
        contractId: competing.id!,
        requestId: 'different',
        facts: { ...input.facts, netMinor: 1000, grossMinor: 1101 },
      }),
    ]);
    expect(result.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(result.filter((row) => row.status === 'rejected')).toHaveLength(1);
  });
}
