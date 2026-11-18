# Payment sync, readback and batches (#5139)

Source: `src/accounting-payment-sync.ts`, `src/models/AccountingSyncRecords.ts`.

## Payment push

`syncPaymentToAccounting({ db, tenantId, paymentId, payments, provider? })` (run
inside the tenant context) pushes one recorded payment to the connected company,
applied to its synced invoice(s) and deposited to the mapped clearing account
(`deposit_account:default`). It requires:

- a `completed`, non-refund `Payment` fully applied (`PaymentAllocation`s sum to
  the amount) to invoices that are **synced to the same company and
  environment** (`INVOICE_NOT_SYNCED` otherwise), one customer, one currency;
- the `customer` and `deposit_account:default` mappings (`MAPPING_INCOMPLETE`
  lists what is missing);
- live mode in production (see [live-mode gate](accounting-live-gate.md)).

Exactly once, same shape as the invoice path: `AccountingPaymentSync` is unique
per `(tenant, provider, realm, environment, payment)`. The request id
(`smrt_pay_<hash of the exact facts>`) and the request JSON are persisted as
`in_flight` **before** the provider call. A definite rejection
(`error.outcome === 'rejected'`) or a dead grant (`REAUTH_REQUIRED`: nothing was
sent) becomes `rejected` and may be retried (an atomic conditional takeover, so
two retries cannot both push). Any other failure is `unknown`: retry throws
`RECONCILIATION_REQUIRED` until `reconcileAccountingPaymentSync` is given the
provider's authoritative lookup of that request (`found` completes it,
`absent` makes it retryable; an interrupted `in_flight` row also needs
`confirmInterruptedOwnerStopped`). Two concurrent calls: one pushes, the other
gets `SYNC_IN_PROGRESS`. A synced payment returns `unchanged`.

The local `Payment` row is not edited; `AccountingPaymentSync.externalId` is the
provider id. Payments cannot be un-applied by this module: if allocations change
after the push, readback reports drift.

### SDK seam (sdk#1540)

`AccountingPaymentPort.create(request)` is the provider call; the host adapts
the SDK's payment creation to it (`requestId` is the idempotency key; throw an
error with `outcome: 'rejected'` on a definite refusal). smrt tests use fakes.

## Readback

`readbackInvoice({ db, tenantId, invoiceId, reader })` reads the provider
document (and linked transactions) through `AccountingInvoiceReader`, projects
it with the pilot's `projectQuickBooksPilotEvidence` (balance, paid, credited,
refunded, state, transactions) and stores it in `AccountingInvoiceReadback`
(unique per invoice) with a status:

| status | when |
|---|---|
| `in_step` | provider paid amount equals Commerce's (completed allocations), no provider-only payment |
| `drift` | `PAID_AMOUNT_DIFFERS`, `PROVIDER_ONLY_PAYMENT` (a payment recorded only in the provider; ids in `providerOnlyJson`), or `VOIDED_IN_PROVIDER` |
| `needs_reconciliation` | evidence incomplete or inconsistent, scope or total mismatch, or the read failed |

Reads only; it never writes to the provider and never creates a Work payment
from a provider-only one (Epic J decision J-e).

## Batches

Both are bounded (`limit` default 25, max 100) and resumable (`cursor` in,
`nextCursor` out; `null` at the end), so a job only schedules and locks:

- `syncPending({ db, tenantId, provider, payments, limit?, cursor?, customers? })`:
  pushes pending frozen invoices and credit notes (built with
  `buildFrozenInvoiceMapping`), then payments whose invoices are synced. Items
  report `synced | unchanged | skipped | failed` with a code. A missing mapping
  or unsynced source skips the item; a closed live gate or dead connection stops
  the batch. `customers` (directory + describe) resolves missing customer
  mappings; an ambiguous match is skipped, never created.
- `readbackDue({ db, tenantId, reader, limit?, olderThan?, cursor?, now? })`:
  reads synced invoices never read or last read before `olderThan` (default 15
  minutes).

Invoices with retention or ordinary-accounting state keep their own commands and
are not picked up by `syncPending`.
