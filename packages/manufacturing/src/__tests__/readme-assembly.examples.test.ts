/**
 * README parity: the "Define an assembly and its bill" and "Resolve a
 * component, and refused cycles" examples, run as written.
 */
import { getTestDatabase } from '@happyvertical/smrt-core';
import { SkuCollection } from '@happyvertical/smrt-products/collections';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AssemblyCollection,
  AssemblyService,
  BillOfMaterialsCollection,
  BomCycleError,
  BomLineCollection,
} from '../index.js';

describe('README assembly examples', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  });

  afterEach(async () => {
    await db.close?.();
  });

  it('defines an assembly with a sub-assembly line, resolves it, and refuses the loop', async () => {
    const assemblies = await AssemblyCollection.create({ db });
    const skus = await SkuCollection.create({ db });
    const boms = await BillOfMaterialsCollection.create({ db });
    const lines = await BomLineCollection.create({ db });

    const panel = await assemblies.create({
      name: 'Side panel',
      partReference: 'DWG-200',
    });
    const panelSku = await skus.create({
      productId: panel.id!,
      code: 'SP-100',
    });

    const frame = await assemblies.create({
      name: 'Frame',
      partReference: 'DWG-100',
      estimatedLabourMinutes: 95,
    });
    const frameBom = await boms.create({
      productId: frame.id!,
      version: 1,
      status: 'active',
    });
    await lines.create({
      bomId: frameBom.id!,
      componentSkuId: panelSku.id!,
      qtyPerUnit: 2,
    });

    const assemblyService = await AssemblyService.create({ db });
    const component = await assemblyService.resolveComponent(panelSku.id!);
    expect(component.kind).toBe('assembly');
    expect(component.activeBom).toBeNull();
    expect(component.buildable).toBe(false);

    const frameSku = await skus.create({
      productId: frame.id!,
      code: 'FR-100',
    });
    const panelBom = await boms.create({
      productId: panel.id!,
      version: 1,
      status: 'active',
    });
    const refused = await lines
      .create({
        bomId: panelBom.id!,
        componentSkuId: frameSku.id!,
        qtyPerUnit: 1,
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(refused).toBeInstanceOf(BomCycleError);
    expect((refused as BomCycleError).message).toBe(
      'Refused: "Side panel" would contain itself: Side panel → Frame → Side panel',
    );
  });
});
