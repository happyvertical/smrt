# Ordinary invoice accounting adjustments (#4118)

Ordinary issued invoices use the same frozen money exporter as other canonical
Commerce invoices. Their provider credit applications and already-settled refund
recordings need durable ownership too; they do not have a retention agreement.

Use `syncOrdinaryInvoiceToAccounting` with the active tenant, canonical issued
invoice ID, provider, stable request ID, evidence reference, reviewed SDK
`QuickBooksOrdinaryReceivableMapping` (`kind: 'ordinary'`) and exact
`QuickBooksFrozenInvoiceMapping` (`invoiceMapping`). It saves both mappings before
calling `syncFrozenInvoiceToAccounting`. It does not fabricate quantities, tax,
retention accounts or an original provider invoice for historical imported facts.
The mapping supports explicit accrual/invoice-tax-point, verified home currency,
AR and optional bank accounts. The SDK validates real provider account/customer
metadata; ordinary mapping cannot withhold or release retention.

`readOrdinaryInvoiceAccountingState(invoice)` returns the immutable source and
reviewed mappings, nullable original external ID, pending/ready status, credits,
refunds and individual remote steps. On a lost original export response, retain
that state and use the existing `readFrozenAccountingSyncState` request/attempt
identity plus `reconcileOrdinaryBaseInvoice` and exact verified provider outcome.
Retry the original sync command afterwards. A fresh process can reconstruct the
request from the public state; it must not guess a mapping or query private JSON.

For an issued same-source credit, `loadOrdinaryCreditAccountingSnapshot` and
`toOrdinaryCreditAccountingInput` provide read-only exact review. Then call
`syncOrdinaryCreditToAccounting` with the credit ID/mapping, request/evidence and
explicit effective date. The command reserves the actual local applied amount,
exports the frozen CreditMemo and applies only that amount to the original remote
Invoice. Zero application leaves unapplied credit capacity; it creates no fake
zero payment. Once reserved, later same-date credits, UUID ordering and balance
refreshes cannot move the provider application. Generic direct credit export is
blocked for managed sources; the owning read helpers do not permit a write bypass.

`syncOrdinaryRefundToAccounting` requires an already-completed local refund
Payment, actual cash journal, one exact full allocation to a reconciled provider
credit, and effectiveOn equal to the local settlement date. It reserves remaining
unapplied credit capacity before recording the provider cash-refund journal and
its noncash CreditMemo application. These are accounting records of an existing
settlement, never a bank transfer. The Payment and its allocations cannot be
changed/deleted after reservation, including while an outcome is unknown.

Every remote write uses the shared recoverable step engine also used by retained
accounting. `reconcileOrdinaryAccountingStep` requires exact observed request and
attempt identity, authoritative readback/absence evidence and proof an interrupted
owner stopped. `reconcileOrdinaryCreditAccounting` resolves the frozen CreditMemo
export. Never reset unknown state on timeout or assume a request hash alone proves
remote idempotency. Resume the original operation after reconciliation; changed
request facts fail. Network operations reject caller-owned money transactions;
local reservations use the same tenant/source money locks and rollback boundary.

Ordinary state and refund bindings are command-owned fields on Invoice and Payment.
Run normal schema migration for these additive fields before using the capability.
Existing rows remain unbound; no automatic conversion of earlier app-only posted
history is performed. Retained APIs still require a real positive retention
agreement. No live provider certification is implied by controlled SDK fixtures.

Focused proof: `pnpm --filter @happyvertical/smrt-commerce exec vitest run
src/__tests__/ordinary-accounting.test.ts src/__tests__/retention-accounting.test.ts`.
The corresponding `ordinary-accounting.optional.test.ts` and retained suite run
through the standard managed PostgreSQL wrapper. The shared helper covers base,
credit and both refund-step lost responses; same-day ordering; changed retry;
source/tenant checks; reservation rollback; concurrent refund attempts; and direct
payment/allocation mutation refusal. The retained suite protects shared-engine
compatibility.

An existing generic frozen export can enter ordinary coordination only when the
reviewed mapping reconstructs its exact original creation request. This check
runs under the reservation lock, including unresolved exports; a mismatch leaves
ordinary state absent. Once ordinary authority is reserved, base export uses the
owning command so a competing generic export cannot replace that mapping between
reservation and provider I/O. Read-only frozen projections remain available.
