import { getTestDatabase } from '@happyvertical/smrt-core';
import { ProductCollection } from '@happyvertical/smrt-products/collections';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContractCollection } from '../collections/ContractCollection.js';
import { ContractLineItemCollection } from '../collections/ContractLineItemCollection.js';
import { CustomerCollection } from '../collections/CustomerCollection.js';
import { DocumentTaxCollection } from '../collections/DocumentTaxCollection.js';
import { TaxCodeCollection } from '../collections/TaxCodeCollection.js';
import { TaxComponentCollection } from '../collections/TaxComponentCollection.js';
import { TaxSettingsCollection } from '../collections/TaxSettingsCollection.js';
import { VendorCollection } from '../collections/VendorCollection.js';
import {
  classifyContractPurchase,
  isContractSnapshotReportEligible,
} from '../contract-money.js';
import { Order, PurchaseOrder, SupplierQuote } from '../models/Contract.js';
import { ContractStatus } from '../types/index.js';

describe('Contract money persistence (#3933)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy();
  });
  afterEach(async () => {
    disableTenancy();
    await db.close?.();
  });

  async function activateV2(tenantId: string): Promise<string> {
    return withTenant({ tenantId }, async () => {
      const components = await TaxComponentCollection.create({ db });
      const gst = await components.create({
        name: 'GST',
        percent: '5',
        recoverable: true,
      });
      const codes = await TaxCodeCollection.create({ db });
      const code = await codes.create({
        code: 'gst',
        name: 'GST',
        components: [{ taxComponentId: gst.id, compound: false }],
      });
      const settings = await TaxSettingsCollection.create({ db });
      const current = await settings.getOrCreateForTenant(tenantId);
      current.defaultSalesTaxCodeId = code.id;
      current.defaultLineAmountType = 'exclusive';
      current.taxRoundingScope = 'document';
      await current.save();
      const migrationId = await settings.beginMoneyMigration(tenantId);
      await settings.activateMoneyV2(tenantId, migrationId);
      return code.id;
    });
  }

  async function activateCadV2(
    tenantId: string,
    lineAmountType: 'exclusive' | 'inclusive',
    taxRoundingScope: 'line' | 'document',
  ): Promise<{ gst: string; gstPst: string; exempt: string }> {
    return withTenant({ tenantId }, async () => {
      const components = await TaxComponentCollection.create({ db });
      const gst = await components.create({
        name: 'GST',
        percent: '5',
        recoverable: true,
      });
      const pst = await components.create({ name: 'PST', percent: '7' });
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
      const exemptCode = await codes.create({
        code: 'exempt',
        name: 'Exempt',
        kind: 'exempt',
        components: [],
      });
      const settings = await TaxSettingsCollection.create({ db });
      const current = await settings.getOrCreateForTenant(tenantId);
      current.defaultSalesTaxCodeId = gstCode.id;
      current.defaultPurchaseTaxCodeId = gstCode.id;
      current.defaultLineAmountType = lineAmountType;
      current.taxRoundingScope = taxRoundingScope;
      await current.save();
      const migrationId = await settings.beginMoneyMigration(tenantId);
      await settings.activateMoneyV2(tenantId, migrationId);
      return { gst: gstCode.id, gstPst: gstPstCode.id, exempt: exemptCode.id };
    });
  }

  it('classifies both STI branches and keeps declined snapshots reportable', () => {
    class CustomPurchaseOrder extends PurchaseOrder {}

    expect(classifyContractPurchase(new Order())).toBe(false);
    expect(classifyContractPurchase(new PurchaseOrder())).toBe(true);
    expect(classifyContractPurchase(new SupplierQuote())).toBe(true);
    class CustomSupplierQuote extends SupplierQuote {}
    for (const quote of [new SupplierQuote(), new CustomSupplierQuote()]) {
      quote.status = ContractStatus.ACCEPTED;
      expect(isContractSnapshotReportEligible(quote)).toBe(false);
    }
    expect(classifyContractPurchase(new CustomPurchaseOrder())).toBe(true);
    expect(
      isContractSnapshotReportEligible(
        new Order({ status: ContractStatus.DECLINED }),
      ),
    ).toBe(true);
    expect(
      isContractSnapshotReportEligible(
        new Order({ status: ContractStatus.DRAFT }),
      ),
    ).toBe(false);
    expect(
      isContractSnapshotReportEligible(
        new Order({ status: ContractStatus.CANCELLED }),
      ),
    ).toBe(false);
  });

  it('persists one draft aggregate and freezes it after sent', async () => {
    const codeId = await activateV2('contract-tenant');
    await withTenant({ tenantId: 'contract-tenant' }, async () => {
      const contracts = await ContractCollection.create({ db });
      const contract = await contracts.create({ currency: 'CAD' });
      const lines = await ContractLineItemCollection.create({ db });
      const line = await lines.create({
        contractId: contract.id,
        description: 'Service',
        quantity: 1,
        unitPrice: 100,
        discountType: 'amount',
        discount: 10,
        taxMode: 'override',
        taxCodeId: codeId,
      });
      expect(line).toMatchObject({ amount: 90, taxAmount: 5, taxRate: 0.05 });
      expect(line.taxComponents).toMatchObject([
        { name: 'GST', percent: '5', taxMinor: 5 },
      ]);
      const stored = await contracts.get({ id: contract.id }, { cache: false });
      expect(stored).toMatchObject({
        subtotal: 90,
        discountTotal: 10,
        taxAmount: 5,
        totalAmount: 95,
      });
      const taxes = await DocumentTaxCollection.create({ db });
      expect(
        await taxes.findByDocument('contract-tenant', 'contract', contract.id),
      ).toMatchObject([{ taxCodeId: codeId, taxableMinor: 90, taxMinor: 5 }]);

      if (!stored) throw new Error('Expected the saved Contract');
      stored.status = ContractStatus.SENT;
      await stored.save();
      const frozen = await contracts.get({ id: contract.id }, { cache: false });
      expect(frozen?.moneySnapshotId).toEqual(expect.any(String));
      line.unitPrice = 101;
      await expect(line.save()).rejects.toMatchObject({
        code: 'FROZEN_DOCUMENT',
      });
    });
  });

  it('uses the product tax default before party and tenant defaults', async () => {
    const tenantId = 'contract-product-default';
    const { gst, exempt } = await activateCadV2(tenantId, 'exclusive', 'line');
    await withTenant({ tenantId }, async () => {
      const product = await (await ProductCollection.create({ db })).create({
        name: 'Exempt service',
        defaultSalesTaxCodeId: exempt,
      });
      const contract = await (await ContractCollection.create({ db })).create({
        currency: 'CAD',
      });
      const line = await (
        await ContractLineItemCollection.create({ db })
      ).create({
        contractId: contract.id,
        productId: product.id,
        description: 'Product default',
        quantity: 1,
        unitPrice: 100,
      });
      expect(line).toMatchObject({ taxCodeId: exempt, taxAmount: 0 });
      line.taxMode = 'override';
      line.taxCodeId = gst;
      await line.save();
      expect(line).toMatchObject({ taxCodeId: gst, taxAmount: 5 });
    });
  });

  it('uses the party default, then exemption, and persists purchase recovery', async () => {
    const tenantId = 'contract-party-purchase';
    const codes = await activateCadV2(tenantId, 'exclusive', 'line');
    await withTenant({ tenantId }, async () => {
      const customers = await CustomerCollection.create({ db });
      const customer = await customers.create({
        defaultTaxCodeId: codes.gstPst,
      });
      const sales = new Order({
        db,
        customerId: customer.id,
        currency: 'CAD',
      });
      await sales.initialize();
      await sales.save();
      const lines = await ContractLineItemCollection.create({ db });
      const partyLine = await lines.create({
        contractId: sales.id,
        description: 'Party default',
        quantity: 1,
        unitPrice: 100,
      });
      expect(partyLine).toMatchObject({
        taxCodeId: codes.gstPst,
        taxAmount: 12,
      });
      customer.taxExempt = true;
      await customer.save();
      const exemptLine = await lines.create({
        contractId: sales.id,
        description: 'Exempt party',
        quantity: 1,
        unitPrice: 100,
      });
      expect(exemptLine).toMatchObject({
        taxCodeId: codes.exempt,
        taxAmount: 0,
      });
      exemptLine.taxMode = 'override';
      exemptLine.taxCodeId = codes.gst;
      await exemptLine.save();
      expect(exemptLine).toMatchObject({ taxCodeId: codes.gst, taxAmount: 5 });

      const vendor = await (await VendorCollection.create({ db })).create({
        defaultTaxCodeId: codes.gst,
      });
      for (const Purchase of [PurchaseOrder, SupplierQuote]) {
        const purchase = new Purchase({
          db,
          vendorId: vendor.id,
          currency: 'CAD',
        });
        await purchase.initialize();
        await purchase.save();
        await lines.create({
          contractId: purchase.id,
          description: 'Recoverable purchase',
          quantity: 1,
          unitPrice: 100,
        });
        expect(
          await (await DocumentTaxCollection.create({ db })).findByDocument(
            tenantId,
            'contract',
            purchase.id,
          ),
        ).toMatchObject([
          { taxableMinor: 100, taxMinor: 5, recoverableMinor: 5 },
        ]);
        const frozen = await (await ContractCollection.create({ db })).get(
          { id: purchase.id },
          { cache: false },
        );
        if (!frozen) throw new Error('Expected purchase contract');
        frozen.status = ContractStatus.ACCEPTED;
        await frozen.save();
        const savedLines = await lines.list({
          where: { contractId: purchase.id },
        });
        savedLines[0].unitPrice = 101;
        await expect(savedLines[0].save()).rejects.toMatchObject({
          code: 'FROZEN_DOCUMENT',
        });
      }
    });
  });

  it.each([
    ContractStatus.SENT,
    ContractStatus.ACCEPTED,
    ContractStatus.DECLINED,
    ContractStatus.CANCELLED,
  ])('freezes persisted %s contract lines', async (status) => {
    const tenantId = `contract-freeze-${status}`;
    const codeId = await activateV2(tenantId);
    await withTenant({ tenantId }, async () => {
      const contract = await (await ContractCollection.create({ db })).create({
        currency: 'CAD',
      });
      const line = await (
        await ContractLineItemCollection.create({ db })
      ).create({
        contractId: contract.id,
        description: 'Frozen service',
        quantity: 1,
        unitPrice: 100,
        taxMode: 'override',
        taxCodeId: codeId,
        startDate: new Date('2026-01-01T00:00:00.000Z'),
        billingPeriod: 'monthly',
      });
      const issued = await (await ContractCollection.create({ db })).get(
        { id: contract.id },
        { cache: false },
      );
      if (!issued) throw new Error('Expected saved Contract');
      issued.status = status;
      await issued.save();
      line.billingPeriod = 'yearly';
      await expect(line.save()).rejects.toMatchObject({
        code: 'FROZEN_DOCUMENT',
      });
    });
  });

  it('freezes persisted completed contracts after the accepted transition', async () => {
    const tenantId = 'contract-freeze-completed';
    const codeId = await activateV2(tenantId);
    await withTenant({ tenantId }, async () => {
      const contract = await (await ContractCollection.create({ db })).create({
        currency: 'CAD',
      });
      const line = await (
        await ContractLineItemCollection.create({ db })
      ).create({
        contractId: contract.id,
        description: 'Completed service',
        quantity: 1,
        unitPrice: 100,
        taxMode: 'override',
        taxCodeId: codeId,
      });
      const accepted = await (await ContractCollection.create({ db })).get(
        { id: contract.id },
        { cache: false },
      );
      if (!accepted) throw new Error('Expected saved Contract');
      accepted.status = ContractStatus.ACCEPTED;
      await accepted.save();
      const completed = await (await ContractCollection.create({ db })).get(
        { id: contract.id },
        { cache: false },
      );
      if (!completed) throw new Error('Expected accepted Contract');
      completed.status = ContractStatus.COMPLETED;
      await completed.save();
      line.unitPrice = 101;
      await expect(line.save()).rejects.toMatchObject({
        code: 'FROZEN_DOCUMENT',
      });
    });
  });

  it('blocks Contract and line reads while its tenant is migrating', async () => {
    const tenantId = 'contract-read-migration';
    await withTenant({ tenantId }, async () => {
      const contracts = await ContractCollection.create({ db });
      const contract = await contracts.create({ currency: 'CAD' });
      const lines = await ContractLineItemCollection.create({ db });
      const line = await lines.create({
        contractId: contract.id,
        description: 'Read barrier',
        quantity: 1,
        unitPrice: 100,
      });
      const settings = await TaxSettingsCollection.create({ db });
      const migrationId = await settings.beginMoneyMigration(tenantId);

      await expect(contracts.get({ id: contract.id })).rejects.toMatchObject({
        code: 'FROZEN_DOCUMENT',
      });
      await expect(contracts.list()).rejects.toMatchObject({
        code: 'FROZEN_DOCUMENT',
      });
      await expect(lines.get({ id: line.id })).rejects.toMatchObject({
        code: 'FROZEN_DOCUMENT',
      });
      await expect(lines.list()).rejects.toMatchObject({
        code: 'FROZEN_DOCUMENT',
      });

      await settings.restoreLegacyMoneyModel(tenantId, migrationId);
      await expect(contracts.get({ id: contract.id })).resolves.toMatchObject({
        id: contract.id,
      });
    });
  });

  it('persists the A–E money examples across line and document rounding', async () => {
    const cases = [
      {
        name: 'A exclusive',
        mode: 'exclusive' as const,
        exempt: false,
        expected: {
          subtotal: 114_498,
          discountTotal: 9_000,
          taxAmount: 8_070,
          totalAmount: 122_568,
        },
      },
      {
        name: 'B inclusive',
        mode: 'inclusive' as const,
        exempt: false,
        expected: {
          line: {
            subtotal: 107_052,
            discountTotal: 9_000,
            taxAmount: 7_446,
            totalAmount: 114_498,
          },
          document: {
            subtotal: 107_051,
            discountTotal: 9_000,
            taxAmount: 7_447,
            totalAmount: 114_498,
          },
        },
      },
      {
        name: 'C exclusive exempt',
        mode: 'exclusive' as const,
        exempt: true,
        expected: {
          subtotal: 114_498,
          discountTotal: 9_000,
          taxAmount: 0,
          totalAmount: 114_498,
        },
      },
      {
        name: 'D inclusive exempt',
        mode: 'inclusive' as const,
        exempt: true,
        expected: {
          subtotal: 114_498,
          discountTotal: 9_000,
          taxAmount: 0,
          totalAmount: 114_498,
        },
      },
      {
        name: 'E rounding boundary',
        mode: 'exclusive' as const,
        roundingBoundary: true,
        expected: {
          line: {
            subtotal: 30,
            discountTotal: 0,
            taxAmount: 6,
            totalAmount: 36,
          },
          document: {
            subtotal: 30,
            discountTotal: 0,
            taxAmount: 4,
            totalAmount: 34,
          },
        },
      },
      {
        name: 'E inclusive rounding boundary',
        mode: 'inclusive' as const,
        roundingBoundary: true,
        expected: {
          line: {
            subtotal: 27,
            discountTotal: 0,
            taxAmount: 3,
            totalAmount: 30,
          },
          document: {
            subtotal: 27,
            discountTotal: 0,
            taxAmount: 3,
            totalAmount: 30,
          },
        },
      },
    ] as const;

    for (const [caseIndex, example] of cases.entries())
      for (const taxRoundingScope of ['line', 'document'] as const) {
        const tenantId = `contract-epic-${caseIndex}-${taxRoundingScope}`;
        const codes = await activateCadV2(
          tenantId,
          example.mode,
          taxRoundingScope,
        );
        await withTenant({ tenantId }, async () => {
          const contract = await (
            await ContractCollection.create({ db })
          ).create({ currency: 'CAD' });
          const lines = await ContractLineItemCollection.create({ db });
          const codeFor = (taxable: boolean) =>
            taxable ? codes.gstPst : codes.exempt;
          const specifications = example.roundingBoundary
            ? [
                { description: 'cent one', quantity: 1, unitPrice: 10 },
                { description: 'cent two', quantity: 1, unitPrice: 10 },
                { description: 'cent three', quantity: 1, unitPrice: 10 },
              ]
            : [
                {
                  description: 'Design',
                  quantity: 10,
                  unitPrice: 8_500,
                  discountType: 'percent' as const,
                  discountRate: '10',
                  taxCodeId: example.exempt ? codes.exempt : codes.gst,
                },
                {
                  description: 'Laptop stand',
                  quantity: 2,
                  unitPrice: 4_999,
                  discountType: 'amount' as const,
                  discount: 500,
                  taxCodeId: codeFor(!example.exempt),
                },
                {
                  description: 'Software licence',
                  quantity: 12,
                  unitPrice: 2_000,
                  taxCodeId: codeFor(!example.exempt),
                },
                {
                  description: 'Book',
                  quantity: 1,
                  unitPrice: 4_500,
                  taxCodeId: example.exempt ? codes.exempt : codes.gst,
                },
              ];
          for (const specification of specifications)
            await lines.create({
              contractId: contract.id,
              taxMode: 'override',
              ...specification,
              ...(example.roundingBoundary ? { taxCodeId: codes.gstPst } : {}),
            });
          const stored = await (await ContractCollection.create({ db })).get(
            { id: contract.id },
            { cache: false },
          );
          const expected =
            'line' in example.expected
              ? example.expected[taxRoundingScope]
              : example.expected;
          expect(stored, example.name).toMatchObject(expected);
          const documentTaxes = await (
            await DocumentTaxCollection.create({ db })
          ).findByDocument(tenantId, 'contract', contract.id);
          expect(
            documentTaxes.reduce((sum, row) => sum + row.taxMinor, 0),
          ).toBe(expected.taxAmount);
          if (
            example.name === 'B inclusive' &&
            taxRoundingScope === 'document'
          ) {
            const software = (await lines.findByContract(contract.id)).find(
              (line) => line.description === 'Software licence',
            );
            expect(
              software?.taxComponents.map((component) => component.taxMinor),
            ).toEqual([1_072, 1_500]);
          }
        });
      }
  });
});
