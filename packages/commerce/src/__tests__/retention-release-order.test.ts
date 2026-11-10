import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { expect, it } from 'vitest';
import { CustomerCollection } from '../collections/CustomerCollection.js';
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import { withDocumentMoneyTransaction } from '../document-money-internal.js';
import { recordHistoricalSalesMoney } from '../historical-sales-money.js';
import { releaseInvoiceRetention } from '../invoice-retention.js';
import { parseInvoiceRetention } from '../retention-money.js';

async function proveReleaseOrder(db: DatabaseInterface) {
  const tenantId = randomUUID();
  await withTenant({ tenantId }, async () => {
    const invoices = await InvoiceCollection.create({ db });
    const customer = await (await CustomerCollection.create({ db })).create({
      name: 'Synthetic release ordering',
    });
    const source = (key: string) => ({
      namespace: 'release-order-regression',
      key,
      version: '1',
      issuedOn: '2020-01-01',
      dueOn: null,
      timeZone: 'America/Edmonton',
      approval: null,
    });
    for (const order of [
      'release-before-credit',
      'credit-before-release',
      null,
    ] as const) {
      const invoice = await invoices.create({
        customerId: String(customer.id),
        currency: 'CAD',
      });
      const invoiceId = String(invoice.id);
      await recordHistoricalSalesMoney({
        db,
        tenantId,
        invoiceId,
        requestId: invoiceId,
        evidenceRef: 'original-document',
        review: { actorId: 'import-reviewer', policyRef: 'review-v1' },
        source: {
          ...source(invoiceId),
          retention: {
            retainedMinor: 500,
            creditPolicy: 'retained-first',
            policyRef: 'original-rule',
            effectiveOn: '2020-01-01',
            evidenceRef: 'original-hold',
            originalActorRef: null,
            releases: [],
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
        const loaded = await invoices.get({ id: invoiceId }, { cache: false });
        if (!loaded) throw new Error('Missing invoice');
        return loaded;
      };
      const input = {
        db,
        tenantId,
        invoiceId,
        currency: 'CAD',
        requestId: 'release',
        policyVersion: 'reviewed-release-v1',
        actorId: 'release-reviewer',
        evidenceRef: 'reviewed-order',
        reason: 'Explicit dated release',
        amountMinor: 500,
        effectiveOn: '2020-02-01',
        expectedUpdatedAt: new Date(
          (await load()).updated_at ?? '',
        ).toISOString(),
        ...(order ? { sameDayCreditOrder: order } : {}),
      };
      if (order === 'release-before-credit') {
        await expect(
          withDocumentMoneyTransaction(db, async (tx) => {
            await releaseInvoiceRetention({ ...input, db: tx });
            throw new Error('rollback-order');
          }),
        ).rejects.toThrow('rollback-order');
        expect(
          parseInvoiceRetention((await load()).retentionStateJson)?.releases,
        ).toHaveLength(0);
        await expect(
          releaseInvoiceRetention({
            ...input,
            sameDayCreditOrder: 'invented-order' as never,
          }),
        ).rejects.toThrow('ordering');
        expect(
          parseInvoiceRetention((await load()).retentionStateJson)?.releases,
        ).toHaveLength(0);
      }
      await releaseInvoiceRetention(input);
      const retained = (await load()).retentionStateJson;
      expect(
        parseInvoiceRetention(retained)?.releases[0].sameDayCreditOrder,
      ).toBe(order ?? undefined);
      await releaseInvoiceRetention(input);
      expect((await load()).retentionStateJson).toBe(retained);
      await expect(
        releaseInvoiceRetention({
          ...input,
          sameDayCreditOrder:
            order === 'release-before-credit'
              ? 'credit-before-release'
              : 'release-before-credit',
        }),
      ).rejects.toThrow('changed facts');
      expect((await load()).retentionStateJson).toBe(retained);
      const credit = await invoices.create({
        customerId: String(customer.id),
        currency: 'CAD',
        kind: 'credit_note',
        creditedInvoiceId: invoiceId,
      });
      const moneySnapshotId = (await load()).moneySnapshotId;
      if (!moneySnapshotId) throw new Error('Missing frozen original money');
      const creditInput = {
        db,
        tenantId,
        invoiceId: String(credit.id),
        requestId: 'credit',
        evidenceRef: 'same-day-source',
        review: { actorId: 'import-reviewer', policyRef: 'review-v1' },
        source: { ...source(String(credit.id)), issuedOn: '2020-02-01' },
        facts: {
          currency: 'CAD',
          kind: 'credit_note' as const,
          polarity: 'magnitudes' as const,
          netMinor: 100,
          taxMinor: 0,
          grossMinor: 100,
          taxComponents: null,
          detail: { kind: 'header-only' as const },
        },
        creditedSource: {
          invoiceId,
          moneySnapshotId,
        },
      };
      if (order === 'release-before-credit') {
        await recordHistoricalSalesMoney(creditInput);
        expect((await load()).creditedAmount).toBe(100);
      } else {
        await expect(recordHistoricalSalesMoney(creditInput)).rejects.toThrow(
          order ? /retention release/ : /explicit reviewed ordering/,
        );
        expect((await load()).creditedAmount).toBe(0);
      }
    }
  });
}
it('retains release ordering and applies actual historical same-day credit semantics on SQLite', async () => {
  const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  enableTenancy();
  try {
    await proveReleaseOrder(db);
  } finally {
    disableTenancy();
    await db.close?.();
  }
});
it.skipIf(!isPostgresAvailable())(
  'retains release ordering and replay authority on PostgreSQL',
  async () => {
    const isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
        'Customer',
        'Contract',
        'Invoice',
        'InvoiceLineItem',
        'HistoricalSalesLine',
        'DocumentTax',
        'TaxCode',
        'TaxComponent',
        'TaxSettings',
      ],
    });
    enableTenancy();
    try {
      await proveReleaseOrder(isolated.baseDb);
    } finally {
      disableTenancy();
      await isolated.cleanup();
    }
  },
  60000,
);
