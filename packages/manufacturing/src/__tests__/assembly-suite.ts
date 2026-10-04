/**
 * Assembly behaviour, shared by the SQLite and PostgreSQL runs
 * (`assembly.test.ts`, `assembly.optional.test.ts`).
 *
 * Covers the cross-package STI subtype (its columns on the products table,
 * round-trips, the generation surface), the component resolve helper, and
 * the cycle refusal on bill lines and bill activation.
 */

import { isPostgresDatabase, ObjectRegistry } from '@happyvertical/smrt-core';
import {
  MaterialCollection,
  ProductCollection,
  SkuCollection,
} from '@happyvertical/smrt-products/collections';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Assembly,
  AssemblyCollection,
  AssemblyService,
  BillOfMaterialsCollection,
  BomCycleError,
  BomLineCollection,
  BomNotFoundError,
} from '../index.js';

const ASSEMBLY_TYPE = '@happyvertical/smrt-manufacturing:Assembly';

async function cycleOf(run: Promise<unknown>): Promise<BomCycleError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof BomCycleError) return error;
    throw error;
  }
  throw new Error('Expected a BomCycleError, but the save succeeded');
}

export function assemblySuite(
  name: string,
  create: () => Promise<DatabaseInterface>,
  cleanup: () => Promise<void>,
) {
  describe(name, () => {
    let db: DatabaseInterface;
    let products: ProductCollection;
    let materials: MaterialCollection;
    let assemblies: AssemblyCollection;
    let skus: SkuCollection;
    let boms: BillOfMaterialsCollection;
    let lines: BomLineCollection;
    let service: AssemblyService;

    beforeEach(async () => {
      db = await create();
      [products, materials, assemblies, skus, boms, lines] = await Promise.all([
        ProductCollection.create({ db }),
        MaterialCollection.create({ db }),
        AssemblyCollection.create({ db }),
        SkuCollection.create({ db }),
        BillOfMaterialsCollection.create({ db }),
        BomLineCollection.create({ db }),
      ]);
      service = await AssemblyService.create({ db });
    });

    afterEach(async () => {
      await cleanup();
    });

    // Slugs are part of the products natural key, so they are unique per
    // run as well as per test: a re-used slug would upsert an older row.
    const slug = (label: string) =>
      `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${crypto.randomUUID()}`;

    async function skuFor(productId: string, code: string) {
      return skus.create({ productId, code: `${code}-${crypto.randomUUID()}` });
    }

    async function assembly(name: string, extra: Record<string, unknown> = {}) {
      const row = (await assemblies.create({
        name,
        slug: slug(name),
        ...extra,
      })) as Assembly;
      const sku = await skuFor(row.id!, name.toUpperCase());
      return { row, sku };
    }

    async function bill(
      productId: string,
      status: 'draft' | 'active' | 'superseded' = 'active',
      version = 1,
    ) {
      return boms.create({ productId, version, status });
    }

    async function line(bomId: string, componentSkuId: string, qty = 1) {
      return lines.create({ bomId, componentSkuId, qtyPerUnit: qty });
    }

    describe('Assembly on the shared products table', () => {
      it('adds its own columns to the products table', async () => {
        const columns = isPostgresDatabase(db)
          ? (
              await db.query(
                `SELECT column_name AS name FROM information_schema.columns
                 WHERE table_name = 'products'`,
              )
            ).rows
          : (await db.query(`PRAGMA table_info(products)`)).rows;
        const names = (columns as { name: string }[]).map((c) => c.name);
        expect(names).toEqual(
          expect.arrayContaining([
            'estimated_labour_minutes',
            'default_operation_id',
            'part_reference',
            'product_type',
            '_meta_type',
          ]),
        );
      });

      it('round-trips its fields and identifies as an assembly', async () => {
        const { row } = await assembly('Frame', {
          estimatedLabourMinutes: 95,
          defaultOperationId: 'op-weld',
          partReference: 'DWG-1001 rev B',
          price: 125000,
        });

        const loaded = (await assemblies.get({
          id: row.id!,
        })) as Assembly | null;
        expect(loaded).toBeInstanceOf(Assembly);
        expect(loaded?.estimatedLabourMinutes).toBe(95);
        expect(loaded?.defaultOperationId).toBe('op-weld');
        expect(loaded?.partReference).toBe('DWG-1001 rev B');
        expect(loaded?.price).toBe(125000);
        expect(loaded?.productType).toBe('assembly');

        const raw = await db.query(
          isPostgresDatabase(db)
            ? 'SELECT _meta_type, product_type FROM products WHERE id = $1'
            : 'SELECT _meta_type, product_type FROM products WHERE id = ?',
          [row.id],
        );
        expect(raw.rows[0]).toMatchObject({
          _meta_type: ASSEMBLY_TYPE,
          product_type: 'assembly',
        });
      });

      it('is returned as an Assembly through the base Product collection', async () => {
        const { row } = await assembly('Frame');
        const viaBase = await products.get({ id: row.id! });
        expect(viaBase).toBeInstanceOf(Assembly);
      });

      it('lists only assemblies, never materials or plain products', async () => {
        await assembly('Frame');
        await materials.create({ name: 'Steel tube', slug: slug('tube') });
        await products.create({ name: 'Caster', slug: slug('caster') });
        const listed = await assemblies.list({});
        expect(listed.map((a) => a.name)).toEqual(['Frame']);
        expect(listed.every((a) => a instanceof Assembly)).toBe(true);
      });

      it('isolates assemblies by tenant', async () => {
        const tenantA = crypto.randomUUID();
        const tenantB = crypto.randomUUID();
        enableTenancy();
        try {
          await withTenant({ tenantId: tenantA }, () => assembly('Frame A'));
          await withTenant({ tenantId: tenantB }, () => assembly('Frame B'));
          const seenByA = await withTenant({ tenantId: tenantA }, () =>
            assemblies.list({}),
          );
          expect(seenByA.map((a) => a.name)).toEqual(['Frame A']);
          expect(seenByA[0].tenantId).toBe(tenantA);
        } finally {
          disableTenancy();
        }
      });
    });

    describe('resolveComponent', () => {
      it('reports a material, a bought item, and a missing SKU plainly', async () => {
        const steel = await materials.create({
          name: 'Steel',
          slug: slug('s'),
        });
        const caster = await products.create({
          name: 'Caster',
          slug: slug('c'),
        });
        const steelSku = await skuFor(steel.id!, 'STEEL');
        const casterSku = await skuFor(caster.id!, 'CASTER');
        const orphan = await skus.create({
          productId: crypto.randomUUID(),
          code: `ORPHAN-${crypto.randomUUID()}`,
        });

        const material = await service.resolveComponent(steelSku.id!);
        expect(material).toMatchObject({
          kind: 'material',
          assembly: null,
          activeBom: null,
          buildable: false,
        });
        expect(material.product?.id).toBe(steel.id);

        const bought = await service.resolveComponent(casterSku.id!);
        expect(bought.kind).toBe('bought');
        expect(bought.product?.id).toBe(caster.id);

        const unknown = await service.resolveComponent(crypto.randomUUID());
        expect(unknown).toMatchObject({ kind: 'missing', sku: null });

        const notAnId = await service.resolveComponent('not-a-sku-id');
        expect(notAnId).toMatchObject({ kind: 'missing', sku: null });

        const noProduct = await service.resolveComponent(orphan.id!);
        expect(noProduct.kind).toBe('missing');
        expect(noProduct.sku?.id).toBe(orphan.id);
        expect(noProduct.product).toBeNull();
      });

      it('reports an assembly with no active bill as not buildable', async () => {
        const { row, sku } = await assembly('Bracket');
        await bill(row.id!, 'draft');
        const resolved = await service.resolveComponent(sku.id!);
        expect(resolved.kind).toBe('assembly');
        expect(resolved.assembly?.id).toBe(row.id);
        expect(resolved.activeBom).toBeNull();
        expect(resolved.buildable).toBe(false);
        expect(await service.isAssembly(sku.id!)).toBe(true);
      });

      it("returns an assembly's active bill, the highest active version", async () => {
        const { row, sku } = await assembly('Bracket');
        await bill(row.id!, 'superseded', 1);
        await bill(row.id!, 'active', 2);
        const v3 = await bill(row.id!, 'active', 3);
        await bill(row.id!, 'draft', 4);
        const resolved = await service.resolveComponent(sku.id!);
        expect(resolved.activeBom?.id).toBe(v3.id);
        expect(resolved.buildable).toBe(true);
      });

      it('isAssembly is false for anything that is not an assembly', async () => {
        const steel = await materials.create({
          name: 'Steel',
          slug: slug('s'),
        });
        const steelSku = await skuFor(steel.id!, 'STEEL');
        expect(await service.isAssembly(steelSku.id!)).toBe(false);
        expect(await service.isAssembly(crypto.randomUUID())).toBe(false);
      });
    });

    describe('getBillStructure', () => {
      it('resolves each line, marking sub-assemblies and their own bills', async () => {
        const frame = await assembly('Frame');
        const panel = await assembly('Panel');
        const panelBill = await bill(panel.row.id!);
        const steel = await materials.create({
          name: 'Steel',
          slug: slug('s'),
        });
        const steelSku = await skuFor(steel.id!, 'STEEL');
        const frameBill = await bill(frame.row.id!);
        await line(frameBill.id!, panel.sku.id!, 2);
        await line(frameBill.id!, steelSku.id!, 3.5);

        const structure = await service.getBillStructure(frameBill.id!);
        expect(structure.bom.id).toBe(frameBill.id);
        const byKind = Object.fromEntries(
          structure.lines.map((l) => [l.component.kind, l]),
        );
        expect(byKind.assembly.component.activeBom?.id).toBe(panelBill.id);
        expect(byKind.assembly.line.qtyPerUnit).toBe(2);
        expect(byKind.material.line.qtyPerUnit).toBeCloseTo(3.5, 6);
      });

      it('throws BomNotFoundError for an unknown bill', async () => {
        await expect(
          service.getBillStructure(crypto.randomUUID()),
        ).rejects.toBeInstanceOf(BomNotFoundError);
        await expect(service.getBillStructure('nope')).rejects.toBeInstanceOf(
          BomNotFoundError,
        );
      });
    });

    describe('cycle refusal', () => {
      it('refuses a line that puts an assembly in its own bill', async () => {
        const frame = await assembly('Frame');
        const frameBill = await bill(frame.row.id!);
        const error = await cycleOf(line(frameBill.id!, frame.sku.id!));
        expect(error.bomId).toBe(frameBill.id);
        expect(error.path.map((p) => p.name)).toEqual(['Frame', 'Frame']);
        expect(error.message).toContain('Frame → Frame');
        expect(await lines.findByBom(frameBill.id!)).toHaveLength(0);
      });

      it('refuses a line that closes a loop two levels down, naming the path', async () => {
        const frame = await assembly('Frame');
        const panel = await assembly('Panel');
        const bracket = await assembly('Bracket');
        const frameBill = await bill(frame.row.id!);
        const panelBill = await bill(panel.row.id!);
        const bracketBill = await bill(bracket.row.id!);
        await line(frameBill.id!, panel.sku.id!);
        await line(panelBill.id!, bracket.sku.id!);

        const error = await cycleOf(line(bracketBill.id!, frame.sku.id!));
        expect(error.path.map((p) => p.name)).toEqual([
          'Bracket',
          'Frame',
          'Panel',
          'Bracket',
        ]);
        expect(error.message).toBe(
          'Refused: "Bracket" would contain itself: Bracket → Frame → Panel → Bracket',
        );
      });

      it('refuses the same cycle when an existing line is re-pointed', async () => {
        const frame = await assembly('Frame');
        const panel = await assembly('Panel');
        const steel = await materials.create({
          name: 'Steel',
          slug: slug('s'),
        });
        const steelSku = await skuFor(steel.id!, 'STEEL');
        const frameBill = await bill(frame.row.id!);
        const panelBill = await bill(panel.row.id!);
        await line(frameBill.id!, panel.sku.id!);
        const panelLine = await line(panelBill.id!, steelSku.id!);

        panelLine.componentSkuId = frame.sku.id!;
        await cycleOf(panelLine.save());
      });

      it('refuses on a draft bill too, before it can be activated', async () => {
        const frame = await assembly('Frame');
        const panel = await assembly('Panel');
        const frameBill = await bill(frame.row.id!);
        await line(frameBill.id!, panel.sku.id!);
        const panelDraft = await bill(panel.row.id!, 'draft');
        await cycleOf(line(panelDraft.id!, frame.sku.id!));
      });

      it('ignores superseded and draft bills of sub-assemblies', async () => {
        const frame = await assembly('Frame');
        const panel = await assembly('Panel');
        const oldPanel = await bill(panel.row.id!, 'superseded', 1);
        const draftPanel = await bill(panel.row.id!, 'draft', 2);
        await bill(panel.row.id!, 'active', 3);
        // Write the loop into the inactive bills directly; they are not part
        // of the structure, so they cannot make Frame contain itself.
        const frameBill = await bill(frame.row.id!, 'draft');
        await line(oldPanel.id!, frame.sku.id!);
        await line(draftPanel.id!, frame.sku.id!);

        await expect(line(frameBill.id!, panel.sku.id!)).resolves.toBeTruthy();
      });

      it('refuses activating a bill that would close a loop', async () => {
        const frame = await assembly('Frame');
        const panel = await assembly('Panel');
        const frameDraft = await bill(frame.row.id!, 'draft');
        await line(frameDraft.id!, panel.sku.id!);
        // Frame's bill is only a draft, so Panel may take Frame for now.
        const panelBill = await bill(panel.row.id!);
        await line(panelBill.id!, frame.sku.id!);

        frameDraft.status = 'active';
        const error = await cycleOf(frameDraft.save());
        expect(error.path.map((p) => p.name)).toEqual([
          'Frame',
          'Panel',
          'Frame',
        ]);
        const stored = await boms.get({ id: frameDraft.id! });
        expect(stored?.status).toBe('draft');
      });

      it('refuses activating a stored draft through its natural key', async () => {
        const frame = await assembly('Frame');
        const panel = await assembly('Panel');
        const frameDraft = await bill(frame.row.id!, 'draft', 1);
        await line(frameDraft.id!, panel.sku.id!);
        const panelBill = await bill(panel.row.id!);
        await line(panelBill.id!, frame.sku.id!);

        // A new instance with the stored (product, version) key would upsert
        // onto the draft and activate its lines.
        const error = await cycleOf(bill(frame.row.id!, 'active', 1));
        expect(error.path.map((p) => p.name)).toEqual([
          'Frame',
          'Panel',
          'Frame',
        ]);
        const stored = await boms.findByProduct(frame.row.id!);
        expect(stored.map((b) => [b.id, b.status])).toEqual([
          [frameDraft.id, 'draft'],
        ]);
      });

      it('allows a shared sub-assembly used twice in one structure', async () => {
        const frame = await assembly('Frame');
        const left = await assembly('Left panel');
        const right = await assembly('Right panel');
        const bracket = await assembly('Bracket');
        const frameBill = await bill(frame.row.id!);
        const leftBill = await bill(left.row.id!);
        const rightBill = await bill(right.row.id!);
        await line(leftBill.id!, bracket.sku.id!);
        await line(rightBill.id!, bracket.sku.id!);
        await line(frameBill.id!, left.sku.id!);
        await expect(line(frameBill.id!, right.sku.id!)).resolves.toBeTruthy();
      });
    });

    describe('generation surface', () => {
      it('matches Product: CRUD without delete over REST, read-only over MCP', () => {
        const product = ObjectRegistry.getConfig(
          '@happyvertical/smrt-products:Product',
        );
        const config = ObjectRegistry.getConfig(ASSEMBLY_TYPE);
        expect(config.api).toEqual(product.api);
        expect(config.mcp).toEqual(product.mcp);
        expect(ObjectRegistry.getSTIBase(ASSEMBLY_TYPE)).toBe(
          '@happyvertical/smrt-products:Product',
        );
      });
    });
  });
}
