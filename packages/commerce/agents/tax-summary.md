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

## Materialized document report path

`TaxSummaryReport` is a tenant-scoped, manual materialized report. Its owner,
`TaxSummaryReportCollection.refreshTaxSummary()`, refuses tenants whose
`TaxSettings.moneyModel` is not `v2`: legacy and migrating documents are not a
complete stored-tax source. The caller injects the public Expense and Journal
source adapters because commerce cannot depend on expenses; omitting either
adapter is a refusal, never a zero-ITC fallback.

`DocumentTaxCollection.listReportFacts()` reads stored Invoice, credit-note,
and purchase-Contract snapshots. The Invoice branch joins `document_taxes` to
`invoices` on both document id and tenant id, filters inclusive `issueDate`
bounds, excludes drafts/cancelled invoices, and retains written-off invoices.
The Contract branch gets a bounded, hydrated candidate set from
`ContractCollection.listSnapshotReportContracts()`, then uses the Contract
owner's descendant classifier before joining only those purchase ids to
`document_taxes` on document id and tenant id. This preserves custom
`PurchaseContract` descendants without hard-coding contract enums or party
display names. Contract rows include every non-draft, non-cancelled frozen
snapshot, including `DECLINED`; their `issueDate`, reference (falling back to
the id), and vendor party id are read from the frozen Contract. The query only
returns stored snapshots and never recalculates tax. A nullable tax-code kind
becomes an unassigned-source warning; it never becomes out-of-scope by
inference.

The existing reports adapter is exposed by
`buildTaxSummaryReportAdapterDescriptor()`. Its DataTable columns use the
runtime's snake-case descriptor ids. `drilldownTaxSummaryInvoiceFacts()` takes
a tenant id supplied by the authenticated host, rechecks the materialized row
under that tenant, then applies its currency/component/kind dimensions to the
same Invoice source query. It cannot widen a row into another tenant.

The Invoice branch selects the shared Invoice `kind` discriminator and accepts only
matching `DocumentTax.documentType` pairs: `invoice`/`invoice` or
`credit_note`/`credit_note`. Credit rows retain positive stored values and pass
through the aggregation's single credit sign step.

Refresh holds the tenant `TaxSettings` parent lock through the v2 gate, all
source reads, aggregation, and replacement. Every source-adapter call receives
the same transaction-bound database executor. Replacement rows use a stable
UUID derived from tenant, period, currency, row kind, and dimension, so retry
and concurrent same-period refreshes converge to one row set. Materialized
`list`, `get`, `count`, and Invoice drilldowns all recheck the tenant's marker;
`legacy` and `migrating` refuse even existing report rows.

Each document drilldown fact carries its printed invoice number or Contract
reference, tenant-scoped customer/vendor party id, issue date, stored taxable
base, and stored tax. A runtime host may resolve that party id to an authorized
display name; the commerce source does not cross-join profile data.

`drilldownTaxSummaryContributors()` is the cell-level backend boundary. The
host supplies one of the closed measures (`taxable`, `tax`, `recoverable`,
`net`, `ledgerMovement`, `difference`, `documentCount`, or a warning detail),
and the collection rejects measures that do not belong to that row kind. It
returns only Invoice facts, mapped reviewed Expense facts, and posted Journal
movements that match the persisted tenant, period, currency, component, code
kind, or liability account. Net and reconciliation-difference detail carries
the signed contribution that sums to the selected cell; credit notes are
signed once here from their stored Invoice kind.

Rows persist compact source-class provenance plus an exact warning source
identity, not a duplicate set of source amounts. A missing injected owner,
missing historical provenance, or a source total that no longer equals the
materialized cell returns `complete: false` with a machine-readable pending
reason. Purchase Contract contributors reconcile their stored recoverable
amounts directly; a materialized purchase fact missing from its source returns
`source-state-diverged`, never a zero ITC. The Ledger detail port is adapted from the public
`JournalEntryCollection.listPostedMovements()` and remains raw ledger units;
the host must retain the commerce minor-unit convention.

This release has no runtime reports UI consumer. The descriptor/query bridge is
covered independently, while #3878 (server report contract) and #3895 (the
reports/Svelte minor-unit formatter and drilldown UI) are the external
integration gate. This package intentionally does not duplicate that formatter.
