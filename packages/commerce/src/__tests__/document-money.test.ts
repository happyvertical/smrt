import {
  getTestDatabase,
  MCPGenerator,
  ObjectRegistry,
  type SmrtObject,
} from '@happyvertical/smrt-core';
import { ProductCollection } from '@happyvertical/smrt-products/collections';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CustomerCollection } from '../collections/CustomerCollection';
import { DocumentTaxCollection } from '../collections/DocumentTaxCollection';
import { InvoiceCollection } from '../collections/InvoiceCollection';
import { InvoiceLineItemCollection } from '../collections/InvoiceLineItemCollection';
import { TaxCodeCollection } from '../collections/TaxCodeCollection';
import { TaxComponentCollection } from '../collections/TaxComponentCollection';
import { TaxSettingsCollection } from '../collections/TaxSettingsCollection';
import { serializeInvoiceMcpGet } from '../invoice-mcp';
import { DocumentTax } from '../models/DocumentTax';
import { Invoice } from '../models/Invoice';
import { InvoiceLineItem } from '../models/InvoiceLineItem';
import { MoneyValidationError } from '../money';
import { ensureTenantTaxCodes } from '../tax/legacy';
import { InvoiceStatus } from '../types';

function gateFieldForTest(
  objectClass: typeof SmrtObject,
  fieldName: string,
  permission: string,
): () => void {
  const registered = ObjectRegistry.getClassByConstructor(objectClass);
  if (!registered) throw new Error(`Expected ${objectClass.name} registration`);
  const definitions = [registered.fields, registered.inheritedFields]
    .filter((fields) => fields !== undefined)
    .map((fields) => fields.get(fieldName))
    .filter((field) => field !== undefined);
  if (definitions.length === 0)
    throw new Error(`Expected ${objectClass.name}.${fieldName} registration`);
  const prior = definitions.map((field) => field.readPermission);
  definitions.forEach((field) => {
    field.readPermission = permission;
  });
  return () => {
    definitions.forEach((field, index) => {
      if (prior[index] === undefined) delete field.readPermission;
      else field.readPermission = prior[index];
    });
  };
}

