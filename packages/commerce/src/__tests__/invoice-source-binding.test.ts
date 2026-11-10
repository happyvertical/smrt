/** Commerce owns binding enforcement; source capacity stays behind the trusted package port. */
import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from '../collections/InvoiceLineItemCollection.js';
import {
  bindInvoiceLineSource,
  registerInvoiceSourceBinding,
  unbindInvoiceLineSource,
} from '../invoice-source-binding.js';
import { ensureCommerceTenant } from '../tax/tenant-bootstrap.js';

const TYPE = 'billable:@test/commerce:BindingSource';
let assigned: {
  reservationId: string;
  invoiceId: string;
  lineId: string;
  released: boolean;
};
registerInvoiceSourceBinding(
  TYPE,
  async ({ executor, invoice, line, reservationId, phase }) => {
    expect(executor).toBeTruthy();
    if (
      !assigned ||
      assigned.reservationId !== reservationId ||
      assigned.invoiceId !== invoice.id ||
      assigned.lineId !== line.id ||
      (phase === 'release' ? !assigned.released : assigned.released)
    )
      throw new Error('Owning source refuses binding');
  },
);
describe('protected invoice source binding', () => {
  let db: DatabaseInterface;
  let tenantId: string;
  beforeEach(async () => {
    enableTenancy();
    tenantId = randomUUID();
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  });
  afterEach(async () => {
    disableTenancy();
    await (db as { close?: () => Promise<void> })?.close?.();
  });
  const run = <T>(fn: () => Promise<T>) => withTenant({ tenantId }, fn);
  async function fixture() {
    await ensureCommerceTenant(db, tenantId);
    const invoices = await InvoiceCollection.create({ db });
    const invoice = await invoices.create({
      invoiceNumber: randomUUID(),
      currency: 'CAD',
    });
    const lines = await InvoiceLineItemCollection.create({ db });
    const line = await lines.create({
      invoiceId: invoice.id!,
      unitPrice: 60,
      sourceType: TYPE,
      sourceId: randomUUID(),
    });
    assigned = {
      reservationId: randomUUID(),
      invoiceId: invoice.id!,
      lineId: line.id!,
      released: false,
    };
    return { invoices, invoice, lines, line };
  }
  it('requires trusted handler and existing exact reservation; ordinary invoices remain unaffected', async () =>
    run(async () => {
      const { invoice, lines, line } = await fixture();
      await expect(
        lines.create({
          invoiceId: invoice.id!,
          sourceType: 'billable:@unknown/absent:Source',
          sourceId: randomUUID(),
          unitPrice: 10,
        }),
      ).rejects.toThrow();
      invoice.markSent();
      await expect(invoice.save()).rejects.toThrow();
      await invoice.loadFromId();
      await expect(
        bindInvoiceLineSource({
          db,
          tenantId,
          lineId: line.id!,
          reservationId: randomUUID(),
        }),
      ).rejects.toThrow('Owning source');
      await bindInvoiceLineSource({
        db,
        tenantId,
        lineId: line.id!,
        reservationId: assigned.reservationId,
      });
      await line.loadFromId();
      expect(line.sourceReservationId).toBe(assigned.reservationId);
      line.sourceType = 'manual';
      line.sourceReservationId = null;
      await expect(line.save()).rejects.toThrow();
      await line.loadFromId();
      await expect(lines.delete(line.id!)).rejects.toThrow();
      await expect(
        lines.create({
          invoiceId: invoice.id!,
          sourceType: TYPE,
          sourceId: line.sourceId,
          sourceReservationId: assigned.reservationId,
          unitPrice: 60,
        }),
      ).rejects.toThrow();
      await invoice.loadFromId();
      invoice.markSent();
      await invoice.save();
      assigned.released = true;
      await expect(
        unbindInvoiceLineSource({
          db,
          tenantId,
          lineId: line.id!,
          reservationId: assigned.reservationId,
        }),
      ).rejects.toThrow('Issued');
    }));
  it('withdraws a draft only after owner release and permits ordinary source edits afterward', async () =>
    run(async () => {
      const { invoice, line } = await fixture();
      await bindInvoiceLineSource({
        db,
        tenantId,
        lineId: line.id!,
        reservationId: assigned.reservationId,
      });
      await expect(
        unbindInvoiceLineSource({
          db,
          tenantId,
          lineId: line.id!,
          reservationId: assigned.reservationId,
        }),
      ).rejects.toThrow('Owning source');
      assigned.released = true;
      await unbindInvoiceLineSource({
        db,
        tenantId,
        lineId: line.id!,
        reservationId: assigned.reservationId,
      });
      await line.loadFromId();
      line.sourceType = 'manual';
      line.sourceId = '';
      await line.save();
      await invoice.loadFromId();
      invoice.markSent();
      await invoice.save();
    }));
});
