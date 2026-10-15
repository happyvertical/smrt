/**
 * PostgreSQL parity for the clean-tenant money v2 default (#4009). Two
 * connections race the first marker decision; the advisory lock plus the
 * re-read must converge on one row and one model.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { Cookbook } from '@happyvertical/smrt-types';
import { isPostgresAvailable } from '@happyvertical/smrt-vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from '../collections/InvoiceLineItemCollection.js';
import { TaxCodeCollection } from '../collections/TaxCodeCollection.js';
import { TaxSettingsCollection } from '../collections/TaxSettingsCollection.js';
import { ensureCommerceTenant } from '../index.js';
import { seedLegacyMoneyTenant } from './helpers/legacy-money-tenant.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres(
  'clean tenants default to money v2 on PostgreSQL (#4009)',
  () => {
    let db: DatabaseInterface;
    let peer: DatabaseInterface;

    beforeEach(async () => {
      if (!process.env.DATABASE_URL)
        throw new Error('DATABASE_URL is required');
      db = await getTestDatabase({
        type: 'postgres',
        url: process.env.DATABASE_URL,
      });
      peer = await getTestDatabase({
        type: 'postgres',
        url: process.env.DATABASE_URL,
      });
      enableTenancy();
    });

    afterEach(async () => {
      disableTenancy();
      await peer?.close?.();
      await db?.close?.();
    });

    const markers = (tenantId: string) =>
      withTenant({ tenantId }, async () =>
        (await TaxSettingsCollection.create({ db })).list({
          where: { tenantId },
        }),
      );

    const firstDocument = (
      executor: DatabaseInterface,
      tenantId: string,
      n: number,
    ) =>
      withTenant({ tenantId }, async () => {
        const invoice = await (
          await InvoiceCollection.create({ db: executor })
        ).create({ invoiceNumber: `PG-RACE-${n}`, currency: 'CAD' });
        return (
          await InvoiceLineItemCollection.create({ db: executor })
        ).create({
          invoiceId: invoice.id,
          description: `Race ${n}`,
          quantity: 1,
          unitPrice: 100 * n,
        });
      });

    it('gives first documents racing on two connections one v2 marker', async () => {
      const tenantId = randomUUID();
      const lines = await Promise.all([
        firstDocument(db, tenantId, 1),
        firstDocument(peer, tenantId, 2),
        firstDocument(db, tenantId, 3),
        firstDocument(peer, tenantId, 4),
      ]);
      expect(lines.map((line) => line.amount)).toEqual([100, 200, 300, 400]);
      expect(await markers(tenantId)).toMatchObject([{ moneyModel: 'v2' }]);
    });

    it('converges racing marker seeds from two connections on one row', async () => {
      const tenantId = randomUUID();
      const seeds = await Promise.all(
        [db, peer, db, peer].map((executor) =>
          withTenant({ tenantId }, async () =>
            (
              await TaxSettingsCollection.create({ db: executor })
            ).getOrCreateForTenant(tenantId),
          ),
        ),
      );
      expect(new Set(seeds.map((row) => row.id)).size).toBe(1);
      expect(seeds.every((row) => row.moneyModel === 'v2')).toBe(true);
    });

    it('keeps a tenant with documents written before its marker on legacy', async () => {
      const tenantId = randomUUID();
      await seedLegacyMoneyTenant(db, tenantId);
      await withTenant({ tenantId }, async () => {
        await (await InvoiceCollection.create({ db })).create({
          invoiceNumber: 'PG-PRE-MARKER',
        });
      });
      await db.query(
        'DELETE FROM tax_settings WHERE CAST(tenant_id AS TEXT) = ?',
        tenantId,
      );
      await expect(ensureCommerceTenant(peer, tenantId)).resolves.toEqual({
        tenantId,
        moneyModel: 'legacy',
      });
      expect(await markers(tenantId)).toMatchObject([{ moneyModel: 'legacy' }]);
    });

    it('sees documents the caller cannot read under row policies', async () => {
      const tenantId = randomUUID();
      await seedLegacyMoneyTenant(db, tenantId);
      await withTenant({ tenantId }, async () => {
        await (await InvoiceCollection.create({ db })).create({
          invoiceNumber: 'PG-HIDDEN',
        });
      });
      await db.query(
        'DELETE FROM tax_settings WHERE CAST(tenant_id AS TEXT) = ?',
        tenantId,
      );
      // Model a principal without invoice read permission: rows are visible
      // only in system context, as with the generated permission policies.
      await db.query('ALTER TABLE invoices ENABLE ROW LEVEL SECURITY');
      await db.query('ALTER TABLE invoices FORCE ROW LEVEL SECURITY');
      await db.query(
        "CREATE POLICY smrt_4009_system_only ON invoices USING (COALESCE(NULLIF(current_setting('smrt.system_context', true), ''), 'false')::boolean)",
      );
      try {
        expect(
          (
            await db.query(
              'SELECT 1 FROM invoices WHERE CAST(tenant_id AS TEXT) = ?',
              tenantId,
            )
          ).rows,
        ).toEqual([]);
        await withTenant({ tenantId }, async () => {
          await expect(
            (await TaxSettingsCollection.create({ db })).getOrCreateForTenant(
              tenantId,
            ),
          ).resolves.toMatchObject({ moneyModel: 'legacy' });
        });
        // The scan restores the caller's context afterwards.
        const restored = await db.query(
          "SELECT COALESCE(current_setting('smrt.system_context', true), '') AS value",
        );
        expect(restored.rows[0]?.value).not.toBe('true');
      } finally {
        await db.query(
          'DROP POLICY IF EXISTS smrt_4009_system_only ON invoices',
        );
        await db.query('ALTER TABLE invoices NO FORCE ROW LEVEL SECURITY');
        await db.query('ALTER TABLE invoices DISABLE ROW LEVEL SECURITY');
      }
    });

    it('bootstraps a clean tenant from a cookbook', async () => {
      const tenantId = randomUUID();
      const cookbook: Pick<Cookbook, 'policies'> = {
        policies: [
          {
            objectRef: '@happyvertical/smrt-commerce:InvoiceLineItem',
            fieldName: 'taxRate',
            scopeType: 'app',
            defaultValue: '0.05',
          },
          {
            objectRef: '@happyvertical/smrt-commerce:Invoice',
            fieldName: 'lineAmountType',
            scopeType: 'app',
            defaultValue: '"inclusive"',
          },
          {
            objectRef: '@happyvertical/smrt-commerce:Invoice',
            fieldName: 'taxRoundingScope',
            scopeType: 'app',
            defaultValue: '"document"',
          },
        ] as Cookbook['policies'],
      };
      await expect(
        ensureCommerceTenant(db, tenantId, { cookbook }),
      ).resolves.toEqual({ tenantId, moneyModel: 'v2' });
      await withTenant({ tenantId }, async () => {
        const code = await (await TaxCodeCollection.create({ db })).findByCode(
          'default-5',
        );
        expect(
          await (await TaxSettingsCollection.create({ db })).getForTenant(
            tenantId,
          ),
        ).toMatchObject({
          moneyModel: 'v2',
          defaultLineAmountType: 'inclusive',
          taxRoundingScope: 'document',
          defaultSalesTaxCodeId: code?.id,
        });
      });
    });
  },
);
