# Money data upgrade

Commerce has one money model. It does not read money data written by an
earlier version, and it does not convert that data on the fly. It refuses it
and names the upgrade command. The operator steps are in the CLI guide,
[commerce money upgrade command](../../cli/agents/commerce-money-upgrade.md).

## Detection

`src/upgrade/detect.ts` owns detection. Four shapes count as old data:

- **Old schema.** The database still has `tax_settings.money_model`,
  `tax_settings.money_migration_id`, `*_line_items.legacy_amount`, or the
  `money_migration_documents` table. This refuses the whole database.
- **Documents without a tenant.** An Invoice or Contract row, header or line,
  with no tenant. The current model writes none, and the upgrade cannot convert
  one: assign it to a tenant or delete it. This refuses the whole database and
  keeps the old schema in place until it is resolved.
- **Tenant without settings.** A tenant has Invoice or Contract rows but no
  `tax_settings` row. This refuses that tenant only.
- **Old-format documents.** An issued Invoice or Contract without a money
  snapshot, or a line with neither a tax code nor a component snapshot. The
  current model never writes either, so these stay detectable after `db:migrate --drop-columns`
  removed the old columns. This refuses that tenant only.

`assertCommerceMoneySchemaCurrent(db)` checks the schema.
`assertTenantMoneyCurrent(db, tenantId)` checks the schema, then the tenant.
Both cache a passing result per database (keyed by its connection URL, so
request executors share it) and tenant, so the check runs once per process. A
tenantless collection read still checks the schema, and a tenant's first
`TaxSettings` row is refused while that tenant holds old documents. Every runtime money read and write, the money MCP tools, the tax
summary, and `ensureCommerceTenant()` call them first.

A refusal is a `CommerceDataNeedsUpgradeError` with `code`
`COMMERCE_DATA_NEEDS_UPGRADE`. Its message ends with the command, for example
`Run smrt db:upgrade-commerce-money --tenant-id <id> to upgrade it.`
`commerceMoneyUpgradeCommand(tenantId?)` builds that command text.

`findCommerceMoneyUpgradeNeeds(db)` scans the whole database. It is
operator-only: it ignores the caller's row permissions, so never wire it into
a principal-facing surface. It returns `oldSchema`, `tenantlessDocuments`
(rows to assign or delete) and each tenant that needs the upgrade, with a
reason (`legacy-marker`, `interrupted-migration`, `missing-settings`, or
`old-format-documents`).
`smrt db:status` uses it to report the `commerce-money-upgrade` error
precondition, so `smrt app doctor` reports `migration-required`.

## Upgrade

`upgradeCommerceMoney(db, { tenantId? })` in `src/upgrade/money-v2.ts` is the
one-shot conversion behind `smrt db:upgrade-commerce-money`. Run the normal
schema migration first. Each tenant converts in its own transaction:

1. Its tax settings row and standard codes are seeded.
2. Each stored fractional rate maps to a code. A zero rate becomes `exempt`
   for an exempt customer, otherwise `out-of-scope`. Any other rate becomes a
   one-component `rate-<percent>` code, created once.
3. Issued documents are backfilled from their stored values: line net, line
   tax, tax-code snapshot, `DocumentTax` rows, and a money snapshot. No stored
   total changes.
4. Drafts are recomputed through the runtime from their prices. Only
   old-format lines (no tax code and no component snapshot) are mapped; a
   draft header keeps its amount type and rounding. The result lists each
   draft whose total changed.

An issued document whose stored lines do not add up exactly to its stored
header fails its tenant. So do an invalid stored rate, an invoice posted under
the earlier version (its revenue journal carries that version's provenance,
which current posting and reversal refuse; void it and clear the link, or reset
the data), and an existing `rate-<percent>` code or component that does not
mean exactly that rate. Nothing in that tenant changes, and the result lists
each failing document. A tenant whose earlier
migration never finished also fails; roll it back with the version that started
it, or reset its data. Converted tenants are skipped on a rerun.

Once no tenant needs the upgrade, the old columns and table are dropped. The
upgrade leaves no mode flag. Read `failures` and `remaining` on the result; the
CLI exits nonzero on either. New `rate-<percent>` components have no liability
account and are listed in `componentsWithoutLiabilityAccount`; posting falls
back to the caller's `taxAccountId` until one is assigned.

The runtime never imports `money-v2.ts`. Delete the `upgrade/` directory, the
CLI command, and the detection call sites together once no supported version
can have written old-format data.
