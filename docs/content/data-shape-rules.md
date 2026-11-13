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
- **smrt is relaxing required fields it does not need.** The audit is under
  way; each field it relaxes is listed in the release note. On PostgreSQL
  migrate drops the `NOT NULL` on its own. If your app relied on such a field
  being required, declare it again in a same-named subclass.
