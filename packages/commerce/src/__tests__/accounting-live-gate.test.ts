/** Live-mode gate on accounting sync (#5138). */
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
  disableLiveAccounting,
  enableLiveAccounting,
} from '../accounting-connection.js';
import { AccountingLiveGateError } from '../accounting-live-gate.js';
import {
  type AccountingCustomerDirectory,
  confirmAccountingCustomer,
  resolveAccountingCustomer,
} from '../accounting-mapping.js';
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import {
  type QuickBooksFrozenInvoiceMapping,
  syncFrozenInvoiceToAccounting,
} from '../invoice-accounting-sync.js';
import {
  syncOrdinaryCreditToAccounting,
  syncOrdinaryInvoiceToAccounting,
  syncOrdinaryRefundToAccounting,
} from '../ordinary-accounting.js';
import {
  releaseRetainedInvoiceToAccounting,
  syncRetainedCreditToAccounting,
  syncRetainedInvoiceToAccounting,
  syncRetainedRefundToAccounting,
} from '../retention-accounting.js';
import {
  connectFixtureTenant,
  FakeSecrets,
  issuedFixtureInvoice,
} from './helpers/accounting-fixtures.js';

const TENANT = '44444444-4444-4444-8444-444444444441';

describe('live-mode gate (#5138)', () => {
  let db: DatabaseInterface;
  let secrets: FakeSecrets;
  const deps = () => ({ db, secrets, pollMs: 2 });

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy();
    secrets = new FakeSecrets();
  });
  afterEach(async () => {
    disableTenancy();
    await db.close?.();
  });

  function setup(environment: 'sandbox' | 'production') {
    return async () => {
      const seeded = await issuedFixtureInvoice(db, TENANT);
      const mapping: QuickBooksFrozenInvoiceMapping = {
        realmId: 'realm-a',
        environment,
        lines: { [seeded.lineId]: { itemRef: 'i', taxCodeRef: 't' } },
        components: { [seeded.componentId]: { quickbooksTaxRateRef: 'r' } },
      };
      const push = vi.fn(
        async (_i: InvoiceInput): Promise<SyncResult> => ({
          action: 'created',
          externalId: 'qb-1',
          syncedAt: new Date('2026-11-01T00:00:00Z'),
        }),
      );
      const provider = (env?: string) =>
        ({
          type: 'quickbooks',
          ...(env ? { environment: env } : {}),
          invoices: { push },
        }) as never;
      const run = (p = provider()) =>
        withTenant({ tenantId: TENANT }, () =>
          syncFrozenInvoiceToAccounting({
            db,
            tenantId: TENANT,
            invoiceId: seeded.invoice.id,
            mapping,
            provider: p,
          }),
        );
      const stateOf = async () =>
        (
          await (
            await InvoiceCollection.create({ db })
          ).get({ id: seeded.invoice.id }, { cache: false })
        )?.accountingSyncStateJson;
      return { seeded, push, provider, run, stateOf };
    };
  }

  it('sandbox stays the default and needs no enablement or connection', async () => {
    const { run, push } = await setup('sandbox')();
    await expect(run()).resolves.toMatchObject({ status: 'synced' });
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('refuses production writes without a connection, leaving state unchanged', async () => {
    const { run, push, stateOf } = await setup('production')();
    await expect(run()).rejects.toMatchObject({
      name: 'AccountingLiveGateError',
      code: 'LIVE_ACCOUNTING_NOT_ENABLED',
    });
    expect(push).not.toHaveBeenCalled();
    expect(await stateOf()).toBeFalsy();
  });

  it('refuses a production connection until live mode is deliberately enabled', async () => {
    const { run, push, stateOf } = await setup('production')();
    await connectFixtureTenant(db, TENANT, {
      environment: 'production',
      secrets,
    });
    await expect(run()).rejects.toBeInstanceOf(AccountingLiveGateError);
    expect(push).not.toHaveBeenCalled();
    expect(await stateOf()).toBeFalsy();

    await expect(
      enableLiveAccounting(deps(), {
        tenantId: TENANT,
        realmId: 'other',
        enabledBy: 'u',
        evidenceRef: 'e',
      }),
    ).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    const enabled = await enableLiveAccounting(deps(), {
      tenantId: TENANT,
      realmId: 'realm-a',
      enabledBy: 'will',
      evidenceRef: 'sandbox-report-1',
    });
    expect(enabled).toMatchObject({
      liveEnabledRealmId: 'realm-a',
      liveEnabledBy: 'will',
      liveEnabledEvidenceRef: 'sandbox-report-1',
    });
    await expect(run()).resolves.toMatchObject({ status: 'synced' });
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('cannot enable live mode on a sandbox connection', async () => {
    await connectFixtureTenant(db, TENANT, { environment: 'sandbox', secrets });
    await expect(
      enableLiveAccounting(deps(), {
        tenantId: TENANT,
        realmId: 'realm-a',
        enabledBy: 'u',
        evidenceRef: 'e',
      }),
    ).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });

  it('closes again when disabled, rebound to another company, or disconnected', async () => {
    const { run } = await setup('production')();
    const live = () =>
      enableLiveAccounting(deps(), {
        tenantId: TENANT,
        realmId: 'realm-a',
        enabledBy: 'u',
        evidenceRef: 'e',
      });
    await connectFixtureTenant(db, TENANT, {
      environment: 'production',
      secrets,
    });
    await live();
    await disableLiveAccounting(deps(), TENANT);
    await expect(run()).rejects.toMatchObject({
      code: 'LIVE_ACCOUNTING_NOT_ENABLED',
    });

    await live();
    await connectFixtureTenant(db, TENANT, {
      realmId: 'realm-b',
      environment: 'production',
      secrets,
    });
    await expect(run()).rejects.toMatchObject({
      code: 'LIVE_ACCOUNTING_NOT_ENABLED',
    });
  });

  it('refuses a sandbox-labelled mapping aimed at a production provider', async () => {
    const { run, push, provider } = await setup('sandbox')();
    await expect(run(provider('production'))).rejects.toMatchObject({
      code: 'ACCOUNTING_ENVIRONMENT_MISMATCH',
    });
    expect(push).not.toHaveBeenCalled();
  });

  it('refuses a production provider even when the mapping says production, until enabled', async () => {
    const { run, push, provider } = await setup('production')();
    await expect(run(provider('production'))).rejects.toMatchObject({
      code: 'LIVE_ACCOUNTING_NOT_ENABLED',
    });
    expect(push).not.toHaveBeenCalled();
  });

  it('refuses a sandbox-labelled mapping for a company connected as production', async () => {
    const { run, push } = await setup('sandbox')();
    await connectFixtureTenant(db, TENANT, {
      environment: 'production',
      secrets,
    });
    await expect(run()).rejects.toMatchObject({
      code: 'ACCOUNTING_ENVIRONMENT_MISMATCH',
    });
    expect(push).not.toHaveBeenCalled();
  });

  it('gates customer creation, but not linking an existing match, in production', async () => {
    await connectFixtureTenant(db, TENANT, {
      environment: 'production',
      secrets,
    });
    const create = vi.fn(async () => ({ externalId: 'qb-new' }));
    const facts = {
      customerId: 'c-1',
      name: 'Acme Ltd',
      email: 'ap@acme.test',
    };
    const none: AccountingCustomerDirectory = { find: async () => [], create };
    await expect(
      resolveAccountingCustomer({
        db,
        tenantId: TENANT,
        customer: facts,
        directory: none,
      }),
    ).rejects.toMatchObject({ code: 'LIVE_ACCOUNTING_NOT_ENABLED' });
    await expect(
      confirmAccountingCustomer({
        db,
        tenantId: TENANT,
        customer: facts,
        directory: none,
        choice: 'create',
      }),
    ).rejects.toMatchObject({ code: 'LIVE_ACCOUNTING_NOT_ENABLED' });
    expect(create).not.toHaveBeenCalled();
    const one: AccountingCustomerDirectory = {
      find: async () => [
        { externalId: 'qb-7', name: 'Acme Ltd', email: 'ap@acme.test' },
      ],
      create,
    };
    await expect(
      resolveAccountingCustomer({
        db,
        tenantId: TENANT,
        customer: facts,
        directory: one,
      }),
    ).resolves.toMatchObject({
      status: 'mapped',
      externalId: 'qb-7',
      source: 'found',
    });
    expect(create).not.toHaveBeenCalled();
    await enableLiveAccounting(deps(), {
      tenantId: TENANT,
      realmId: 'realm-a',
      enabledBy: 'u',
      evidenceRef: 'e',
    });
    await expect(
      confirmAccountingCustomer({
        db,
        tenantId: TENANT,
        customer: { ...facts, customerId: 'c-2' },
        directory: none,
        choice: 'create',
      }),
    ).resolves.toMatchObject({ source: 'created' });
  });

  it('guards every ordinary and retained command before any state or provider call', async () => {
    const seeded = await issuedFixtureInvoice(db, TENANT);
    const provider = {
      type: 'quickbooks',
      environment: 'production',
      invoices: {},
      creditMemos: {},
      receivableTransfers: {},
    };
    const production = {
      realmId: 'realm-a',
      environment: 'production',
      lines: {},
      components: {},
    };
    const base = {
      db,
      tenantId: TENANT,
      invoiceId: seeded.invoice.id,
      provider,
    };
    const commands: Array<[string, (input: never) => Promise<unknown>]> = [
      ['ordinary invoice', syncOrdinaryInvoiceToAccounting as never],
      ['ordinary credit', syncOrdinaryCreditToAccounting as never],
      ['ordinary refund', syncOrdinaryRefundToAccounting as never],
      ['retained invoice', syncRetainedInvoiceToAccounting as never],
      ['retained release', releaseRetainedInvoiceToAccounting as never],
      ['retained credit', syncRetainedCreditToAccounting as never],
      ['retained refund', syncRetainedRefundToAccounting as never],
    ];
    for (const [name, command] of commands) {
      const error = await withTenant({ tenantId: TENANT }, () =>
        command({
          ...base,
          invoiceMapping: production,
          creditMapping: production,
        } as never),
      ).catch((e) => e);
      expect(error, name).toBeInstanceOf(AccountingLiveGateError);
      expect((error as AccountingLiveGateError).code, name).toBe(
        'LIVE_ACCOUNTING_NOT_ENABLED',
      );
    }
  });
});
