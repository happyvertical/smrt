/**
 * Posting issued invoices into the settlement chart and sweeping unposted ones.
 */
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CustomerCollection } from '../collections/CustomerCollection.js';
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from '../collections/InvoiceLineItemCollection.js';
import { TaxCodeCollection } from '../collections/TaxCodeCollection.js';
import {
  ensureCommerceTenant,
  postInvoiceRevenueToSettlementChart,
  postPendingInvoiceRevenue,
} from '../index.js';
import { InvoiceStatus } from '../types/index.js';

const TENANT = '11111111-1111-4111-8111-111111111111';

// Invoice money writes use a SQLite-only call under PGlite; the sweep's
// PostgreSQL query is covered by invoice-revenue-sweep-pglite.test.ts.
describe.skipIf(process.env.SMRT_TEST_PGLITE === '1')(
  'invoice revenue sweep',
  () => {
    let db: DatabaseInterface;
    let seq = 0;

    beforeEach(async () => {
      db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
      enableTenancy();
      await ensureCommerceTenant(db, TENANT);
    });

    afterEach(async () => {
      disableTenancy();
      await db.close?.();
    });

    async function issue(status: InvoiceStatus = InvoiceStatus.SENT) {
      return withTenant({ tenantId: TENANT }, async () => {
        const exempt = await (
          await TaxCodeCollection.create({ db })
        ).findByCode('exempt', TENANT);
        const customer = await (await CustomerCollection.create({ db })).create(
          { defaultTaxCodeId: exempt!.id },
        );
        const invoices = await InvoiceCollection.create({ db });
        seq += 1;
        const created = await invoices.create({
          customerId: customer.id,
          invoiceNumber: `SWEEP-${seq}`,
          currency: 'CAD',
        });
        await (await InvoiceLineItemCollection.create({ db })).create({
          invoiceId: created.id,
          description: 'Line',
          quantity: 1,
          unitPrice: 300,
          taxMode: 'override',
          taxCodeId: exempt!.id,
        });
        const invoice = await invoices.get(
          { id: created.id },
          { cache: false },
        );
        if (status !== InvoiceStatus.DRAFT) {
          invoice!.status = InvoiceStatus.SENT;
          invoice!.sentAt = new Date('2026-11-20T12:00:00.000Z');
          await invoice!.save();
          if (status !== InvoiceStatus.SENT) {
            const fresh = await invoices.get(
              { id: created.id },
              { cache: false },
            );
            fresh!.status = status;
            await fresh!.save();
          }
        }
        return String(created.id);
      });
    }

    const arJournal = (id: string) =>
      withTenant({ tenantId: TENANT }, async () => {
        const invoice = await (await InvoiceCollection.create({ db })).get(
          { id },
          { cache: false },
        );
        return String(invoice?.arJournalId ?? '');
      });

    it('posts once and returns the same journal on repeat', async () => {
      const id = await issue();
      const first = await postInvoiceRevenueToSettlementChart(db, TENANT, id);
      expect(first.posted).toBe(true);
      expect(first.journalId).toBe(await arJournal(id));
      const again = await postInvoiceRevenueToSettlementChart(db, TENANT, id);
      expect(again).toEqual({ posted: false, journalId: first.journalId });
    });

    it('skips drafts, cancelled and written-off invoices', async () => {
      for (const status of [
        InvoiceStatus.DRAFT,
        InvoiceStatus.CANCELLED,
        InvoiceStatus.WRITTEN_OFF,
      ]) {
        const id = await issue(status);
        expect(
          await postInvoiceRevenueToSettlementChart(db, TENANT, id),
        ).toEqual({ posted: false, journalId: null });
        expect(await arJournal(id)).toBe('');
      }
    });

    it('sweeps only unposted issued invoices, once', async () => {
      const posted = await issue();
      await postInvoiceRevenueToSettlementChart(db, TENANT, posted);
      const a = await issue();
      const b = await issue();
      const cancelled = await issue(InvoiceStatus.CANCELLED);
      await issue(InvoiceStatus.DRAFT);
      expect(await postPendingInvoiceRevenue(db, TENANT, { limit: 1 })).toEqual(
        { posted: 2, reversed: 0, failed: 0, nextCursor: null },
      );
      expect(await arJournal(a)).not.toBe('');
      expect(await arJournal(b)).not.toBe('');
      expect(await arJournal(cancelled)).toBe('');
      expect(await postPendingInvoiceRevenue(db, TENANT)).toEqual({
        posted: 0,
        reversed: 0,
        failed: 0,
        nextCursor: null,
      });
    });

    it('counts a failing invoice and keeps going', async () => {
      const bad = await issue();
      const good = await issue();
      await db.query("UPDATE invoices SET currency = 'XXX' WHERE id = ?", bad);
      const errors: string[] = [];
      const result = await postPendingInvoiceRevenue(db, TENANT, {
        onError: (id) => errors.push(id),
      });
      expect(result.posted).toBe(1);
      expect(result.failed).toBe(1);
      expect(errors).toEqual([bad]);
      expect(await arJournal(good)).not.toBe('');
    });

    it('reverses a cancelled invoice that kept its revenue journal, once', async () => {
      const id = await issue();
      await postInvoiceRevenueToSettlementChart(db, TENANT, id);
      // A cancel that raced the post, or a reversal that failed.
      await db.query(
        "UPDATE invoices SET status = 'cancelled' WHERE id = ?",
        id,
      );
      const first = await postPendingInvoiceRevenue(db, TENANT);
      expect(first).toMatchObject({ reversed: 1, posted: 0, failed: 0 });
      const reversal = await withTenant(
        { tenantId: TENANT },
        async () =>
          (
            await (
              await InvoiceCollection.create({ db })
            ).get({ id }, { cache: false })
          )?.arReversalJournalId,
      );
      expect(reversal).toBeTruthy();
      expect(await postPendingInvoiceRevenue(db, TENANT)).toMatchObject({
        reversed: 0,
        posted: 0,
      });
    });

    it('resumes past invoices that fail every run instead of starving later ones', async () => {
      const bad = [await issue(), await issue(), await issue()];
      const good = await issue();
      for (const id of bad)
        await db.query("UPDATE invoices SET currency = 'XXX' WHERE id = ?", id);
      let cursor: string | null = null;
      let posted = 0;
      let failed = 0;
      for (let call = 0; call < 10; call += 1) {
        const result = await postPendingInvoiceRevenue(db, TENANT, {
          limit: 1,
          maxPages: 1,
          cursor,
        });
        posted += result.posted;
        failed += result.failed;
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      expect(cursor).toBeNull();
      expect(posted).toBe(1);
      expect(failed).toBe(3);
      expect(await arJournal(good)).not.toBe('');
    });
  },
);
