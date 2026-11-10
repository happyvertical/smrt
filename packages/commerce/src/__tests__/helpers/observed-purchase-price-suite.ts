import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { expect } from 'vitest';
import { ContractCollection } from '../../collections/ContractCollection.js';
import { PurchasePriceObservationCollection } from '../../collections/PurchasePriceObservationCollection.js';
import { VendorCollection } from '../../collections/VendorCollection.js';
import {
  completePurchasePriceObservation,
  type PurchasePriceObservationSnapshot,
  readPurchasePriceObservation,
  recordPurchasePriceObservation,
} from '../../observed-purchase-price.js';
import { ContractStatus } from '../../types/index.js';

export async function proveObservedPurchasePrice(db: DatabaseInterface) {
  const tenantId = randomUUID();
  let privateId = '';
  await withTenant({ tenantId }, async () => {
    const vendor = await (await VendorCollection.create({ db })).create({
      name: 'Observed supplier',
    });
    const snapshot: PurchasePriceObservationSnapshot = {
      version: 1,
      requestId: 'observed-1',
      sourceNamespace: 'archive-v1',
      sourceKey: 'quote-1',
      vendorId: vendor.id!,
      kind: 'supplier-quote',
      sourceStatus: 'selected',
      effectiveOn: '2020-01-02',
      evidenceRef: 'original-evidence',
      facts: {
        currency: 'CAD',
        netMinor: 2001,
        taxMinor: null,
        grossMinor: null,
        detail: {
          kind: 'lines',
          lines: [
            {
              sourceKey: 'line-1',
              description: 'Original work',
              netMinor: 2001,
              taxMinor: null,
              grossMinor: null,
              quantityText: '0.0100',
              unitRateText: '10.0050',
            },
          ],
        },
      },
    };
    const input = { db, tenantId, snapshot };
    const first = await recordPurchasePriceObservation(input);
    privateId = first.id;
    expect(first).toMatchObject({
      monetaryAggregate: null,
      completion: null,
      snapshot,
    });
    expect(await recordPurchasePriceObservation(input)).toEqual(first);
    expect(
      await readPurchasePriceObservation({ db, tenantId, id: first.id }),
    ).toEqual(first);
    const contracts = await ContractCollection.create({ db });
    expect(await contracts.list({ where: { tenantId } })).toHaveLength(0);
    await expect(
      recordPurchasePriceObservation({
        ...input,
        snapshot: { ...snapshot, sourceStatus: 'approved' },
      }),
    ).rejects.toThrow('changed');
    const rows = await PurchasePriceObservationCollection.create({ db });
    const row = (await rows.get({ id: first.id }, { cache: false }))!;
    row.snapshotJson = '{}';
    await expect(row.save()).rejects.toThrow('owning commands');
    await expect(row.delete()).rejects.toThrow('cannot be deleted');
    await expect(
      rows.create({ tenantId, snapshotJson: JSON.stringify(snapshot) }),
    ).rejects.toThrow('owning commands');
    const completion = {
      db,
      tenantId,
      id: first.id,
      requestId: 'complete-1',
      reviewEvidenceRef: 'reviewed-supplement',
      facts: {
        currency: 'CAD',
        netMinor: 2001,
        taxMinor: 101,
        grossMinor: 2102,
        taxComponents: null,
        detail: { kind: 'header-only' as const },
      },
    };
    await expect(
      completePurchasePriceObservation({
        ...completion,
        facts: { ...completion.facts, netMinor: 2002, grossMinor: 2103 },
      }),
    ).rejects.toThrow('changed');
    await expect(
      db.transaction!(async (tx) => {
        await completePurchasePriceObservation({ ...completion, db: tx });
        throw new Error('completion rollback');
      }),
    ).rejects.toThrow('completion rollback');
    expect(await contracts.list({ where: { tenantId } })).toHaveLength(0);
    expect(
      (await readPurchasePriceObservation({ db, tenantId, id: first.id }))
        .completion,
    ).toBeNull();
    const completed = await completePurchasePriceObservation(completion);
    expect(completed.snapshot).toEqual(snapshot);
    expect(completed.monetaryAggregate).toBeNull();
    expect(completed.completion?.facts.taxMinor).toBe(101);
    expect(await completePurchasePriceObservation(completion)).toEqual(
      completed,
    );
    expect(
      (await contracts.get(
        { id: completed.completion!.contractId },
        { cache: false },
      ))!.status,
    ).toBe(ContractStatus.DRAFT);
    await expect(
      completePurchasePriceObservation({
        ...completion,
        requestId: 'different',
      }),
    ).rejects.toThrow('changed');
    const rollback = {
      ...snapshot,
      sourceKey: 'rollback',
      requestId: 'rollback',
    };
    await expect(
      db.transaction!(async (tx) => {
        await recordPurchasePriceObservation({
          db: tx,
          tenantId,
          snapshot: rollback,
        });
        throw new Error('caller rollback');
      }),
    ).rejects.toThrow('caller rollback');
    expect(await rows.list({ where: { tenantId } })).toHaveLength(1);
    // Same identity is serialized under the tenant money lock; concurrent replay is one row.
    const concurrent = {
      ...snapshot,
      kind: 'purchase-order' as const,
      sourceKey: 'concurrent',
      requestId: 'concurrent',
    };
    const results = await Promise.all([
      recordPurchasePriceObservation({ db, tenantId, snapshot: concurrent }),
      recordPurchasePriceObservation({ db, tenantId, snapshot: concurrent }),
    ]);
    expect(results[0].id).toBe(results[1].id);
    expect(await rows.list({ where: { tenantId } })).toHaveLength(2);
  });
  await withTenant({ tenantId: randomUUID() }, async () => {
    await expect(
      readPurchasePriceObservation({ db, tenantId, id: privateId }),
    ).rejects.toThrow('Active tenant');
    await expect(
      readPurchasePriceObservation({
        db,
        tenantId: (await import('@happyvertical/smrt-tenancy')).getTenantId()!,
        id: privateId,
      }),
    ).rejects.toThrow('not found');
  });
}