describe('invoice money persistence (#3933)', () => {
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
    await ensureTenantTaxCodes(db, tenantId);
    return withTenant({ tenantId }, async () => {
      const components = await TaxComponentCollection.create({ db });
      const gst = await components.create({ name: 'GST', percent: '5' });
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
      current.taxRegistrations = [
        { taxComponentId: gst.id, number: 'GST-123', label: 'GST' },
      ];
      await current.save();
      const migrationId = await settings.beginMoneyMigration(tenantId);
      await settings.activateMoneyV2(tenantId, migrationId);
      expect(await settings.getForTenant(tenantId)).toMatchObject({
        moneyModel: 'v2',
        taxRoundingScope: 'document',
      });
      return code.id;
    });
  }

  it('recomputes one aggregate atomically and freezes a stable issued snapshot', async () => {
    const taxCodeId = await activateV2('tenant-a');
    await withTenant({ tenantId: 'tenant-a' }, async () => {
      const customers = await CustomerCollection.create({ db });
      const customer = await customers.create({
        defaultTaxCodeId: taxCodeId,
        taxId: 'CUSTOMER-TAX',
      });
      const invoices = await InvoiceCollection.create({ db });
      const invoice = await invoices.create({
        customerId: customer.id,
        invoiceNumber: 'INV-V2',
        currency: 'CAD',
      });
      expect(invoice).toMatchObject({
        lineAmountType: 'exclusive',
        taxRoundingScope: 'document',
      });
      const lines = await InvoiceLineItemCollection.create({ db });
      const line = await lines.create({
        invoiceId: invoice.id,
        description: 'Service',
        quantity: 1,
        unitPrice: 100,
        discountType: 'amount',
        discount: 10,
        taxMode: 'override',
        taxCodeId,
        revenueAccountId: 'revenue',
      });
      expect(line).toMatchObject({ amount: 90, taxAmount: 5, taxRate: 0.05 });
      expect(line.taxComponents).toMatchObject([
        { name: 'GST', percent: '5', taxMinor: 5 },
      ]);
      const storedInvoice = await invoices.get(
        { id: invoice.id },
        { cache: false },
      );
      expect(storedInvoice).toMatchObject({
        subtotal: 90,
        discountTotal: 10,
        taxAmount: 5,
        totalAmount: 95,
      });
      const taxes = await DocumentTaxCollection.create({ db });
      const before = await taxes.findByDocument(
        'tenant-a',
        'invoice',
        invoice.id,
      );
      expect(before).toMatchObject([
        { taxableMinor: 90, taxMinor: 5, taxCodeId },
      ]);

      line.taxAmount = 999;
      await line.save();
      expect(line.taxAmount).toBe(5);
      const after = await taxes.findByDocument(
        'tenant-a',
        'invoice',
        invoice.id,
      );
      expect(after.map((row) => row.updated_at)).toEqual(
        before.map((row) => row.updated_at),
      );

      if (!storedInvoice) throw new Error('Expected invoice');
      storedInvoice.status = InvoiceStatus.SENT;
      storedInvoice.sentAt = new Date('2026-10-13T12:00:00.000Z');
      await storedInvoice.save();
      expect(storedInvoice.moneySnapshotId).not.toBe('');
      expect(storedInvoice.partyTaxId).toBe('CUSTOMER-TAX');
      expect(storedInvoice.sellerTaxRegistrations).toHaveLength(1);
      expect(line.moneySnapshotId).toBe('');
      const issuedLine = await lines.get({ id: line.id }, { cache: false });
      expect(issuedLine?.moneySnapshotId).toBe(storedInvoice.moneySnapshotId);

      if (!issuedLine) throw new Error('Expected issued line');
      issuedLine.description = 'Forged';
      await expect(issuedLine.save()).rejects.toMatchObject({
        code: 'FROZEN_DOCUMENT',
      } satisfies Partial<MoneyValidationError>);
      await expect(issuedLine.delete()).rejects.toMatchObject({
        code: 'FROZEN_DOCUMENT',
      } satisfies Partial<MoneyValidationError>);
      storedInvoice.status = InvoiceStatus.VIEWED;
      storedInvoice.viewedAt = new Date('2026-10-13T13:00:00.000Z');
      const snapshotId = storedInvoice.moneySnapshotId;
      await storedInvoice.save();
      expect(storedInvoice.moneySnapshotId).toBe(snapshotId);
      storedInvoice.arJournalId = 'journal-issued';
      await storedInvoice.save();
      storedInvoice.arJournalId = '';
      await expect(storedInvoice.save()).rejects.toMatchObject({
        code: 'FROZEN_DOCUMENT',
      } satisfies Partial<MoneyValidationError>);
      storedInvoice.arJournalId = 'journal-issued';
      storedInvoice.currency = 'USD';
      await expect(storedInvoice.save()).rejects.toMatchObject({
        code: 'FROZEN_DOCUMENT',
      } satisfies Partial<MoneyValidationError>);

      const mcp = await new MCPGenerator(
        { classNames: ['@happyvertical/smrt-commerce:Invoice'] },
        {
          db,
          user: { id: 'invoice-reader' },
          tenantId: 'tenant-a',
        },
      ).handleToolCall({
        method: 'tools/call',
        params: { name: 'invoice_get', arguments: { id: invoice.id } },
      });
      expect(mcp.isError).not.toBe(true);
      expect(mcp.structuredContent).toMatchObject({
        id: invoice.id,
        money: {
          source: 'stored',
          moneySnapshotId: snapshotId,
          header: {
            subtotalMinor: 90,
            taxAmountMinor: 5,
            totalAmountMinor: 95,
          },
          lines: [expect.objectContaining({ amountMinor: 90, taxMinor: 5 })],
          taxes: [expect.objectContaining({ taxableMinor: 90, taxMinor: 5 })],
        },
      });

      const restorePolicies = [
        gateFieldForTest(Invoice, 'taxAmount', 'invoices.read.money'),
        gateFieldForTest(InvoiceLineItem, 'taxAmount', 'invoices.read.money'),
        gateFieldForTest(DocumentTax, 'taxMinor', 'invoices.read.money'),
      ];
      try {
        const denied = await serializeInvoiceMcpGet(storedInvoice);
        expect(denied).not.toHaveProperty('taxAmount');
        expect(denied).not.toHaveProperty('money');

        const authorized = await serializeInvoiceMcpGet(storedInvoice, {
          permissions: ['invoices.read.money'],
        });
        expect(authorized).toMatchObject({
          taxAmount: 5,
          money: {
            header: { taxAmountMinor: 5 },
            lines: [expect.objectContaining({ taxMinor: 5 })],
            taxes: [expect.objectContaining({ taxMinor: 5 })],
          },
        });
      } finally {
        restorePolicies.reverse().forEach((restore) => {
          restore();
        });
      }

      const crossTenant = await withTenant({ tenantId: 'tenant-other' }, () =>
        new MCPGenerator(
          { classNames: ['@happyvertical/smrt-commerce:Invoice'] },
          {
            db,
            user: { id: 'other-reader' },
            tenantId: 'tenant-other',
          },
        ).handleToolCall({
          method: 'tools/call',
          params: { name: 'invoice_get', arguments: { id: invoice.id } },
        }),
      );
      expect(crossTenant.isError).toBe(true);
    });
  });

  it('resolves a product tax default ahead of customer and application defaults', async () => {
    const customerCodeId = await activateV2('tenant-product');
    await withTenant({ tenantId: 'tenant-product' }, async () => {
      const components = await TaxComponentCollection.create({ db });
      const pst = await components.create({ name: 'PST', percent: '7' });
      const codes = await TaxCodeCollection.create({ db });
      const productCode = await codes.create({
        code: 'pst',
        name: 'PST',
        components: [{ taxComponentId: pst.id, compound: false }],
      });
      const products = await ProductCollection.create({ db });
      const product = await products.create({
        name: 'Tax-specific product',
        defaultSalesTaxCodeId: productCode.id,
      });
      const customers = await CustomerCollection.create({ db });
      const customer = await customers.create({
        defaultTaxCodeId: customerCodeId,
      });
      const invoices = await InvoiceCollection.create({ db });
      const invoice = await invoices.create({
        customerId: customer.id,
        invoiceNumber: 'INV-PRODUCT',
        currency: 'CAD',
      });
      const lines = await InvoiceLineItemCollection.create({ db });
      const line = await lines.create({
        invoiceId: invoice.id,
        description: 'Product default',
        productId: product.id,
        quantity: 1,
        unitPrice: 100,
      });

      expect(line).toMatchObject({
        taxCodeId: productCode.id,
        taxCodeCode: 'pst',
        taxAmount: 7,
      });
    });
  });

  it('blocks runtime money writes for the persisted migration owner window', async () => {
    const seeded = await ensureTenantTaxCodes(db, 'tenant-b');
    const outOfScopeId = seeded.find(
      (code) => code.code === 'out-of-scope',
    )?.id;
    if (!outOfScopeId) throw new Error('Expected out-of-scope seed');
    await withTenant({ tenantId: 'tenant-b' }, async () => {
      const customers = await CustomerCollection.create({ db });
      const customer = await customers.create({
        defaultTaxCodeId: outOfScopeId,
      });
      const invoices = await InvoiceCollection.create({ db });
      const invoice = await invoices.create({
        customerId: customer.id,
        invoiceNumber: 'LEGACY',
      });
      await expect(serializeInvoiceMcpGet(invoice)).resolves.not.toHaveProperty(
        'money',
      );
      const settings = await TaxSettingsCollection.create({ db });
      const migrationId = await settings.beginMoneyMigration('tenant-b');
      await expect(serializeInvoiceMcpGet(invoice)).rejects.toMatchObject({
        code: 'FROZEN_DOCUMENT',
      } satisfies Partial<MoneyValidationError>);
      const mcp = await new MCPGenerator(
        { classNames: ['@happyvertical/smrt-commerce:Invoice'] },
        {
          db,
          user: { id: 'invoice-reader' },
          tenantId: 'tenant-b',
        },
      ).handleToolCall({
        method: 'tools/call',
        params: { name: 'invoice_get', arguments: { id: invoice.id } },
      });
      expect(mcp).toMatchObject({
        isError: true,
        structuredContent: {
          error: { code: 'FROZEN_DOCUMENT' },
        },
      });
      const forged = await settings.getForTenant('tenant-b');
      if (!forged) throw new Error('Expected settings');
      forged.moneyModel = 'legacy';
      forged.moneyMigrationId = '';
      await expect(forged.save()).rejects.toMatchObject({
        code: 'FROZEN_DOCUMENT',
      } satisfies Partial<MoneyValidationError>);
      invoice.notes = 'blocked';
      await expect(invoice.save()).rejects.toMatchObject({
        code: 'FROZEN_DOCUMENT',
      } satisfies Partial<MoneyValidationError>);
      await settings.restoreLegacyMoneyModel('tenant-b', migrationId);
      await invoice.save();
      expect(invoice.notes).toBe('blocked');
    });
  });

  it('rolls back a failed sibling recompute and rejects line parent moves', async () => {
    const taxCodeId = await activateV2('tenant-atomic');
    await withTenant({ tenantId: 'tenant-atomic' }, async () => {
      const customers = await CustomerCollection.create({ db });
      const customer = await customers.create({ defaultTaxCodeId: taxCodeId });
      const invoices = await InvoiceCollection.create({ db });
      const first = await invoices.create({
        customerId: customer.id,
        invoiceNumber: 'ATOMIC-A',
        currency: 'CAD',
      });
      const second = await invoices.create({
        customerId: customer.id,
        invoiceNumber: 'ATOMIC-B',
        currency: 'CAD',
      });
      const lines = await InvoiceLineItemCollection.create({ db });
      const valid = await lines.create({
        invoiceId: first.id,
        description: 'Valid',
        quantity: 1,
        unitPrice: 100,
      });
      await expect(
        lines.create({
          invoiceId: first.id,
          description: 'Invalid discount',
          quantity: 1,
          unitPrice: 100,
          discountType: 'amount',
          discount: 101,
        }),
      ).rejects.toBeInstanceOf(MoneyValidationError);
      expect(await lines.findByInvoice(first.id)).toHaveLength(1);
      expect(
        await invoices.get({ id: first.id }, { cache: false }),
      ).toMatchObject({ subtotal: 100, taxAmount: 5, totalAmount: 105 });

      valid.invoiceId = second.id;
      await expect(valid.save()).rejects.toMatchObject({
        code: 'FROZEN_DOCUMENT',
      } satisfies Partial<MoneyValidationError>);
      expect(await lines.findByInvoice(first.id)).toHaveLength(1);
      expect(await lines.findByInvoice(second.id)).toHaveLength(0);
    });
  });
});
