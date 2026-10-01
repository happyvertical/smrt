---
'@happyvertical/smrt-scanner': minor
'@happyvertical/smrt-core': minor
'@happyvertical/smrt-cli': minor
---

**Behaviour change: live ON DELETE / ON UPDATE actions change on `db:migrate`.**
A declared `@foreignKey(..., { onDelete })` now reaches the build-time
manifest, so a foreign key that is also a `conflictColumns` entry keeps its
declared action instead of being emitted `ON DELETE CASCADE`. On PostgreSQL,
`db:migrate` converges an existing SMRT-owned constraint whose only drift is
its ON DELETE / ON UPDATE action; constraints SMRT did not create stay a manual
step.

What this means for an existing database:

- Constraints that were `CASCADE` only because the manifest lost the declared
  action become `RESTRICT`, `SET NULL` or `NO ACTION`. A parent delete (raw
  SQL, admin tooling, a tenant purge) that used to cascade now fails, or nulls
  the child column, until the children are removed first.
- The replacement can also go the other way, toward `CASCADE` / `SET NULL`
  (a foreign key that joins `conflictColumns`, or a declared `CASCADE` that
  now reaches the manifest). Such a change carries a **DESTRUCTIVE** warning in
  `db:diff`, `db:status` and at the top of `db:migrate`; review it before
  migrating, and declare a different action to keep the old one.
- The replacement is build-then-swap: a staged constraint is added
  `NOT VALID`, validated, and only then is the old one dropped and the staged
  one renamed, so no ACCESS EXCLUSIVE lock is held while the child table is
  scanned. Under `--postgres-safe` the validation and swap run outside the
  batch transaction (VALIDATE holds SHARE UPDATE EXCLUSIVE; reads and writes
  continue). `--postgres-safe` also moves the `VALIDATE CONSTRAINT` of a newly
  added foreign key out of the transaction.

Fixes #3023
