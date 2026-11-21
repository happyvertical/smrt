/**
 * A tenant's default settlement chart (#5412).
 *
 * `Payment.recordPayment({ ledgerId, receivablesAccountId, cashAccountId })` is
 * the only way a payment reaches `COMPLETED`, and only completed payments are
 * pushed to the accounting provider, so a host with no ledger can never settle
 * or sync one. {@link ensureTenantSettlementAccounts} is the settlement
 * counterpart of `ensureCommerceTenant`: it seeds one exact-integer ledger per
 * tenant and currency with a small chart under stable account numbers that
 * hosts, provider mappings and reports can key off.
 */
import {
  isEmbeddedDatabase,
  isPostgresDatabase,
  withEmbeddedWriteTransaction,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { createOrLoadTaxSeed, deterministicSeedId } from './tax/identity.js';

/** The accounts every settlement chart carries, by stable number. */
export const SETTLEMENT_ACCOUNTS = [
  {
    key: 'cash',
    number: '1000',
    name: 'Cash / Undeposited Funds',
    type: 'asset',
    description: 'Payments received and not yet deposited (clearing).',
  },
  {
    key: 'receivables',
    number: '1200',
    name: 'Accounts Receivable',
    type: 'asset',
    description: 'Amounts customers owe on issued invoices.',
  },
  {
    key: 'salesTaxPayable',
    number: '2200',
    name: 'Sales Tax Payable',
    type: 'liability',
    description: 'Sales tax collected and owed to the tax authority.',
  },
  {
    key: 'revenue',
    number: '4000',
    name: 'Sales Revenue',
    type: 'revenue',
    description: 'Revenue recognised on issued invoices.',
  },
] as const;

type SettlementKey = (typeof SETTLEMENT_ACCOUNTS)[number]['key'];

export interface EnsureTenantSettlementAccountsOptions {
  /** ISO 4217 currency of the ledger (three letters, any case). */
  readonly currency: string;
}

/** Ids of a tenant's settlement ledger and accounts for one currency. */
export interface TenantSettlementAccounts {
  readonly tenantId: string;
  readonly currency: string;
  readonly ledgerId: string;
  readonly cashAccountId: string;
  readonly receivablesAccountId: string;
  readonly salesTaxPayableAccountId: string;
  readonly revenueAccountId: string;
}

async function lockSettlementSeed(
  db: DatabaseInterface,
  tenantId: string,
  currency: string,
): Promise<void> {
  if (!isPostgresDatabase(db)) return;
  await db.query(
    'SELECT pg_advisory_xact_lock(hashtext(CAST(? AS TEXT)))',
    `smrt-commerce-settlement-accounts:${tenantId}:${currency}`,
  );
}

/**
 * Seed (or load) the tenant's settlement ledger and chart for one currency.
 *
 * Idempotent and race safe: identities are deterministic, creation serializes
 * on a tenant advisory lock (PostgreSQL) or the embedded write queue, and an
 * existing row is never changed. A row found under a seed identity whose
 * tenant, currency, ledger, number or type differs is refused, never adopted.
 * The returned ids feed `Payment.recordPayment` directly
 * (`ledgerId`, `receivablesAccountId`, `cashAccountId`).
 *
 * Call it outside a model transaction, as `ensureCommerceTenant`: it opens its
 * own. Requires smrt-ledgers and a database with transactions. The caller owns
 * authority for `tenantId`; this function never derives it.
 */
export async function ensureTenantSettlementAccounts(
  db: DatabaseInterface,
  tenantId: string,
  options: EnsureTenantSettlementAccountsOptions,
): Promise<TenantSettlementAccounts> {
  if (!tenantId.trim()) throw new Error('Settlement accounts require a tenant');
  const currency = options.currency?.trim().toUpperCase();
  if (!currency || !/^[A-Z]{3}$/.test(currency))
    throw new Error('Settlement accounts require an ISO 4217 currency');
  if (!db.transaction)
    throw new Error('Settlement accounts require transactions');

  const { AccountCollection, LedgerCollection } = await import(
    '@happyvertical/smrt-ledgers'
  );
  const ledgerKey = await deterministicSeedId(
    'commerce-settlement',
    tenantId,
    currency,
    'ledger',
  );

  return withEmbeddedWriteTransaction(
    db,
    isEmbeddedDatabase(db),
    async (tx) => {
      await lockSettlementSeed(tx, tenantId, currency);
      return withTenant({ tenantId }, async () => {
        const ledgers = await LedgerCollection.create({ db: tx });
        const accounts = await AccountCollection.create({ db: tx });

        const loadLedger = () =>
          ledgers.get({ id: ledgerKey }, { cache: false });
        let ledger = await loadLedger();
        if (!ledger) {
          ledger = await createOrLoadTaxSeed(
            () =>
              ledgers.create({
                id: ledgerKey,
                tenantId,
                name: `Settlement ${currency}`,
                currency,
                balanceMode: 'exact-integer',
              }),
            loadLedger,
          );
        }
        if (
          ledger.tenantId !== tenantId ||
          ledger.currency !== currency ||
          ledger.balanceMode !== 'exact-integer'
        )
          throw new Error(
            `Settlement ledger ${ledgerKey} does not match tenant, currency ${currency} and exact-integer mode; restore it.`,
          );

        const ids = {} as Record<SettlementKey, string>;
        for (const seed of SETTLEMENT_ACCOUNTS) {
          const id = await deterministicSeedId(
            'commerce-settlement',
            tenantId,
            currency,
            `account:${seed.key}`,
          );
          const load = () => accounts.get({ id }, { cache: false });
          let account = await load();
          if (!account) {
            account = await createOrLoadTaxSeed(
              () =>
                accounts.create({
                  id,
                  tenantId,
                  ledgerId: String(ledger.id),
                  number: seed.number,
                  name: seed.name,
                  description: seed.description,
                  type: seed.type,
                }),
              load,
            );
          }
          if (
            account.tenantId !== tenantId ||
            account.ledgerId !== String(ledger.id) ||
            account.number !== seed.number ||
            account.type !== seed.type
          )
            throw new Error(
              `Settlement account ${seed.number} (${seed.name}) was changed; restore number ${seed.number} as ${seed.type} in ledger ${String(ledger.id)}.`,
            );
          ids[seed.key] = String(account.id);
        }

        return {
          tenantId,
          currency,
          ledgerId: String(ledger.id),
          cashAccountId: ids.cash,
          receivablesAccountId: ids.receivables,
          salesTaxPayableAccountId: ids.salesTaxPayable,
          revenueAccountId: ids.revenue,
        };
      });
    },
  );
}
