# Commerce money upgrade command

Commerce has one money model. It refuses money data written by an earlier
version with `COMMERCE_DATA_NEEDS_UPGRADE` instead of reading it. Four shapes
count as old data:

- The schema still has the earlier version's money columns
  (`tax_settings.money_model`, `*_line_items.legacy_amount`) or the
  `commerce_money_migration_documents` table.
- An invoice or contract row has no tenant. The upgrade lists each one; assign
  it to a tenant or delete it, then rerun.
- A tenant has invoices or contracts but no tax settings row.
- A tenant has an issued document without a money snapshot, or a line with
  neither a tax code nor a component snapshot (found even after
  `db:migrate --drop-columns`).

`smrt db:status` reports this as the `commerce-money-upgrade` error
precondition, so `smrt app doctor` reports `migration-required`.

Run the normal schema migration first, then upgrade once:

```sh
smrt db:upgrade-commerce-money --check              # report only, no writes
smrt db:upgrade-commerce-money                      # every tenant
smrt db:upgrade-commerce-money --tenant-id <id>     # one tenant
```

What happens to each tenant:

- It converts in its own transaction.
- Its tax settings and standard codes are seeded.
- Each stored line rate becomes a tax code: `exempt` or `out-of-scope` for a
  zero rate, otherwise a `rate-<percent>` code.
- Issued documents are backfilled from their stored values, and no stored
  total changes.
- Drafts are recomputed, and the command prints every draft whose total
  changed.

The command is strict. An issued document whose stored lines do not add up
exactly to its stored header fails its whole tenant: nothing in that tenant
changes, and the command lists each failing document. So do an invalid
stored rate, an invoice posted under the earlier version (void its journal and
clear the link, or reset the data), and an existing `rate-<percent>` code that
means a different rate. Fix or reset that data and rerun; converted tenants are skipped.
Every run also sets contracts whose billing schedule is NULL (written before
the column defaulted to empty) to empty, and prints how many (#4155).
Once no tenant needs the upgrade, the earlier version's columns and table are
dropped. The command exits nonzero while any tenant still needs it.

New rate components have no tax liability account, and the command lists
them. Posting falls back to `taxAccountId` until you assign one.
