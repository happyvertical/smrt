# Tenant line-amount migration

`preflightCommerceLineAmounts(db, { tenantId?, out? })` is read-only. It does
not create `TaxSettings`. Review its structured report (and optional explicit
`jsonPath`/`csvPath`) before migration. `UNRECONCILED`, orphan or cross-tenant
lines, missing tenancy, an ambiguous base Contract direction, and an
`in_flight`/`unknown` accounting sync block the tenant before any marker or
document mutation. Draft total changes also require `acceptDraftChanges`.

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
Drafts are recomputed through the owning aggregate after their legacy rate is
promoted to an explicit code override.

`rollbackCommerceLineAmounts(db, { tenantId, migrationId })` first reclaims
the same tenant barrier. Every current document must exactly match its recorded
post-image, including its line set and `DocumentTax`; otherwise rollback stops
without overwriting later v2 activity. Exact pre-images restore the header,
lines, taxes, timestamps and revisions, then the marker returns to `legacy`.
The journal is installed by normal schema migration and retained through the
rollback window. Runtime code never creates its table.
