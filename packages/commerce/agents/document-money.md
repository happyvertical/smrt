# Document money persistence

Commerce has one money model. Tax codes resolve each line's tax, the server
computes line `taxAmount` and the header totals, and issuing a document freezes
it with a money snapshot. Every Invoice and Contract money write needs a
tenant; a tenantless write fails with `MoneyValidationError`
`INVALID_MONEY_INPUT` (`Commerce money documents require a tenant`).

### Tenant settings and bootstrap (#4009)

Each tenant has one `TaxSettings` row. It is created once, wherever the first
caller reaches it: `getOrCreateForTenant`, the cookbook path, a generated
create, or the runtime barrier ahead of a tenant's first document. Creation
runs in one transaction under a tenant advisory lock on PostgreSQL (the
embedded write queue elsewhere), re-reads before inserting, and inserts the
deterministic settings id, so racing first writers converge on one row.

`ensureCommerceTenant(db, tenantId, { cookbook? })` is the one host bootstrap
call after tenant creation. It seeds the settings row, the standard tax codes
(`exempt`, `zero-rated`, `out-of-scope`), and the cookbook's commerce tax
settings when one is given. It returns `{ tenantId }` and is idempotent;
re-running it with a cookbook re-applies the cookbook defaults.

Money data written by an earlier version is refused, never read. A schema with
the earlier version's money columns or table, or an Invoice or Contract row
without a tenant, refuses the whole database. A tenant with Invoice or Contract
rows but no settings row, or with old-format documents (an issued document
without a money snapshot, or a line with neither a tax code nor a component
snapshot), is refused on its own. All fail with `COMMERCE_DATA_NEEDS_UPGRADE`
and name `smrt db:upgrade-commerce-money`.
See [money data upgrade](money-upgrade.md). Rows written with raw SQL bypass
the model and are not recalculated.

Every Invoice/InvoiceLineItem get, list, preview, mutation, posting, and
accounting-sync phase checks for old-format data, then acquires the tenant
settings row before document rows. The lock is held through the owning
transaction. Nested coordinators reuse an explicitly registered transaction
executor; adapter shape is never used as transaction proof. Runtime code never
creates schema.

Saving an invoice line locks and reloads its parent on the caller's
transaction, reloads every sibling, resolves current tax defaults, calculates
the document once, and writes line snapshots, `DocumentTax`, and header totals
atomically. Tax resolution order is line override, customer exemption,
product, customer code, then the tenant default; `none` mode uses the tenant's
`out-of-scope` code. Product reads use the products package's collection on that same
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
and `DocumentTax` rows without recalculation. Both facades take the tenant
settings lock and refuse a tenant whose data needs the upgrade.

### Record-screen composition

`loadInvoiceRecordScreenData({ db, tenantId, invoiceId })` is the commerce
server adapter for a generic invoice record page. A caller must already have
that exact active tenant; the adapter never switches principals based on its
argument. It holds the tenant money lock while it reads the stored header,
lines, `DocumentTax`, and related credit-note summaries, so it never mixes a
stale header with a different snapshot of those rows. Its totals
are a direct projection of persisted minor-unit values and component snapshots;
it does not resolve a code or recalculate tax.

`InvoiceRecordScreen` from `@happyvertical/smrt-commerce/svelte` composes that
projection with `RecordScreen.lineItemStoredTotals`, the released generic
line-items widget contract. A host passes its own generic screen wiring and
may expose `onCreateCreditNote` only with a server-derived
`canCreateCreditNote` authorization result. The wrapper hides the action for
credit-note records and never treats a client callback as authorization.

`InvoiceLineItem.amount` is the post-discount amount in the document's
`lineAmountType`: tax-exclusive net for `exclusive`, tax-inclusive for
`inclusive`. `taxAmount` is separate. `taxRate` is derived by the server from
the resolved components (`0.05` means 5%); it is never an input. `taxCodeId` and component identity may be null for
a genuine unassigned zero-tax line. Optional `productId` and
`revenueAccountId` are nullable UUID references so PostgreSQL never receives an
empty-string sentinel.

`DocumentTax` is derived and read-only. Its rows snapshot the code/component
labels, percentage, liability account, taxable minor units, and tax minor
units. Provider tax remains the invoice header's `providerTaxAmount`; commerce
does not invent a tax code or component for provider-owned tax.

Revenue recognition reads only the frozen invoice, lines, and
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

A posted invoice cannot move directly to `CANCELLED`. Call
`cancelWithRevenueReversal({ bookCurrency })`; it reads the original posted
journal, posts one deterministic journal with every debit and credit reversed,
and stores `arReversalJournalId` with the status transition atomically. The
original journal remains posted. Failed link or reversal writes roll back the
entire operation, and retry returns the same reversal.

Billing period close writes ordinary money-model invoices. The payment provider
taxes them, so each billing line is an explicit override to the seller's
`out-of-scope` code, and the provider's tax is stored in `providerTaxAmount`
in the save that issues the invoice.
