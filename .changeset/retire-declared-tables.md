---
'@happyvertical/smrt-core': minor
'@happyvertical/smrt-cli': minor
---

Migrate can now retire a table. A package declares it in `smrt.retiredTables` in its `package.json` (table, last owning class, release, reason and `rows: 'discard'`); the declaration travels in the package manifest, the registry and the app's build, and its list is part of the build's schema stamp. `smrt db:migrate` drops a declared table, and only that, in a whole-schema run: it stops by name when a model still declares the table, when it holds rows without `rows: 'discard'`, or when anything undeclared depends on it (a foreign key, a view or a trigger). A run limited to named tables refuses it. `smrt doctor --db` lists each retirement with its reason, and the release upgrade gate checks each declaration against the release snapshots. Refs #5005.
