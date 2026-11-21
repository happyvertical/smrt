/**
 * The sweep's id query on the PostgreSQL dialect (PGlite, in-process).
 *
 * Invoice money writes are SQLite-only under PGlite, so rows are inserted
 * directly. `ar_journal_id` and the ids are UUID columns on PostgreSQL: an
 * uncast `= ''` or text comparison throws there and passes on SQLite.
 */
import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  selectCancelledUnreversedInvoiceIds,
  selectUnpostedInvoiceIds,
} from '../invoice-revenue-sweep.js';
import { InvoiceStatus } from '../types/index.js';

describe('selectUnpostedInvoiceIds on PostgreSQL (PGlite)', () => {
  let db: DatabaseInterface;
  const tenant = randomUUID();
  const other = randomUUID();
  const ids = Array.from({ length: 5 }, () => randomUUID()).sort();

  async function insert(
    id: string,
    tenantId: string,
    status: string,
    journal: string | null,
    kind = 'invoice',
    reversal: string | null = null,
  ) {
    await db.query(
      `INSERT INTO invoices (id, slug, tenant_id, kind, status, ar_journal_id, ar_reversal_journal_id, invoice_number, currency)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CAD')`,
      id,
      id,
      tenantId,
      kind,
      status,
      journal,
      reversal,
      `PG-${id.slice(0, 8)}`,
    );
  }

  beforeAll(async () => {
    db = await getTestDatabase({
      type: 'pglite',
      url: ':memory:',
      classes: ['Invoice'],
    });
    await insert(ids[0], tenant, InvoiceStatus.SENT, null);
    await insert(ids[1], tenant, InvoiceStatus.PAID, null);
    await insert(ids[2], tenant, InvoiceStatus.SENT, randomUUID());
    await insert(ids[3], tenant, InvoiceStatus.CANCELLED, null);
    await insert(ids[4], tenant, InvoiceStatus.CANCELLED, randomUUID());
    await insert(
      randomUUID(),
      tenant,
      InvoiceStatus.CANCELLED,
      randomUUID(),
      'invoice',
      randomUUID(),
    );
    await insert(randomUUID(), other, InvoiceStatus.SENT, null);
    await insert(randomUUID(), tenant, InvoiceStatus.DRAFT, null);
    await insert(randomUUID(), tenant, InvoiceStatus.SENT, null, 'credit_note');
  }, 60_000);

  afterAll(async () => {
    await db?.close?.();
  });

  it('returns only this tenant’s unposted, issued, non-cancelled invoices', async () => {
    const rows = await selectUnpostedInvoiceIds(db, tenant, null, 50);
    expect(rows.map((row) => row.id)).toEqual([ids[0], ids[1]]);
  });

  it('pages by id cursor', async () => {
    const first = await selectUnpostedInvoiceIds(db, tenant, null, 1);
    expect(first.map((row) => row.id)).toEqual([ids[0]]);
    const second = await selectUnpostedInvoiceIds(db, tenant, ids[0], 1);
    expect(second.map((row) => row.id)).toEqual([ids[1]]);
    expect(await selectUnpostedInvoiceIds(db, tenant, ids[1], 1)).toEqual([]);
  });

  it('finds cancelled invoices that kept a journal and were not reversed', async () => {
    const rows = await selectCancelledUnreversedInvoiceIds(
      db,
      tenant,
      null,
      50,
    );
    expect(rows.map((row) => row.id)).toEqual([ids[4]]);
  });
});
