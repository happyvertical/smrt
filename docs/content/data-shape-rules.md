---
id: data-shape-rules
title: Data shape rules
sidebar_label: Data shape rules
sidebar_position: 5
---

# Data shape rules

The app decides what its data looks like. smrt requires a field only when its
own code would be wrong or unsafe without it, and it says why. When an app
needs a stricter rule on a smrt class, it writes a subclass.

The rules apply to every smrt package and to your app:

1. smrt requires a field only when its own code needs it. Every required field
   states a reason (`requiredFor`).
2. Shape is declared only in what an app registers: model classes (including
   the app's own subclasses) and run-time model definitions. The live database
   is never a source of shape.
3. An app hardens a smrt class with a subclass that overrides fields. The same
   name replaces the smrt class everywhere in the app. A different name is a
   new, stricter kind next to it.
4. Migrate makes the database match the code without asking, whenever that is
   safe: no data is lost, and migrate sees every package it saw last time.
5. Migrate stops only when it would lose or invent data.
6. Every release upgrades a database made by the previous release and by the
   oldest supported release.
7. Migrate is all or nothing, and new code waits for it.

The full text, how smrt keeps each rule (which test, build check or doctor
line), and a worked example of hardening a smrt class are in
[`packages/core/agents/data-shape-rules.md`](https://github.com/happyvertical/smrt/blob/main/packages/core/agents/data-shape-rules.md).
That file ships with `@happyvertical/smrt-core`. A project that runs
`smrt docs:agents` gets the same text in the "Data shape rules" section of
`.agents/smrt-framework.md`, and its `AGENTS.md` block points there.

## What changes for operators

Read this before you upgrade a deployed app.

- **Migrate is all or nothing.** It works out every change first. If any change
  would lose or invent data, it applies none of them, lists each stop and what
  it held back, and exits 1. Fix the stop and run the whole migrate again.
  `--apply-unblocked` is gone: using it exits with an error. A script that
  relied on partial apply must clear every stop first. `--null-orphans` still
  works as an explicit data step. `--postgres-safe` is the one exception:
  table changes commit first, indexes build after, and a rerun finishes the
  indexes. Details: [`db-migrate-all-or-nothing.md`](https://github.com/happyvertical/smrt/blob/main/packages/cli/agents/db-migrate-all-or-nothing.md).
- **Migrate stops on a missing package.** It remembers the packages it saw
  last time. If one is not loaded now, migrate stops before it writes anything,
  because the missing package may have declared columns as required and migrate
  would loosen them. If you removed the package on purpose, run
  `smrt db:migrate --confirm-removed-package <name>`, once for each package.
  The first migrate on a database with no record only prints a notice and
  writes the record.
- **Production start refuses a database that was not migrated for the build.**
  The app compares the schema its build expects with the one the last migrate
  recorded. If they differ, or there is no record, it does not start and the
  error names `smrt db:migrate`. After you upgrade smrt, run `smrt db:migrate`
  once before you start the new build. An old copy that restarts after the
  migrate is refused too, and so is code rolled back without its database.
  For an emergency, set `SMRT_ALLOW_UNMIGRATED_START=1`; the app starts and
  logs a warning. In development the app warns and starts. Tests are exempt,
  and so are databases made by `getTestDatabase()`.
- **A redeclared field keeps its parent's options.** If your subclass declares a
  field again, it now inherits every option the parent set and changes only
  what you write. A subclass that wrote the field bare, hoping to reset it, now
  keeps the parent's `required`, `unique`, bounds and the rest. To clear an
  option write `null`; to loosen one write the new value (`required: false`).
  Rebuild after you upgrade, then run `smrt db:migrate --dry-run` to see any
  column changes this causes.
- **Built manifests carry package-relative paths.** `dist/manifest.json` no
  longer holds a path from the machine that built it. `pnpm build` in this
  repository fails if one appears. An app has nothing to do beyond rebuilding
  with the new release.
- **90 fields are no longer required.** The audit of every required field in
  a smrt package is complete. 767 required fields state a reason, and none is
  left unexplained. The fields smrt does not need became optional. The columns of the 90 fields lose
  `NOT NULL` when migrate runs, with no flag. If your app relied on one of them
  being required, harden it in a same-named subclass. The list, by package and
  class, is on [Fields smrt no longer requires](./relaxed-required-fields.md).
- **Commerce contract links are optional.** `customerId` on `Estimate`, `Order`,
  `Lease`, `Agreement` and `WholesaleOrder`, and `vendorId` on `PurchaseOrder`
  and `SupplierQuote`, no longer need a value. An estimate with no customer
  still cannot be converted to an order: the conversion refuses it. If you want
  the link required on save, harden it in a same-named subclass.
- **SQLite and DuckDB apply the same changes as PostgreSQL.** Where `ALTER`
  cannot do a change, migrate rebuilds the table inside the same atomic run
  (and the tables that reference it on DuckDB), so a failure part-way leaves
  everything as it was. A change that used to stop on SQLite or DuckDB now
  applies, and dropping `NOT NULL` from a column the code declares nullable
  applies by default on all three. Six differences remain, each with a reason:
  the shared-table `CHECK` exists only on PostgreSQL; removing a foreign key
  stops on PostgreSQL (the adapter does not give the live constraint name); a
  SQLite table declared `AUTOINCREMENT` stops; a DuckDB table that references
  itself stops when the change needs a rebuild; a DuckDB constraint that names a
  dropped column stops; and the JSON adapter cannot rebuild. The list is in
  [`schema-paths.md`](https://github.com/happyvertical/smrt/blob/main/packages/core/agents/schema-paths.md).
- **Migrate refuses a database older than the oldest supported release.** That
  release is 0.60.17. The error names it and the first upgrade to run. A
  database with no migrate record is not refused. Every release upgrades the
  previous release and the oldest supported one, and the pull request job
  `pnpm check:release-upgrade` rehearses both. The release workflow does not
  run that gate yet; the maintainer saves each release's schema with
  `pnpm release:snapshot` by hand.
- **`smrt doctor --db` shows the next migrate.** A "Next migrate" section lists
  the constraints made by hand that migrate will remove, rules in code the
  database does not enforce, what migrate applies and stops on, what it would
  hold back, the packages last seen against those loaded, the database's
  release, and the build's schema fingerprint next to the database's. It reads
  and writes nothing.
