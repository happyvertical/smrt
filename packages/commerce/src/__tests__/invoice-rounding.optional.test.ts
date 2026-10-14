import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { AccountCollection } from '@happyvertical/smrt-ledgers';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { isPostgresAvailable } from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomerCollection } from '../collections/CustomerCollection.js';
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from '../collections/InvoiceLineItemCollection.js';
import { PaymentAllocationCollection } from '../collections/PaymentAllocationCollection.js';
import { PaymentCollection } from '../collections/PaymentCollection.js';
import { migrateInvoiceRoundingStorage } from '../migrations/invoiceRoundingStorage.js';
import { Invoice } from '../models/Invoice.js';
import { InvoiceStatus } from '../types/index.js';

const classes = [
  'Customer',
  'Contract',
  'ContractLineItem',
  'Invoice',
  'InvoiceLineItem',
  'Payment',
  'PaymentAllocation',
  'Account',
  'Journal',
  'JournalEntry',
];
for (const engine of [
  'sqlite',
  ...(isPostgresAvailable() ? ['postgres'] : []),
]) {
  describe(`invoice-rounded persistence (${engine})`, () => {
    let db: DatabaseInterface;
    let cleanup: () => Promise<void>;
    let connectionUrl: string | undefined;
    beforeEach(async () => {
      if (engine === 'postgres') {
        const baseUrl = process.env.DATABASE_URL;
        if (!baseUrl) throw new Error('PostgreSQL tests require DATABASE_URL');
        const admin = await getTestDatabase({
          type: 'postgres',
          url: baseUrl,
          classes: [],
        });
        const schema = `invoice_rounding_${randomUUID().replaceAll('-', '')}`;
        let owned: DatabaseInterface | undefined;
        cleanup = async () => {
          try {
            await owned?.close?.();
          } finally {
            try {
              await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
            } finally {
              await admin.close?.();
            }
          }
        };
        try {
          await admin.query(`CREATE SCHEMA "${schema}"`);
          const url = new URL(baseUrl);
          const options = url.searchParams.get('options');
          url.searchParams.set(
            'options',
            `${options ? `${options} ` : ''}-c search_path=${schema}`,
          );
          connectionUrl = url.toString();
          owned = await getTestDatabase({
            type: 'postgres',
            url: url.toString(),
            classes,
          });
          db = owned;
          expect(
            (await db.query('SELECT current_schema() AS name')).rows[0].name,
          ).toBe(schema);
        } catch (error) {
          await cleanup();
          cleanup = async () => {};
          throw error;
        }
      } else {
        db = await getTestDatabase({
          type: 'sqlite',
          url: ':memory:',
          classes,
        });
        cleanup = async () => {
          await db.close?.();
        };
      }
      enableTenancy();
    });
    afterEach(async () => {
      disableTenancy();
      await cleanup?.();
    });
    async function fixture(explicit = true) {
      const tenantId = randomUUID();
      const invoices = await InvoiceCollection.create({ db });
      const lines = await InvoiceLineItemCollection.create({ db });
      const customer = await (await CustomerCollection.create({ db })).create({
        tenantId,
        profileId: randomUUID(),
      });
      const invoice = await invoices.create({
        tenantId,
        customerId: customer.id,
        currency: 'CAD',
      });
      const policy = {
        tenantId,
        id: 'tax-policy',
        version: '1',
        currency: 'CAD',
        scope: 'invoice' as const,
        allocation: 'signed-largest-remainder' as const,
        calculation: 'invoice-resolved-v1' as const,
      };
      if (explicit) {
        invoice.configureRoundingPolicy(policy);
        await invoice.save();
      }
      const a = await lines.create({
        tenantId,
        invoiceId: invoice.id,
        quantity: 1,
        unitPrice: 10,
        taxRate: 0.05,
      });
      const b = await lines.create({
        tenantId,
        invoiceId: invoice.id,
        quantity: 1,
        unitPrice: 10,
        taxRate: 0.05,
      });
      await invoice.loadFromId();
      await invoice.save();
      return { invoice, invoices, lines, a, b, policy, tenantId };
    }

    it('roundtrips allocated lines and header while preserving default per-line invoices', async () => {
      const f = await fixture();
      expect([
        f.invoice.subtotal,
        f.invoice.taxAmount,
        f.invoice.totalAmount,
      ]).toEqual([20, 1, 21]);
      const loaded = await f.lines.findByInvoice(f.invoice.id!);
      expect(loaded.reduce((sum, line) => sum + line.amount, 0)).toBe(21);
      expect(loaded.reduce((sum, line) => sum + line.getTaxAmount(), 0)).toBe(
        1,
      );
      expect(await f.lines.getTotalForInvoice(f.invoice.id!)).toBe(21);
      const legacy = await fixture(false);
      expect([legacy.invoice.taxAmount, legacy.invoice.totalAmount]).toEqual([
        2, 22,
      ]);
      expect(legacy.invoice.roundingPolicy).toBeNull();
    });

    it('redistributes on edits and deletes and clears totals after deleting the last line', async () => {
      const f = await fixture();
      await f.a.loadFromId();
      f.a.unitPrice = 30;
      await f.a.save();
      await f.invoice.loadFromId();
      expect([f.invoice.taxAmount, f.invoice.totalAmount]).toEqual([2, 42]);
      await f.a.delete();
      await f.invoice.loadFromId();
      expect(f.invoice.totalAmount).toBe(11);
      await f.b.loadFromId();
      await f.lines.delete(f.b.id!);
      await f.invoice.loadFromId();
      expect([
        f.invoice.subtotal,
        f.invoice.taxAmount,
        f.invoice.totalAmount,
      ]).toEqual([0, 0, 0]);
    });

    it('persists fractional editor discounts with mixed and exempt rates', async () => {
      const f = await fixture();
      const discounted = await f.lines.create({
        tenantId: f.tenantId,
        invoiceId: f.invoice.id,
      });
      discounted.applyEditorDraft(
        {
          key: discounted.id!,
          description: 'Discounted service',
          sku: '',
          quantity: '0.5',
          unitPrice: '2.00',
          discountType: 'percent',
          discountValue: '20',
          taxMode: 'inherit',
          taxRate: '',
        },
        { currency: 'CAD', inheritedTaxRate: '5' },
      );
      await discounted.save();
      await f.lines.create({
        tenantId: f.tenantId,
        invoiceId: f.invoice.id,
        unitPrice: 100,
        taxRate: 0.1,
      });
      await f.lines.create({
        tenantId: f.tenantId,
        invoiceId: f.invoice.id,
        unitPrice: 100,
        taxRate: 0,
      });
      await f.invoice.loadFromId();
      expect([
        f.invoice.subtotal,
        f.invoice.taxAmount,
        f.invoice.totalAmount,
      ]).toEqual([300, 15, 315]);
      const retained = await f.lines.get(discounted.id!, { cache: false });
      expect(
        retained!.getEditorDraft({ currency: 'CAD', inheritedTaxRate: '5' })
          ?.discountType,
      ).toBe('percent');
      expect(await f.lines.getTaxForInvoice(f.invoice.id!)).toBe(15);
    });

    it('rolls back a caller transaction including sibling redistribution and parent totals', async () => {
      const f = await fixture();
      await expect(
        db.transaction(async (tx) => {
          const lines = await InvoiceLineItemCollection.create({ db: tx });
          const a = await lines.get(f.a.id!);
          a!.unitPrice = 100;
          await a!.save();
          throw new Error('injected abort after allocation');
        }),
      ).rejects.toThrow('injected abort');
      await f.invoice.loadFromId();
      expect(f.invoice.totalAmount).toBe(21);
      expect((await f.lines.get(f.a.id!, { cache: false }))!.unitPrice).toBe(
        10,
      );
      expect(await f.lines.getTotalForInvoice(f.invoice.id!)).toBe(21);
    });

    it('freezes sent money and policy, allowing ordinary notes and payment status updates', async () => {
      const f = await fixture();
      f.invoice.markSent();
      await f.invoice.save();
      const frozen = f.invoice.invoiceRoundingFrozenJson;
      expect(frozen).not.toBe('');
      await f.a.loadFromId();
      f.a.unitPrice = 100;
      await expect(f.a.save()).rejects.toThrow('immutable');
      await expect(f.b.delete()).rejects.toThrow('immutable');
      await expect(
        f.lines.create({
          tenantId: f.tenantId,
          invoiceId: f.invoice.id,
          unitPrice: 1,
        }),
      ).rejects.toThrow('immutable');
      expect(() =>
        f.invoice.configureRoundingPolicy({ ...f.policy, version: '2' }),
      ).toThrow('immutable');
      f.invoice.notes = 'Reviewed';
      await f.invoice.save();
      expect(f.invoice.invoiceRoundingFrozenJson).toBe(frozen);
      const payments = await PaymentCollection.create({ db });
      const allocations = await PaymentAllocationCollection.create({ db });
      const payment = await payments.create({
        tenantId: f.tenantId,
        customerId: f.invoice.customerId,
        currency: 'CAD',
        amount: 22,
      });
      await expect(
        allocations.allocatePayment({
          paymentId: payment.id!,
          allocations: [
            { id: randomUUID(), invoiceId: f.invoice.id!, amount: 22 },
          ],
        }),
      ).rejects.toThrow();
      await allocations.allocatePayment({
        paymentId: payment.id!,
        allocations: [
          { id: randomUUID(), invoiceId: f.invoice.id!, amount: 21 },
        ],
      });
      await f.invoice.loadFromId();
      expect(f.invoice.status).toBe(InvoiceStatus.PAID);
      expect(f.invoice.invoiceRoundingFrozenJson).toBe(frozen);
      f.invoice.status = InvoiceStatus.DRAFT;
      expect(() =>
        f.invoice.configureRoundingPolicy({ ...f.policy, version: '2' }),
      ).toThrow('immutable');
    });

    it('denies cross-tenant selection, line writes and direct policy/snapshot forgery', async () => {
      const f = await fixture();
      await withTenant({ tenantId: randomUUID() }, async () => {
        expect(() => f.invoice.configureRoundingPolicy(f.policy)).toThrow();
        expect(
          await f.invoices.get(f.invoice.id!, { cache: false }),
        ).toBeNull();
      });
      await expect(
        f.lines.create({
          tenantId: randomUUID(),
          invoiceId: f.invoice.id,
          unitPrice: 1,
        }),
      ).rejects.toThrow();
      f.invoice.invoiceRoundingPolicyJson = JSON.stringify({
        ...f.policy,
        version: 'forged',
      });
      await expect(f.invoice.save()).rejects.toThrow('configureRoundingPolicy');
      await f.invoice.loadFromId();
      f.invoice.invoiceRoundingFrozenJson = '{}';
      await expect(f.invoice.save()).rejects.toThrow('server-managed');
    });

    it('rejects a tenant-hidden parent before inserting an unallocated line', async () => {
      const f = await fixture();
      f.invoice.status = InvoiceStatus.SENT;
      await f.invoice.save();
      const before = await db.query(
        'SELECT id FROM invoice_line_items WHERE invoice_id = ?',
        [f.invoice.id],
      );
      await withTenant({ tenantId: randomUUID() }, async () => {
        await expect(
          f.lines.create({
            invoiceId: f.invoice.id,
            quantity: 1,
            unitPrice: 10,
            taxRate: 0.05,
          }),
        ).rejects.toThrow();
      });
      expect(
        (
          await db.query(
            'SELECT id FROM invoice_line_items WHERE invoice_id = ?',
            [f.invoice.id],
          )
        ).rows,
      ).toEqual(before.rows);
      await f.invoice.loadFromId();
      expect(f.invoice.totalAmount).toBe(21);
    });

    it('uses normal tenant-context auto-population for new rounded lines', async () => {
      const f = await fixture();
      await withTenant({ tenantId: f.tenantId }, async () => {
        const line = await f.lines.create({
          invoiceId: f.invoice.id,
          quantity: 1,
          unitPrice: 10,
          taxRate: 0.05,
        });
        expect(line.tenantId).toBe(f.tenantId);
        await f.invoice.loadFromId();
        expect(f.invoice.totalAmount).toBe(32);
        await expect(
          f.lines.create({
            tenantId: randomUUID(),
            invoiceId: f.invoice.id,
            unitPrice: 10,
          }),
        ).rejects.toThrow();
      });
    });

    it('retries a successful freeze after an enclosing transaction rolls back', async () => {
      const f = await fixture();
      await expect(
        f.invoice.withTransaction(async () => {
          f.invoice.status = InvoiceStatus.SENT;
          await f.invoice.save();
          expect(f.invoice.invoiceRoundingFrozenJson).not.toBe('');
          throw new Error('outer freeze aborted');
        }),
      ).rejects.toThrow('outer freeze aborted');
      const stored = await f.invoices.get(f.invoice.id!, { cache: false });
      expect(stored!.invoiceRoundingFrozenJson).toBe('');
      expect(stored!.status).toBe(InvoiceStatus.DRAFT);
      await f.invoice.save();
      expect(f.invoice.invoiceRoundingFrozenJson).not.toBe('');
      expect(f.invoice.totalAmount).toBe(21);
    });

    it('rejects provider tax mixing without rewriting the approved policy', async () => {
      const f = await fixture();
      f.invoice.providerTaxAmount = 1;
      await expect(f.invoice.save()).rejects.toThrow('provider-managed');
      await f.invoice.loadFromId();
      expect(f.invoice.providerTaxAmount).toBe(0);
      expect(f.invoice.totalAmount).toBe(21);
    });

    it('retains the freeze after an undelivered paid invoice reverses to draft', async () => {
      const f = await fixture();
      const payments = await PaymentCollection.create({ db });
      const allocations = await PaymentAllocationCollection.create({ db });
      const payment = await payments.create({
        tenantId: f.tenantId,
        customerId: f.invoice.customerId,
        currency: 'CAD',
        amount: 21,
      });
      const allocationId = randomUUID();
      await allocations.allocatePayment({
        paymentId: payment.id!,
        allocations: [
          { id: allocationId, invoiceId: f.invoice.id!, amount: 21 },
        ],
      });
      await f.invoice.loadFromId();
      expect(f.invoice.status).toBe(InvoiceStatus.PAID);
      const frozen = f.invoice.invoiceRoundingFrozenJson;
      expect(frozen).not.toBe('');
      await allocations.delete(allocationId);
      await f.invoice.loadFromId();
      f.invoice.updatePaymentStatus(0);
      await f.invoice.save();
      expect(f.invoice.status).toBe(InvoiceStatus.DRAFT);
      expect(f.invoice.invoiceRoundingFrozenJson).toBe(frozen);
      expect(() =>
        f.invoice.configureRoundingPolicy({ ...f.policy, version: '2' }),
      ).toThrow('immutable');
      await expect(f.a.delete()).rejects.toThrow('immutable');
    });

    if (engine === 'postgres')
      it('serializes independent PostgreSQL writers without losing an allocation', async () => {
        const f = await fixture();
        const otherDb = await getTestDatabase({
          type: 'postgres',
          url: connectionUrl!,
          classes: [],
        });
        try {
          const otherLines = await InvoiceLineItemCollection.create({
            db: otherDb,
          });
          await Promise.all([
            f.lines.create({
              tenantId: f.tenantId,
              invoiceId: f.invoice.id,
              unitPrice: 10,
              taxRate: 0.05,
            }),
            otherLines.create({
              tenantId: f.tenantId,
              invoiceId: f.invoice.id,
              unitPrice: 10,
              taxRate: 0.05,
            }),
          ]);
          await f.invoice.loadFromId();
          expect([
            f.invoice.subtotal,
            f.invoice.taxAmount,
            f.invoice.totalAmount,
          ]).toEqual([40, 2, 42]);
          expect(await f.lines.getTotalForInvoice(f.invoice.id!)).toBe(42);
        } finally {
          await otherDb.close?.();
        }
      });

    it('retries the same authorized policy after its caller-owned transaction rolls back', async () => {
      const f = await fixture(false);
      await expect(
        f.invoice.withTransaction(async () => {
          f.invoice.configureRoundingPolicy(f.policy);
          await f.invoice.save();
          throw new Error('policy transaction aborted');
        }),
      ).rejects.toThrow('policy transaction aborted');
      expect(await f.lines.getTotalForInvoice(f.invoice.id!)).toBe(22);
      await f.invoice.save();
      expect(f.invoice.totalAmount).toBe(21);
      expect(await f.lines.getTotalForInvoice(f.invoice.id!)).toBe(21);
    });

    it('rolls back an internal post-allocation failure and retries the same line instance', async () => {
      const f = await fixture();
      await f.a.loadFromId();
      f.a.unitPrice = 40;
      const save = Invoice.prototype.save;
      const failing = vi
        .spyOn(Invoice.prototype, 'save')
        .mockImplementation(async function (this: Invoice) {
          await save.call(this);
          throw new Error('injected header completion failure');
        });
      try {
        await expect(f.a.save()).rejects.toThrow(
          'injected header completion failure',
        );
      } finally {
        failing.mockRestore();
      }
      await f.invoice.loadFromId();
      expect(f.invoice.totalAmount).toBe(21);
      expect(await f.lines.getTotalForInvoice(f.invoice.id!)).toBe(21);
      await f.a.save();
      await f.invoice.loadFromId();
      expect(f.invoice.totalAmount).toBe(53);
    });

    it('fails closed at generic provider export rather than asking a provider to round lines again', async () => {
      const f = await fixture();
      await expect(f.invoice.toAccountingInput()).rejects.toThrow(
        'allocated-tax support',
      );
      const allocated = await f.lines.findByInvoice(f.invoice.id!);
      expect(() => allocated[0].toAccountingLineItem()).toThrow(
        'allocated-tax support',
      );
      await expect(
        f.lines.toAccountingLineItems(f.invoice.id!),
      ).rejects.toThrow('allocated-tax support');
      const legacy = await fixture(false);
      expect((await legacy.invoice.toAccountingInput()).totalAmount).toBe(0.22);
    });

    it('rejects invalid revenue input without freezing an editable invoice', async () => {
      const f = await fixture();
      await expect(
        f.invoice.recognizeRevenue({
          arAccountId: randomUUID(),
          revenueAccountId: randomUUID(),
        }),
      ).rejects.toThrow('no taxAccountId');
      await f.invoice.loadFromId();
      expect(f.invoice.invoiceRoundingFrozenJson).toBe('');
      await f.a.loadFromId();
      f.a.unitPrice = 20;
      await f.a.save();
      await f.invoice.loadFromId();
      expect(f.invoice.totalAmount).toBe(32);
    });

    it('recognizes exactly the retained net and allocated tax and freezes before sending', async () => {
      const f = await fixture();
      await withTenant({ tenantId: f.tenantId }, async () => {
        const accounts = await AccountCollection.create({ db });
        const ar = await accounts.create({
          number: '1200',
          name: 'AR',
          type: 'asset',
        });
        const revenue = await accounts.create({
          number: '4000',
          name: 'Revenue',
          type: 'revenue',
        });
        const tax = await accounts.create({
          number: '2100',
          name: 'Tax',
          type: 'liability',
        });
        const journal = await f.invoice.recognizeRevenue({
          arAccountId: ar.id!,
          revenueAccountId: revenue.id!,
          taxAccountId: tax.id!,
        });
        const entries = await journal.getEntries();
        expect(entries.find((entry) => entry.accountId === ar.id)?.debit).toBe(
          21,
        );
        expect(
          entries.find((entry) => entry.accountId === revenue.id)?.credit,
        ).toBe(20);
        expect(
          entries.find((entry) => entry.accountId === tax.id)?.credit,
        ).toBe(1);
        expect(f.invoice.status).toBe(InvoiceStatus.DRAFT);
        expect(f.invoice.invoiceRoundingFrozenJson).not.toBe('');
        await expect(f.a.delete()).rejects.toThrow('immutable');
        await expect(f.invoice.delete()).rejects.toThrow('cannot be deleted');
      });
    });

    it('rejects stale sibling writes and preserves collection recalculation allocations', async () => {
      const f = await fixture();
      const held = await f.lines.get(f.a.id!, { cache: false });
      const current = await f.lines.get(f.a.id!, { cache: false });
      current!.unitPrice = 40;
      await current!.save();
      held!.unitPrice = 50;
      await expect(held!.save()).rejects.toThrow();
      const recalculated = await f.lines.recalculateAmounts(f.invoice.id!);
      expect(recalculated.reduce((sum, line) => sum + line.amount, 0)).toBe(53);
      await f.invoice.loadFromId();
      expect(f.invoice.totalAmount).toBe(53);
    });

    it('adds missing columns to a historical schema without rewriting its money', async () => {
      const f = await fixture(false);
      await db.query(
        'ALTER TABLE invoices DROP COLUMN invoice_rounding_policy_json',
      );
      await db.query(
        'ALTER TABLE invoices DROP COLUMN invoice_rounding_frozen_json',
      );
      await db.query(
        'ALTER TABLE invoice_line_items DROP COLUMN invoice_tax_allocation_json',
      );
      const result = await migrateInvoiceRoundingStorage(
        db,
        engine as 'sqlite' | 'postgres',
      );
      expect(result.addedColumns).toHaveLength(3);
      expect(
        (
          await migrateInvoiceRoundingStorage(
            db,
            engine as 'sqlite' | 'postgres',
          )
        ).addedColumns,
      ).toEqual([]);
      await f.invoice.loadFromId();
      expect([f.invoice.taxAmount, f.invoice.totalAmount]).toEqual([2, 22]);
      expect(f.invoice.roundingPolicy).toBeNull();
      await f.invoice.save();
      expect(f.invoice.totalAmount).toBe(22);
    });

    it('rolls back all added migration columns with an enclosing maintenance transaction', async () => {
      await db.query(
        'ALTER TABLE invoices DROP COLUMN invoice_rounding_policy_json',
      );
      await db.query(
        'ALTER TABLE invoices DROP COLUMN invoice_rounding_frozen_json',
      );
      await db.query(
        'ALTER TABLE invoice_line_items DROP COLUMN invoice_tax_allocation_json',
      );
      await expect(
        db.transaction(async (tx) => {
          await migrateInvoiceRoundingStorage(
            tx,
            engine as 'sqlite' | 'postgres',
          );
          throw new Error('maintenance abort');
        }),
      ).rejects.toThrow('maintenance abort');
      expect(
        (
          await migrateInvoiceRoundingStorage(
            db,
            engine as 'sqlite' | 'postgres',
          )
        ).addedColumns,
      ).toHaveLength(3);
    });

    it('keeps the additive migration idempotent and historical amounts untouched', async () => {
      const f = await fixture(false);
      const first = await migrateInvoiceRoundingStorage(
        db,
        engine as 'sqlite' | 'postgres',
      );
      expect(first.addedColumns).toEqual([]);
      expect(
        await migrateInvoiceRoundingStorage(
          db,
          engine as 'sqlite' | 'postgres',
        ),
      ).toEqual(first);
      await f.invoice.loadFromId();
      expect(f.invoice.totalAmount).toBe(22);
      expect(f.invoice.roundingPolicy).toBeNull();
    });
  });
}
