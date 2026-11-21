# Tenant settlement accounts (#5412)

Source: `src/settlement-accounts.ts`.

`ensureTenantSettlementAccounts(db, tenantId, { currency })` is the settlement
counterpart of `ensureCommerceTenant`. A payment only reaches `COMPLETED`
through `Payment.recordPayment`, and only completed payments are pushed to the
accounting provider ([payment sync](accounting-payment-sync.md)), so a host
needs a ledger and accounts before any payment can settle.

It seeds one **exact-integer** ledger per tenant and currency
(`Settlement <CUR>`) and these accounts, under stable numbers hosts, provider
mappings and reports can key off (`SETTLEMENT_ACCOUNTS`):

| number | name | type |
|---|---|---|
| 1000 | Cash / Undeposited Funds | asset |
| 1200 | Accounts Receivable | asset |
| 2200 | Sales Tax Payable | liability |
| 4000 | Sales Revenue | revenue |

It returns `{ ledgerId, cashAccountId, receivablesAccountId,
salesTaxPayableAccountId, revenueAccountId }`; the first three are exactly the
`RecordPaymentOptions` of `recordPayment`, and the receivables and revenue
accounts are the `arAccountId` / `revenueAccountId` of `recognizeRevenue`.

- Idempotent and race safe: deterministic ids, a tenant advisory lock on
  PostgreSQL (the embedded write queue otherwise), and a reload when a racing
  insert wins. Existing rows are never changed.
- A row found under a seed identity whose tenant, currency, ledger, number or
  type differs is refused, never adopted.
- Call it outside a model transaction (it opens its own), like
  `ensureCommerceTenant`. Requires smrt-ledgers.
- `recordPayment` posts into the ledger of the cash account. A ledger-scoped
  account used to be rejected ("Journal entry account must belong to its journal
  ledger") because the journal was always ledger-less; it now takes the cash
  account's ledger and refuses a `ledgerId` that does not own it. Ledger-less
  accounts (`ledgerId: ''`) keep posting to a ledger-less journal.
- Scope: this chart settles incoming payments (cash and receivables) and gives
  `recognizeRevenue` its receivables, revenue and sales-tax accounts. It does not
  yet back `BillingRuntime.ledger`: the billing tax journal and `postOnce`
  journals stay ledger-less, and the chart has no fee or deposit-liability
  account for connected payments or customer funds.
