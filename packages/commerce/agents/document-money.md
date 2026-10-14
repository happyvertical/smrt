# Document money persistence

Tenant money behavior is selected by the server-owned `TaxSettings.moneyModel`
marker. Missing settings and `legacy` preserve the existing line-save behavior.
`migrating` is a persisted maintenance guard: invoice money writes fail until
the owning migration restores `legacy` or activates `v2`. Generated surfaces
cannot write either the marker or its owner token.

In `v2`, saving an invoice line locks and reloads its parent on the caller's
transaction, reloads every sibling, resolves current tax defaults, calculates
the document once, and writes line snapshots, `DocumentTax`, and header totals
atomically. Tax resolution order is line override, product, customer, then app
default. Product reads use the products package's collection on that same
transaction executor; tenant-owned and catalog-global products are accepted.

The first transition away from `DRAFT`, or setting `arJournalId`, freezes the
money document. The invoice and every line receive the same stable
`moneySnapshotId`. Later payment and lifecycle saves keep that identity.
Frozen fields include party/customer identity, currency, issue and due dates,
document amount/rounding settings, seller and party tax snapshots, line
description/SKU/product, quantity/pricing/discount modes, tax code and component
snapshots, source period, revenue account, and sort order. Header and child
money edits, child moves, additions, and deletions then fail with
`FROZEN_DOCUMENT`; status, payment, reminder, and delivery metadata continue
through their existing lifecycle guards.

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
