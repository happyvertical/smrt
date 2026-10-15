# Document money persistence

Tenant money behavior is selected by the server-owned `TaxSettings.moneyModel`
marker. Missing settings and `legacy` preserve the existing line-save behavior.
`migrating` is a persisted maintenance guard: invoice money writes fail until
the owning migration restores `legacy` or activates `v2`. Generated surfaces
cannot write either the marker or its owner token.

Every Invoice/InvoiceLineItem get, list, preview, mutation, posting, and
accounting-sync phase acquires the same tenant settings row before document
rows. The barrier is held through the owning transaction, so migration cannot
start between the marker check and a money read/write. Nested coordinators
reuse an explicitly registered transaction executor; adapter shape is never
used as transaction proof. When the settings table exists, the first legacy
runtime boundary materializes the deterministic legacy row solely as this
durable serialization point. Older schemas without the table remain legacy
and runtime never creates schema.

In `v2`, saving an invoice line locks and reloads its parent on the caller's
transaction, reloads every sibling, resolves current tax defaults, calculates
the document once, and writes line snapshots, `DocumentTax`, and header totals
atomically. Tax resolution order is line override, product, customer, then app
default. Product reads use the products package's collection on that same
transaction executor; tenant-owned and catalog-global products are accepted.

The first transition away from `DRAFT`, or setting `arJournalId`, freezes the
money document. The invoice and every line receive the same stable
`moneySnapshotId`. Later payment and lifecycle saves keep that identity.
That persisted snapshot identity remains the freeze authority if payment
allocation changes move the lifecycle status back to `DRAFT`; it does not turn
an issued document back into an editable money draft.
Frozen fields include party/customer identity, currency, issue and due dates,
document amount/rounding settings, seller and party tax snapshots, line
description/SKU/product, quantity/pricing/discount modes, tax code and component
snapshots, source period, revenue account, and sort order. Header and child
money edits, child moves, additions, and deletions then fail with
`FROZEN_DOCUMENT`; status, payment, reminder, and delivery metadata continue
through their existing lifecycle guards.

Credit notes reuse `Invoice` with `kind: 'credit_note'` and a frozen
`creditedInvoiceId`; their `DocumentTax.documentType` is `credit_note`. Stored
header amounts remain positive and posting/report direction comes from `kind`.
A targeted credit line carries `creditedLineId` plus a server-derived frozen
calculation basis. The credit document inherits and re-enforces its source
`lineAmountType` and `taxRoundingScope`; later tenant defaults cannot reinterpret
the frozen unit price or tax allocation. Quantity credits reuse the source price
and allocate its frozen flat or percentage discount from cumulative credited
quantity; this prevents repeated rounding from exceeding the source discount,
and the final quantity receives its exact remaining discount. Amount credits use
an explicit tax-exclusive magnitude and restore the source line sign. A quantity
request is also bounded by tax-exclusive value already consumed through amount
credits, so mixing the two bases cannot exceed the source line. Tax components,
labels, rates, and accounts come from the issued source snapshot. When a request
exhausts every remaining original line, the final line also receives the exact
remaining document/component residual.
Free-form goodwill lines require an explicit tax code and do not consume source
line capacity.

Issued credit notes reduce the source `getBalance()` and update its
server-managed `creditedAmount` under the same locks. Refunds are positive
`Payment` rows with `kind: 'refund'`, allocated only to credit notes; their
available amount is the unapplied issued credit after source settlement and
prior settled refunds. Incoming payments debit cash and credit receivables;
refund journals reverse those sides.

`previewInvoiceMoney({ db, tenantId, invoiceId, draft })` applies a proposed
draft overlay through the owning resolver/calculator without writes and rejects
frozen documents. A supplied line id must name a stored line exactly once; omit
the id for a new preview-only line. `getInvoiceMoneyFacts({ db, tenantId,
invoiceId })` reads the authoritative stored header, lines, `moneySnapshotId`,
and `DocumentTax` rows without recalculation. Both facades require an active
`v2` tenant and fail closed while migration is in progress, so legacy or
partially migrated amounts are never presented as money-v2 facts.

### Record-screen composition

`loadInvoiceRecordScreenData({ db, tenantId, invoiceId })` is the commerce
server adapter for a generic invoice record page. A caller must already have
that exact active tenant; the adapter never switches principals based on its
argument. It holds the shared v2 money read barrier while it reads the stored
header, lines, `DocumentTax`, and related credit-note summaries, so a migration
cannot mix a stale header with a different snapshot of those rows. Its totals
are a direct projection of persisted minor-unit values and component snapshots;
it does not resolve a code or recalculate tax.

`InvoiceRecordScreen` from `@happyvertical/smrt-commerce/svelte` composes that
projection with `RecordScreen.lineItemStoredTotals`, the released generic
line-items widget contract. A host passes its own generic screen wiring and
may expose `onCreateCreditNote` only with a server-derived
`canCreateCreditNote` authorization result. The wrapper hides the action for
credit-note records and never treats a client callback as authorization.

`InvoiceLineItem.amount` is tax-exclusive net money in `v2`.
`taxAmount` is separate, while `legacyAmount` is reserved for rollback during
the compatibility migration. `taxCodeId` and component identity may be null for
a genuine unassigned zero-tax line. Optional `productId` and
`revenueAccountId` are nullable UUID references so PostgreSQL never receives an
empty-string sentinel.

`DocumentTax` is derived and read-only. Its rows snapshot the code/component
labels, percentage, liability account, taxable minor units, and tax minor
units. Provider tax remains the invoice header's `providerTaxAmount`; commerce
does not invent a tax code or component for provider-owned tax.

Revenue recognition for `v2` reads only the frozen invoice, lines, and
`DocumentTax` rows. It groups each line's stored net by its snapshotted revenue
account (falling back to the caller's revenue account), groups component tax by
the snapshotted liability account (falling back to the caller's tax account),
and posts provider tax to the fallback once. Non-taxable zero rows do not post.
Every entry is an exact non-negative debit or credit in the invoice currency.
The caller must supply its authoritative `bookCurrency`; commerce rejects a
missing, unsupported, or different currency because ledgers has no book model.

The revenue journal identity derives from the tenant, invoice, and stable
`moneySnapshotId`. Creation, posting, and the invoice's `arJournalId` link share
the invoice parent lock and transaction, so retries converge. Account IDs from
frozen snapshots are still authorization checked: every used account must be
active and owned by the invoice tenant.

A posted `v2` invoice cannot move directly to `CANCELLED`. Call
`cancelWithRevenueReversal({ bookCurrency })`; it reads the original posted
journal, posts one deterministic journal with every debit and credit reversed,
and stores `arReversalJournalId` with the status transition atomically. The
original journal remains posted. Failed link or reversal writes roll back the
entire operation, and retry returns the same reversal. Legacy tenants keep the
existing recognition and cancellation behavior.
