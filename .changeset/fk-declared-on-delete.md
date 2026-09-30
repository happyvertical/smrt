---
'@happyvertical/smrt-scanner': patch
'@happyvertical/smrt-core': patch
'@happyvertical/smrt-cli': patch
---

A declared `@foreignKey(..., { onDelete })` now reaches the build-time
manifest, so a foreign key that is also a `conflictColumns` entry keeps its
declared action instead of being emitted `ON DELETE CASCADE`. On PostgreSQL,
`db:migrate` converges an existing SMRT-owned constraint whose only drift is
its ON DELETE / ON UPDATE action by dropping and re-adding it in the
migration transaction; `db:diff` lists the replacement. Constraints SMRT did
not create stay a manual step.

Fixes #3023
