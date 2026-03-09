---
"@happyvertical/smrt-core": patch
---

feat: make manifest discovery a pure operation — no side effects during reads (#1007)

Added `ObjectRegistry.loadAllManifests()` for upfront manifest loading at startup.
Removed the lazy `registerFromManifest()` side effect from `getInheritanceChain()`.
After `loadAllManifests()` completes, inheritance queries are pure lookups.

Added integration tests for high object counts (400+ manifest entries across 28 packages) (#1008).
Tests validate: no circular inheritance, valid chains, pure reads, topological ordering, and DAG validity.
