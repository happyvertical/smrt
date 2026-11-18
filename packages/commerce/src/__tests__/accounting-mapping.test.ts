/** Accounting mapping records and customer resolution (#5137). */
import type { InvoiceInput, SyncResult } from '@happyvertical/accounting';
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AccountingCustomerDirectory,
  AccountingMappingError,
  buildFrozenInvoiceMapping,
  confirmAccountingCustomer,
  getAccountingMapping,
  getAccountingMappingScope,
  listAccountingMappings,
  removeAccountingMapping,
  resolveAccountingCustomer,
  setAccountingMapping,
} from '../accounting-mapping.js';
import { syncFrozenInvoiceToAccounting } from '../invoice-accounting-sync.js';
import {
  connectFixtureTenant,
  FakeSecrets,
  issuedFixtureInvoice,
} from './helpers/accounting-fixtures.js';

const TENANT = '33333333-3333-4333-8333-333333333331';

describe('accounting mappings (#5137)', () => {
  let db: DatabaseInterface;
  let secrets: FakeSecrets;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy();
    secrets = new FakeSecrets();
  });
  afterEach(async () => {
    disableTenancy();
    await db.close?.();
  });

  async function seed() {
    await connectFixtureTenant(db, TENANT, { secrets });
    const seeded = await issuedFixtureInvoice(db, TENANT);
    const scope = await getAccountingMappingScope({ db }, TENANT);
    return { ...seeded, scope };
  }

  async function mapEverything(s: Awaited<ReturnType<typeof seed>>) {
    const set = (
      kind: Parameters<typeof setAccountingMapping>[2]['kind'],
      localId: string,
      externalId: string,
    ) => setAccountingMapping({ db }, s.scope, { kind, localId, externalId });
    await set('customer', s.customerId, 'qb-cust-1');
    await set('item', 'default', 'qb-item-default');
    await set('tax_code', s.taxCodeId, 'qb-tax-gst');
    await set('tax_component', s.componentId, 'qb-rate-gst');
  }

  it('scopes mappings by tenant, realm and environment', async () => {
    const s = await seed();
    await setAccountingMapping({ db }, s.scope, {
      kind: 'item',
      localId: 'default',
      externalId: 'i-1',
    });
    expect(
      (await getAccountingMapping({ db }, s.scope, 'item', 'default'))
        ?.externalId,
    ).toBe('i-1');
    for (const other of [
      { ...s.scope, realmId: 'realm-b' },
      { ...s.scope, environment: 'production' as const },
      { ...s.scope, tenantId: '33333333-3333-4333-8333-333333333332' },
    ])
      expect(
        await getAccountingMapping({ db }, other, 'item', 'default'),
      ).toBeNull();
    // Upsert replaces; unique per key.
    await setAccountingMapping({ db }, s.scope, {
      kind: 'item',
      localId: 'default',
      externalId: 'i-2',
    });
    expect(await listAccountingMappings({ db }, s.scope, 'item')).toHaveLength(
      1,
    );
    expect(
      await removeAccountingMapping({ db }, s.scope, 'item', 'default'),
    ).toBe(true);
    expect(
      await removeAccountingMapping({ db }, s.scope, 'item', 'default'),
    ).toBe(false);
  });

  it('refuses direct writes to a mapping', async () => {
    const s = await seed();
    const row = await setAccountingMapping({ db }, s.scope, {
      kind: 'item',
      localId: 'default',
      externalId: 'i-1',
    });
    row.externalId = 'forged';
    await expect(
      withTenant({ tenantId: TENANT }, () => row.save()),
    ).rejects.toThrow(/only by the accounting-mapping commands/);
    await expect(
      withTenant({ tenantId: TENANT }, () => row.delete()),
    ).rejects.toThrow(/only by removeAccountingMapping/);
  });

  it('invalidates, never reuses, mappings when the realm or environment changes', async () => {
    const s = await seed();
    await mapEverything(s);
    await buildFrozenInvoiceMapping({
      db,
      tenantId: TENANT,
      invoiceId: s.invoice.id,
    });
    // Reconnect to another company.
    await connectFixtureTenant(db, TENANT, { realmId: 'realm-b', secrets });
    const rows = (
      await db.query('SELECT status, realm_id FROM accounting_mappings')
    ).rows;
    expect(rows.length).toBe(4);
    expect(
      rows.every((r: { status: string }) => r.status === 'invalidated'),
    ).toBe(true);
    await expect(
      buildFrozenInvoiceMapping({
        db,
        tenantId: TENANT,
        invoiceId: s.invoice.id,
      }),
    ).rejects.toMatchObject({ code: 'MAPPING_INCOMPLETE' });
    // Environment switch on the same realm also leaves the old set unused.
    await connectFixtureTenant(db, TENANT, {
      realmId: 'realm-b',
      environment: 'production',
      secrets,
    });
    const scope = await getAccountingMappingScope({ db }, TENANT);
    expect(scope).toMatchObject({
      realmId: 'realm-b',
      environment: 'production',
    });
    expect(await listAccountingMappings({ db }, scope)).toHaveLength(0);
  });

  it('builds the frozen mapping from records and the sync uses the scoped customer', async () => {
    const s = await seed();
    await mapEverything(s);
    const mapping = await buildFrozenInvoiceMapping({
      db,
      tenantId: TENANT,
      invoiceId: s.invoice.id,
    });
    expect(mapping).toEqual({
      realmId: 'realm-a',
      environment: 'sandbox',
      customerRef: 'qb-cust-1',
      lines: {
        [s.lineId]: { itemRef: 'qb-item-default', taxCodeRef: 'qb-tax-gst' },
      },
      components: { [s.componentId]: { quickbooksTaxRateRef: 'qb-rate-gst' } },
    });
    const push = vi.fn(
      async (_input: InvoiceInput): Promise<SyncResult> => ({
        action: 'created',
        externalId: 'qb-inv-1',
        syncedAt: new Date('2026-11-01T00:00:00Z'),
      }),
    );
    await withTenant({ tenantId: TENANT }, async () => {
      await syncFrozenInvoiceToAccounting({
        db,
        tenantId: TENANT,
        invoiceId: s.invoice.id,
        mapping,
        provider: { type: 'quickbooks', invoices: { push } as never },
      });
    });
    // The flat, unscoped Invoice.customerExternalId ('flat-unscoped') is not sent.
    expect(push.mock.calls[0]?.[0].customerExternalId).toBe('qb-cust-1');
  });

  it('lists every missing mapping instead of guessing', async () => {
    const s = await seed();
    await setAccountingMapping({ db }, s.scope, {
      kind: 'item',
      localId: 'default',
      externalId: 'i',
    });
    const error = await buildFrozenInvoiceMapping({
      db,
      tenantId: TENANT,
      invoiceId: s.invoice.id,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(AccountingMappingError);
    expect(error.missing).toEqual(
      expect.arrayContaining([
        { kind: 'customer', localId: s.customerId },
        { kind: 'tax_code', localId: s.taxCodeId },
        { kind: 'tax_component', localId: s.componentId },
      ]),
    );
    expect(error.missing).toHaveLength(3);
  });

  it('prefers a sku item mapping over the default', async () => {
    await connectFixtureTenant(db, TENANT, { secrets });
    const s = {
      ...(await issuedFixtureInvoice(db, TENANT, { sku: 'CONSULT' })),
      scope: await getAccountingMappingScope({ db }, TENANT),
    };
    await mapEverything(s as never);
    await setAccountingMapping({ db }, s.scope, {
      kind: 'item',
      localId: 'sku:CONSULT',
      externalId: 'qb-item-consult',
    });
    const mapping = await buildFrozenInvoiceMapping({
      db,
      tenantId: TENANT,
      invoiceId: s.invoice.id,
    });
    expect(mapping.lines[s.lineId]?.itemRef).toBe('qb-item-consult');
  });

  describe('customer resolution', () => {
    const facts = (id: string) => ({
      customerId: id,
      name: 'Acme Ltd',
      email: 'ap@acme.test',
    });
    function directory(
      found: Array<{ externalId: string; name: string; email?: string }>,
    ) {
      const create = vi.fn(async () => ({ externalId: 'qb-new' }));
      const find = vi.fn(async () => found);
      return {
        dir: { find, create } as AccountingCustomerDirectory,
        create,
        find,
      };
    }

    it('uses an existing mapping without calling the provider', async () => {
      const s = await seed();
      await setAccountingMapping({ db }, s.scope, {
        kind: 'customer',
        localId: s.customerId,
        externalId: 'qb-9',
      });
      const { dir, find, create } = directory([]);
      const result = await resolveAccountingCustomer({
        db,
        tenantId: TENANT,
        customer: facts(s.customerId),
        directory: dir,
      });
      expect(result).toEqual({
        status: 'mapped',
        externalId: 'qb-9',
        source: 'mapping',
      });
      expect(find).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    });

    it('links a single exact match and records it', async () => {
      const s = await seed();
      const { dir, create } = directory([
        { externalId: 'qb-7', name: 'ACME LTD', email: 'AP@acme.test' },
      ]);
      const result = await resolveAccountingCustomer({
        db,
        tenantId: TENANT,
        customer: facts(s.customerId),
        directory: dir,
      });
      expect(result).toEqual({
        status: 'mapped',
        externalId: 'qb-7',
        source: 'found',
      });
      expect(create).not.toHaveBeenCalled();
      expect(
        (await getAccountingMapping({ db }, s.scope, 'customer', s.customerId))
          ?.externalId,
      ).toBe('qb-7');
    });

    it('creates only when nothing matches, with a stable request id, once', async () => {
      const s = await seed();
      const created: string[] = [];
      let known = false;
      const dir: AccountingCustomerDirectory = {
        find: async () =>
          known
            ? [
                {
                  externalId: 'qb-new',
                  name: 'Acme Ltd',
                  email: 'ap@acme.test',
                },
              ]
            : [],
        create: async ({ requestId }) => {
          created.push(requestId);
          known = true;
          return { externalId: 'qb-new' };
        },
      };
      const first = await resolveAccountingCustomer({
        db,
        tenantId: TENANT,
        customer: facts(s.customerId),
        directory: dir,
      });
      expect(first).toEqual({
        status: 'mapped',
        externalId: 'qb-new',
        source: 'created',
      });
      // A second resolve is a mapping hit; a lost mapping would re-find, not re-create.
      await removeAccountingMapping({ db }, s.scope, 'customer', s.customerId);
      const again = await resolveAccountingCustomer({
        db,
        tenantId: TENANT,
        customer: facts(s.customerId),
        directory: dir,
      });
      expect(again).toEqual({
        status: 'mapped',
        externalId: 'qb-new',
        source: 'found',
      });
      expect(created).toHaveLength(1);
      expect(created[0]).toMatch(/^smrt_cust_[a-f0-9]{32}$/);
    });

    it('stops on ambiguity and changes nothing; the operator confirms', async () => {
      const s = await seed();
      const candidates = [
        { externalId: 'qb-1', name: 'Acme Ltd', email: 'ap@acme.test' },
        { externalId: 'qb-2', name: 'Acme Ltd.', email: 'ap@acme.test' },
      ];
      const { dir, create } = directory(candidates);
      const result = await resolveAccountingCustomer({
        db,
        tenantId: TENANT,
        customer: facts(s.customerId),
        directory: dir,
      });
      expect(result).toEqual({ status: 'needs_confirmation', candidates });
      expect(create).not.toHaveBeenCalled();
      expect(
        await getAccountingMapping({ db }, s.scope, 'customer', s.customerId),
      ).toBeNull();

      await expect(
        confirmAccountingCustomer({
          db,
          tenantId: TENANT,
          customer: facts(s.customerId),
          directory: dir,
          choice: { externalId: 'qb-999' },
        }),
      ).rejects.toMatchObject({ code: 'CUSTOMER_NOT_A_CANDIDATE' });
      const ok = await confirmAccountingCustomer({
        db,
        tenantId: TENANT,
        customer: facts(s.customerId),
        directory: dir,
        choice: { externalId: 'qb-2' },
        confirmedBy: 'op-1',
      });
      expect(ok).toMatchObject({ externalId: 'qb-2' });
      expect(
        (await getAccountingMapping({ db }, s.scope, 'customer', s.customerId))
          ?.confirmedBy,
      ).toBe('op-1');
    });

    it('treats a lone match that agrees on neither email nor name as ambiguous', async () => {
      const s = await seed();
      const { dir, create } = directory([
        { externalId: 'qb-5', name: 'Acme Holdings', email: 'x@other.test' },
      ]);
      const result = await resolveAccountingCustomer({
        db,
        tenantId: TENANT,
        customer: facts(s.customerId),
        directory: dir,
      });
      expect(result.status).toBe('needs_confirmation');
      expect(create).not.toHaveBeenCalled();
      const made = await confirmAccountingCustomer({
        db,
        tenantId: TENANT,
        customer: facts(s.customerId),
        directory: dir,
        choice: 'create',
      });
      expect(made).toMatchObject({ externalId: 'qb-new', source: 'created' });
      expect(create).toHaveBeenCalledTimes(1);
    });

    it('needs a connected company', async () => {
      const { dir } = directory([]);
      await expect(
        resolveAccountingCustomer({
          db,
          tenantId: '33333333-3333-4333-8333-333333333333',
          customer: facts('c'),
          directory: dir,
        }),
      ).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    });
  });
});
