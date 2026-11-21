/**
 * `ensureTenantSettlementAccounts` (#5412): the default settlement chart a host
 * seeds so payments can reach `COMPLETED` through `recordPayment`.
 */
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  AccountCollection,
  LedgerCollection,
} from '@happyvertical/smrt-ledgers';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PaymentCollection } from '../collections/PaymentCollection.js';
import {
  ensureTenantSettlementAccounts,
  SETTLEMENT_ACCOUNTS,
} from '../index.js';
import { PaymentMethod, PaymentStatus } from '../types/index.js';

const databaseType = process.env.SMRT_TEST_PGLITE === '1' ? 'pglite' : 'sqlite';
const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

describe('ensureTenantSettlementAccounts', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: databaseType, url: ':memory:' });
    enableTenancy();
  });

  afterEach(async () => {
    disableTenancy();
    await db.close?.();
  });

  const rows = (tenantId: string) =>
    withTenant({ tenantId }, async () => ({
      ledgers: await (await LedgerCollection.create({ db })).list({
        where: { tenantId },
      }),
      accounts: await (await AccountCollection.create({ db })).list({
        where: { tenantId },
      }),
    }));

  it('seeds one exact-integer ledger with the stable default chart', async () => {
    const seeded = await ensureTenantSettlementAccounts(db, TENANT, {
      currency: 'cad',
    });
    expect(seeded.currency).toBe('CAD');
    const { ledgers, accounts } = await rows(TENANT);
    expect(ledgers).toHaveLength(1);
    expect(ledgers[0]).toMatchObject({
      id: seeded.ledgerId,
      currency: 'CAD',
      balanceMode: 'exact-integer',
    });
    expect(
      accounts
        .map((a) => [a.number, a.name, a.type, a.ledgerId])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ['1000', 'Cash / Undeposited Funds', 'asset', seeded.ledgerId],
      ['1200', 'Accounts Receivable', 'asset', seeded.ledgerId],
      ['2200', 'Sales Tax Payable', 'liability', seeded.ledgerId],
      ['4000', 'Sales Revenue', 'revenue', seeded.ledgerId],
    ]);
    expect(SETTLEMENT_ACCOUNTS.map((a) => a.number)).toEqual([
      '1000',
      '1200',
      '2200',
      '4000',
    ]);
  });

  it('is idempotent, including concurrent first calls', async () => {
    const [a, b] = await Promise.all([
      ensureTenantSettlementAccounts(db, TENANT, { currency: 'CAD' }),
      ensureTenantSettlementAccounts(db, TENANT, { currency: 'CAD' }),
    ]);
    const c = await ensureTenantSettlementAccounts(db, TENANT, {
      currency: 'CAD',
    });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    const { ledgers, accounts } = await rows(TENANT);
    expect(ledgers).toHaveLength(1);
    expect(accounts).toHaveLength(4);
  });

  it('keeps tenants and currencies apart', async () => {
    const cad = await ensureTenantSettlementAccounts(db, TENANT, {
      currency: 'CAD',
    });
    const usd = await ensureTenantSettlementAccounts(db, TENANT, {
      currency: 'USD',
    });
    const other = await ensureTenantSettlementAccounts(db, OTHER, {
      currency: 'CAD',
    });
    expect(new Set([cad.ledgerId, usd.ledgerId, other.ledgerId]).size).toBe(3);
    expect(
      new Set([cad.cashAccountId, usd.cashAccountId, other.cashAccountId]).size,
    ).toBe(3);
    expect((await rows(TENANT)).ledgers).toHaveLength(2);
    expect((await rows(OTHER)).ledgers).toHaveLength(1);
  });

  it('refuses a missing tenant or a malformed currency', async () => {
    await expect(
      ensureTenantSettlementAccounts(db, ' ', { currency: 'CAD' }),
    ).rejects.toThrow('require a tenant');
    await expect(
      ensureTenantSettlementAccounts(db, TENANT, { currency: 'dollars' }),
    ).rejects.toThrow('ISO 4217');
  });

  it('refuses a seed account whose number was changed instead of adopting it', async () => {
    const seeded = await ensureTenantSettlementAccounts(db, TENANT, {
      currency: 'CAD',
    });
    await withTenant({ tenantId: TENANT }, async () => {
      const accounts = await AccountCollection.create({ db });
      const cash = await accounts.get({ id: seeded.cashAccountId });
      cash!.number = '9999';
      await cash!.save();
    });
    await expect(
      ensureTenantSettlementAccounts(db, TENANT, { currency: 'CAD' }),
    ).rejects.toThrow('was changed');
  });

  it('returns ids that settle a payment: recordPayment completes it with a balanced journal', async () => {
    const seeded = await ensureTenantSettlementAccounts(db, TENANT, {
      currency: 'CAD',
    });
    const payment = await withTenant({ tenantId: TENANT }, async () => {
      const created = await (await PaymentCollection.create({ db })).create({
        tenantId: TENANT,
        amount: 300,
        currency: 'CAD',
        method: PaymentMethod.BANK_TRANSFER,
        status: PaymentStatus.PENDING,
        transactionId: 'manual:test:1',
        reference: 'manual:test:1',
      });
      await created.recordPayment({
        ledgerId: seeded.ledgerId,
        receivablesAccountId: seeded.receivablesAccountId,
        cashAccountId: seeded.cashAccountId,
      });
      return created;
    });
    expect(payment.status).toBe(PaymentStatus.COMPLETED);
    const journal = await withTenant({ tenantId: TENANT }, () =>
      payment.getJournal(),
    );
    expect(journal).not.toBeNull();
    expect(journal?.ledgerId).toBe(seeded.ledgerId);
    expect(journal?.tenantId).toBe(TENANT);
    const entries = await withTenant(
      { tenantId: TENANT },
      async () =>
        (await journal!.getEntries()) as {
          accountId: string;
          debit: number;
          credit: number;
        }[],
    );
    const byAccount = Object.fromEntries(
      entries.map((e) => [e.accountId, [e.debit, e.credit]]),
    );
    expect(byAccount[seeded.cashAccountId]).toEqual([300, 0]);
    expect(byAccount[seeded.receivablesAccountId]).toEqual([0, 300]);
  });

  it('settles a payment with tenancy off, from the payment tenant alone', async () => {
    const seeded = await ensureTenantSettlementAccounts(db, TENANT, {
      currency: 'CAD',
    });
    disableTenancy();
    const payment = await (await PaymentCollection.create({ db })).create({
      tenantId: TENANT,
      amount: 300,
      currency: 'CAD',
      method: PaymentMethod.BANK_TRANSFER,
      status: PaymentStatus.PENDING,
      transactionId: 'manual:test:3',
      reference: 'manual:test:3',
    });
    await payment.recordPayment({
      ledgerId: '',
      receivablesAccountId: seeded.receivablesAccountId,
      cashAccountId: seeded.cashAccountId,
    });
    expect(payment.status).toBe(PaymentStatus.COMPLETED);
    enableTenancy();
  });

  it('recordPayment refuses a ledger that does not own the cash account', async () => {
    const cad = await ensureTenantSettlementAccounts(db, TENANT, {
      currency: 'CAD',
    });
    const usd = await ensureTenantSettlementAccounts(db, TENANT, {
      currency: 'USD',
    });
    await withTenant({ tenantId: TENANT }, async () => {
      const payment = await (await PaymentCollection.create({ db })).create({
        tenantId: TENANT,
        amount: 300,
        currency: 'CAD',
        method: PaymentMethod.BANK_TRANSFER,
        status: PaymentStatus.PENDING,
        transactionId: 'manual:test:2',
        reference: 'manual:test:2',
      });
      await expect(
        payment.recordPayment({
          ledgerId: usd.ledgerId,
          receivablesAccountId: cad.receivablesAccountId,
          cashAccountId: cad.cashAccountId,
        }),
      ).rejects.toThrow('do not belong to the ledger');
      expect(payment.status).toBe(PaymentStatus.PENDING);
    });
  });
});
