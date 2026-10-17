import { randomUUID } from 'node:crypto';
import { withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { expect } from 'vitest';
import { CustomerCollection } from '../../collections/CustomerCollection.js';
import { InvoiceCollection } from '../../collections/InvoiceCollection.js';
import { withDocumentMoneyTransaction } from '../../document-money-internal.js';
import {
  getHistoricalSalesMoney,
  recordHistoricalSalesMoney,
} from '../../historical-sales-money.js';
import { releaseInvoiceRetention } from '../../invoice-retention.js';

export async function proveHistoricalDatedRelease(db: DatabaseInterface) {
  const tenantId = randomUUID();
  await withTenant({ tenantId }, async () => {
    const invoices = await InvoiceCollection.create({ db });
    const customer = await (await CustomerCollection.create({ db })).create({});
    const invoice = await invoices.create({
      customerId: String(customer.id),
      currency: 'CAD',
    });
    const invoiceId = String(invoice.id);
    const original = await recordHistoricalSalesMoney({
      db,
      tenantId,
      invoiceId,
      requestId: 'import',
      evidenceRef: 'original-document',
      review: { actorId: 'importer', policyRef: 'reviewed-policy' },
      source: {
        namespace: 'dated-release',
        key: invoiceId,
        version: '1',
        issuedOn: '2020-01-01',
        dueOn: null,
        timeZone: 'America/Edmonton',
        approval: null,
        retention: {
          retainedMinor: 500,
          creditPolicy: 'retained-first',
          policyRef: 'original-rule',
          effectiveOn: '2020-01-01',
          evidenceRef: 'original-hold',
          originalActorRef: null,
          releases: [
            {
              sourceKey: 'original-release',
              amountMinor: 100,
              effectiveOn: '2020-02-01',
              evidenceRef: 'original-release-evidence',
              originalActorRef: null,
            },
          ],
        },
      },
      facts: {
        currency: 'CAD',
        kind: 'invoice',
        polarity: 'magnitudes',
        netMinor: 1000,
        taxMinor: 0,
        grossMinor: 1000,
        taxComponents: null,
        detail: { kind: 'header-only' },
      },
    });
    const load = async () => {
      const row = await invoices.get({ id: invoiceId }, { cache: false });
      if (!row) throw new Error('Missing historical invoice');
      return row;
    };
    const input = {
      db,
      tenantId,
      invoiceId,
      currency: 'CAD',
      requestId: 'new-release',
      policyVersion: 'reviewed-release',
      actorId: 'reviewer',
      evidenceRef: 'new-release-evidence',
      reason: 'Approved retained amount',
      amountMinor: 200,
      effectiveOn: '2026-10-20',
      expectedUpdatedAt: new Date(
        (await load()).updated_at ?? '',
      ).toISOString(),
    };
    await expect(
      withDocumentMoneyTransaction(db, async (tx) => {
        await releaseInvoiceRetention({ ...input, db: tx });
        throw new Error('prove rollback');
      }),
    ).rejects.toThrow('prove rollback');
    expect(JSON.parse((await load()).retentionStateJson).releases).toHaveLength(
      1,
    );
    await releaseInvoiceRetention(input);
    const loaded = await load();
    expect(getHistoricalSalesMoney(loaded)).toEqual(original.snapshot);
    expect(JSON.parse(loaded.retentionStateJson).releases[1]).toMatchObject({
      effectiveOn: input.effectiveOn,
      amountMinor: 200,
    });
    await releaseInvoiceRetention(input);
    expect(JSON.parse((await load()).retentionStateJson).releases).toHaveLength(
      2,
    );
    await expect(
      releaseInvoiceRetention({ ...input, effectiveOn: '2026-10-21' }),
    ).rejects.toThrow();
    const changed = JSON.parse(loaded.retentionStateJson);
    changed.releases[0].effectiveOn = '2020-02-02';
    loaded.retentionStateJson = JSON.stringify(changed);
    expect(() => getHistoricalSalesMoney(loaded)).toThrow(
      'Original retention release projection changed',
    );
  });
}
