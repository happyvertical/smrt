# Tenant line-amount migration

The operational CLI entrypoints are documented in
`@happyvertical/smrt-cli/agents/commerce-money-migration.md`. A CLI migration
chooses and prints its owner UUID before the tenant is claimed, so a failure
after the claim can be resumed with the exact same `--migration-id`; a
different owner is rejected.

`preflightCommerceLineAmounts(db, { tenantId?, out? })` is read-only. It does
not create `TaxSettings`. Review its structured report (and optional explicit
`jsonPath`/`csvPath`) before migration. `UNRECONCILED`, orphan or cross-tenant
lines, missing tenancy, an ambiguous base Contract direction, and an
`in_flight`/`unknown` accounting sync block the tenant before any marker or
document mutation. Draft total changes also require `acceptDraftChanges`.

The migration is the route for tenants that already hold legacy documents.
Tenants created with no documents start on `v2` and need no migration; the
claim refuses a `v2` tenant. For a tenant with no marker, the claim
materializes a `legacy` row first, so migrating an empty tenant still works
(#4009).

`migrateCommerceLineAmounts(db, { tenantId, acceptDraftChanges?, migrationId? })`
claims the tenant marker, maps legacy rates, and processes each document under
the shared tenant barrier. A sensitive internal
`MoneyMigrationDocument` record commits its checksummed pre-image before the
document transaction. The applied transaction stores a checksummed post-image;
an exact retry skips it, while any mismatch fails closed. Runtime reads and
writes remain blocked until every issued document verifies and the marker is
written `v2` last.

Issued migration preserves every previously stored header field, timestamp,
revision and journal link. The only header writes are the additive v2 snapshot
columns `discount_total`, `line_amount_type`, `tax_rounding_scope`,
`seller_tax_registrations_json`, `party_tax_id`, and `money_snapshot_id`.
Issued legacy snapshots always record `line_amount_type=exclusive` and
`tax_rounding_scope=line`, which describe the historical storage contract;
current tenant defaults apply only when calculating new v2 drafts.
Drafts are recomputed through the owning aggregate after their legacy rate is
promoted to an explicit code override. When a tenant has both exempt and
ordinary zero-rate history, migration selects the durable code from each
document's linked customer: exempt customers remain `exempt`; other zero-rate
documents remain `out-of-scope`.

`rollbackCommerceLineAmounts(db, { tenantId, migrationId })` claims the tenant
barrier and validates journal existence plus every current post-image in one
transaction. Every current tenant invoice and contract must have a matching
journal entry; an unjournaled header was created under v2 and makes rollback
unsafe, so rollback refuses before changing the marker or document. Any other
refusal before restoration begins also rolls the claim back, so the tenant
remains on v2 and ordinary runtime reads stay available. Once restoration
begins, each document commits separately under the same owner; an interruption
leaves the marker in `migrating`, and retrying that owner skips durable
`rolled_back` journal entries. Exact pre-images restore the header, lines,
taxes, timestamps and revisions, then the marker returns to `legacy`.
The journal is installed by normal schema migration and retained through the
rollback window. Runtime code never creates its table.
