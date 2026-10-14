# Tax summary aggregation

`src/tax-summary.ts` is the pure reporting compiler used before materializing a
commerce tax summary. Its input is normalized stored facts supplied by owning
collections; it never reads Invoice, Contract, DocumentTax, Expense, or ledger
tables itself.

Every input carries a tenant identity. The aggregator only accepts that
requested tenant, an inclusive issue-date period, and issued, non-cancelled
document facts. Credit notes are Invoice rows with positive stored values, so
the aggregator applies their negative sign exactly once.

Kind-row bases are deduplicated by document type/id, tax code, currency,
direction, and code kind before component rows are added. Thus a GST+PST code
contributes its base once to the kind row while component rows retain each
component's stored taxable base. Document counts are unique document identities,
never `DocumentTax` row counts. Currency groups never mix. Zero-rated, exempt,
and out-of-scope bases remain distinct.

Expense supplier components require an explicit tenant-approved code to tax
component mapping. Missing stored facts, unmapped components, and linked
purchase/expense provenance are warnings. Link matching includes currency and
treats a commitment header link as overlapping every linked expense line. A
linked purchase and expense has no reconciled ITC/net total until a per-line
allocation exists; its facts remain visible for drilldown. Ledger movements are
raw posted `credit - debit` values. Components without a liability account are
reported as unassigned. When multiple components share a
liability account, component-level reconciliation is ambiguous: the compiler
keeps the rows visible, emits a warning, and does not compare the full account
movement to every component.

## Materialized Invoice report path

`TaxSummaryReport` is a tenant-scoped, manual materialized report. Its owner,
`TaxSummaryReportCollection.refreshTaxSummary()`, refuses tenants whose
`TaxSettings.moneyModel` is not `v2`: legacy and migrating documents are not a
complete stored-tax source. The caller injects the public Expense and Journal
source adapters because commerce cannot depend on expenses; omitting either
adapter is a refusal, never a zero-ITC fallback.

`DocumentTaxCollection.listReportFacts()` is the Invoice-only source query. It
joins `document_taxes` to `invoices` on both document id and tenant id, filters
inclusive `issueDate` bounds, excludes drafts/cancelled invoices, and retains
written-off invoices. It returns stored `DocumentTax` snapshots without
recalculating tax. A nullable tax-code kind becomes an unassigned-source
warning; it never becomes out-of-scope by inference.

The existing reports adapter is exposed by
`buildTaxSummaryReportAdapterDescriptor()`. Its DataTable columns use the
runtime's snake-case descriptor ids. `drilldownTaxSummaryInvoiceFacts()` takes
a tenant id supplied by the authenticated host, rechecks the materialized row
under that tenant, then applies its currency/component/kind dimensions to the
same Invoice source query. It cannot widen a row into another tenant.

This source currently treats every Invoice as an invoice because the Invoice
`kind` discriminator is supplied by #3939. Once credit notes are stored on
Invoice, this source must select that field and pass positive credit snapshots
through the aggregation's single credit sign step. Contract facts await #3898;
they are not silently included in this path.
