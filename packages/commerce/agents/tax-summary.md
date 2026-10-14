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
