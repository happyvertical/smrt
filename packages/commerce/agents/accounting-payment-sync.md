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

A failure before anything reached the provider (the facts cannot form a valid
provider request, or the provider has no payment creation) is a known non-send:
throw `AccountingPaymentNotSentError(reason, message)` from the port and the row
becomes a retryable `rejected` whose `lastError` is that stable code
(`INVALID_PROVIDER_REQUEST`, `PROVIDER_UNSUPPORTED`; the batch item reports it as
`reason`). Only a failure after the provider may have received the request is
`unknown`.

`resolveUnknownPaymentSync({ db, tenantId, paymentId, reader })` recovers an
`unknown` row without hand-written SQL: it reads every applied invoice through
the `AccountingInvoiceReader`; none with a provider payment means the push never
landed, so it applies `reconcileAccountingPaymentSync` `absent` and returns
`retryable` (the next `syncPending` pushes it, with the same `requestid`); any
provider payment (other than ones this tenant already synced) returns
`ambiguous` with their ids and leaves the row `unknown` for a person (a provider
payment cannot be attributed to this push from the document). Absence is proven
only by a complete read of this company's invoice: a partial read or one for
another realm, tenant or invoice returns `inconclusive`. A failed read throws
and changes nothing. A released push keeps its request id for good
(`pinnedRequestId`, set by the release and never cleared, enforced in the
atomic takeover) so the provider's dedup still covers a slow original; if the
facts changed since, every later retry throws `RECONCILIATION_REQUIRED` and
sends nothing.

The local `Payment` row is not edited; `AccountingPaymentSync.externalId` is the
provider id. Payments cannot be un-applied by this module: if allocations change
after the push, readback reports drift.

### SDK seam (sdk#1540)

`AccountingPaymentPort.create(request)` is the provider call; the host adapts
the SDK's payment creation to it (`requestId` is the idempotency key; throw an
error with `outcome: 'rejected'` on a definite refusal). The optional
`prepare(request)` returns the provider's own `payloadHash`, persisted before the
push: QuickBooks verifies it against the exact mapped payload, which only the
provider can compute (`paymentPortFromProvider` implements it with
`prepareQuickBooksPaymentRequest`; without it the SDK throws "payload mismatch"
before any network call, #5420). `accounting-payment-sync.test.ts` runs commerce
through the real SDK payment operations.

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

## Provider adapters (#5154)

`src/accounting-provider-adapters.ts` adapts the provider that
`withTenantQuickBooksProvider` hands you to the injected ports, typed
structurally against the SDK operations (no SDK bump needed):
`paymentPortFromProvider(provider)` (sdk#1540: minor to major units, `requestId`
forwarded as the QuickBooks `requestid`, unknown currency refused, write errors
pass through), `invoiceReaderFromProvider(provider, tenantId)` (sdk#1548) and
`customerDirectoryFromProvider(provider)` (sdk#1539; `create` never creates over
a match and throws `CUSTOMER_NEEDS_CONFIRMATION`). A provider without the
operation fails the call with a plain error.
