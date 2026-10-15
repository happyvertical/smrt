# Frozen commerce snapshot → accounting SDK mapper

`src/accounting-snapshot.ts` is the pure adapter for an approved commerce money
snapshot. `src/invoice-accounting-sync.ts` is the owning persistence and
provider boundary. It re-reads the issued Invoice, InvoiceLineItem and
DocumentTax rows and verifies their shared `moneySnapshotId` before calling the
pure mapper. `Invoice.toAccountingInput({ mapping })` always requires explicit
QuickBooks realm mapping and is routed through the frozen boundary; calling it
without options throws `INVALID_MONEY_INPUT`.

The released `@happyvertical/accounting` 0.103.7 path accepts frozen invoices
and positive credit memos. Commerce sends persisted pre-discount unit price,
line discount, net amount, allocated tax, and inclusive gross amount through
the SDK's public input types. It never sends a numeric `taxRate`; every taxable
line has explicit Item, TaxCode, and component TaxRate references. Exempt and
out-of-scope lines carry no fabricated components. No dependency override or
private SDK import is used.

The caller supplies persisted document and line facts: document mode and
rounding scope, integer-minor header totals, line pre-discount unit price and
discount, post-discount net amount, and each component's ID, exact percent text,
and allocated minor tax amount. The mapper converts only ISO 4217 minor units
to major units. It never calculates a discount, tax, rate, or allocation. For
an inclusive line, `taxInclusiveAmount` is the exact sum of the persisted net
and persisted tax facts, so the SDK can serialize QBO `TaxInclusiveAmt`.

`FrozenQuickBooksTaxMapping` is tenant/realm configuration and must supply an
Item.Id and TaxCode.Id for every line plus a TaxRate.Id for every stored
component. The mapper refuses missing mappings and never derives a provider ID
from a tax-code name, percent, or component identifier. It also refuses a
nonzero `providerTaxMinor`: header-only provider tax has no frozen component or
rate reference and cannot safely become a QBO tax line.

The mapper checks only snapshot identities before any provider I/O: each line's
component sum equals its stored tax, lines sum to header net/tax, and header net
plus tax equals total. `taxRoundingScope` is retained as frozen provenance; no
rounding is repeated. Currency exponents come from the shared ISO map, so JPY
and KWD retain their exact stored values.

Credit memos use positive input values and require `creditedInvoiceExternalId`.
Their provider direction is the SDK's `CreditMemo` operation. The owning sync
boundary calls the public `requireCreditMemoOperations()` capability guard
before persisting an in-flight owner, prepares and persists the SDK's
`quickbooksCreditMemoRequest`, then records the returned external ID. The
source invoice must have a reconciled QuickBooks identity in the same realm and
environment. The adapter never auto-applies a credit memo to its invoice.

## Sync identity and recovery

`syncFrozenInvoiceToAccounting()` derives a QuickBooks request identity from
the provider, realm, environment, document id, and immutable
`moneySnapshotId`. The SDK forwards the persisted `requestId` as QuickBooks'
`requestid` parameter and validates the payload hash. Commerce persists an
`in_flight` owner before provider I/O, so a competing call is refused instead
of issuing a second create. A successful call persists the external id and a
`synced` state; another call for the same identity returns `unchanged` without
provider I/O. A different realm, environment, provider, or snapshot never
shares that no-op.

The database transaction and provider request are separate phases. Commerce
does not claim they are atomic. If the provider outcome or the post-write local
commit is uncertain, the stored state requires reconciliation and refuses a
blind retry. A provider rejection known not to have committed may be retried
with the same prepared request. `readFrozenAccountingSyncState()` exposes the
request descriptor needed by an operator-owned reconciliation workflow.

Recovery is an explicit application flow rather than a database repair:

1. Load the invoice and call `readFrozenAccountingSyncState()`.
2. Use its realm, environment, `requestId`, and payload hash to query the
   configured QuickBooks realm. An absence result does not establish that an
   active request has stopped. For `in_flight`, first terminate or otherwise
   positively establish that the original process/request owner cannot finish.
3. Call `reconcileFrozenInvoiceAccountingSync()` with that same request ID,
   attempt ID, and mapping. Report `found` with the provider document ID and
   observed timestamp, or report `absent` only after QuickBooks authoritatively
   confirms no create.
4. A `found` result records the sync and makes later calls no-ops. An `absent`
   result returns `ready`; the next sync reuses the identical prepared request.

The reconciliation API accepts both `unknown` and interrupted `in_flight`
records so a process crash after the remote write cannot wedge the invoice.
It rejects a changed snapshot, request, realm, environment, or mapping. It does
not perform the remote lookup itself. A normal caller cannot reconcile an
`in_flight` record; the trusted server caller must pass
`confirmInterruptedOwnerStopped: true` after establishing quiescence. That flag
is an explicit operational assertion, not a lease inferred from time or from a
provider lookup. `unknown` records already have no live local owner and do not
require it.

## Deployment and capability boundary

`Invoice.accountingSyncStateJson` is a sensitive, server-owned persistence
field. It is excluded from public serialization and from the shared generated
REST, MCP/Chat, and CLI writable allowlist. Deployments must apply the normal
generated schema migration that adds `accounting_sync_state_json` before using
this sync API. Runtime code never creates or alters schema.

Signed adjustment lines remain a known acceptance gap. The commerce money model
can persist signed adjustments inside a positive document, but the accounting
SDK has no reviewed signed-line representation. The owning sync boundary
therefore rejects them before state or provider mutation. Header-only provider
tax is also refused because it has no persisted component identity or realm tax
rate mapping. Inclusive documents, discounted lines, exempt lines, and positive
credit memos use the released public SDK contract.

The mapper's A/B fixtures are the commerce calculator's actual CAD goldens:
example A is tax-exclusive and example B is tax-inclusive. Both cover line and
document allocation; example B's document scope preserves line 3's allocated
GST cent. Focused sync tests inspect the exact public SDK request inputs and
persisted create descriptors without performing a provider network write.
