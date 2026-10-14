# Canonical invoice rounding

Invoice rounding is an explicit backend policy choice. Historical invoices with
empty `invoiceRoundingPolicyJson` retain their independent per-line calculation;
no region, locale, browser draft, or tenant default changes them automatically.
An application authorizes its actor, loads the tenant's approved policy version,
and calls `invoice.configureRoundingPolicy(policy)` followed by `save()`.
The policy includes tenant ID, policy ID/version, currency, `scope: 'invoice'`,
`allocation: 'signed-largest-remainder'`, and `calculation: 'invoice-resolved-v1'`.
The owning tenant and currency must match. Generated writes cannot select policy.
Provider-managed tax cannot coexist with this policy: a nonzero provider tax
amount is an explicit error, rather than a second source of tax authority.

The existing resolved quantity, price and discount establish each line's net.
Each distinct resolved tax rate is a separate additive tax component. The public
ordered cost-billing allocator rounds each component aggregate and distributes
its residual by signed largest remainder, with stable persisted line IDs breaking
ties. Two lines of 10 at five percent therefore total 21, with allocated taxes
1 and 0. This does not change standalone line arithmetic or introduce a compound
rate editor. `allocateInvoiceTax` on the pure `invoices` entry point previews the
same model allocation; editor aggregate totals agree for its nonnegative inputs.

Draft line saves and deletes serialize on the parent and update all allocated
line amounts and the invoice header in one transaction. Removing the last line
sets totals to zero. Model/collection tax and total getters use retained allocated
tax. Reparenting an invoice-rounded line is rejected. Sibling/header revisions
advance during redistribution; reload previously held instances before editing.
Caller transactions own rollback, and failure cannot leave a partially allocated
invoice. A staged authorized policy survives a failed caller-owned transaction so
the same invoice instance can retry its save. Backend callers still own actor authorization; model guards enforce
exact tenant and resource ownership and refuse forged policy/snapshot writes.
A supplied parent must be visible in the active tenant context. New lines may
rely on normal tenant-context auto-population; explicit mismatches are rejected.
An enclosing model transaction rollback also restores the derived freeze, so
the same instance can retry its intended transition without inventing history.

The first non-draft save, or earlier revenue recognition, permanently captures
the policy, sources, allocations, tenant, customer and currency. Subsequent status
changes—including payment reversal back to draft—cannot unfreeze that snapshot.
Line insertion/edit/deletion and monetary policy changes then fail. Notes and
payment-derived status changes remain possible. Revenue monetary prerequisites
are validated before recording the freeze. Revenue recognition and payment
caps consume the same canonical header; journal failure retains the frozen
approved snapshot. This contract does not define credit-note issuance or partial
historical tax reversals. Those require a separate authorized adjustment policy.

Before deploying to existing storage, pause writers and call
`migrateInvoiceRoundingStorage(db, engine)`. It transactionally adds empty TEXT
policy/frozen/allocation columns, is idempotent, and never changes historical
money. Runtime saves do not migrate schema. Complete native Commerce persistence
is supported on SQLite and PostgreSQL; DuckDB's existing hard-FK cascade limitation
remains unchanged. See [test design](invoice-rounding-test-design.md).

## Provider export boundary

The public accounting SDK 0.103.5 `InvoiceLineItemInput` supplies `taxRate`, not an
explicit per-line allocated-tax override. Its QuickBooks mapper also interprets
line amounts as net sales and requires realm tax mappings. Therefore the generic
`toAccountingInput`, `toAccountingLineItem`, and collection accounting export
reject invoice-rounded records explicitly. They do not silently request provider
recalculation. Canonical model JSON, tax/amount getters, and invoice totals remain
available for reports. A provider-specific adapter must establish its exact tax
representation separately before export is supported; no provider is posted here.
