# #3736 explicit collection namespace parity

High risk: generated/runtime permission identity differs across registration paths.
Current public main still contains both gaps. Release batch follows session scope:
worker domain checks only; coordinator owns profile regeneration, consumer proof,
combined review and delivery.

| Behavior/invariant | Reachable trigger | Positive | Negative/failure | Actor/context | Executor/transaction | Runtime/dialect | External edge | Level / command |
|---|---|---|---|---|---|---|---|---|
| Producer preserves explicit namespace | Parse/resolve/emit standalone model | Top-level collection equals declared namespaced collection | Default pluralization stays unchanged; unrelated model does not inherit namespace | Build-time trusted source | N/A: pure scanner, no persistence | Node; SQL dialect N/A | Public manifest adapter | Scanner regression; pnpm exec vitest run src/__tests__/issue-3736-explicit-collection.test.ts |
| Manifest-backed runtime parity | Generated register call passes isolated manifest but no raw collection | Constructor config and resolved collection match explicit declaration, including legacy inconsistent top-level value | Explicit raw override still wins; other package/class remains separate; undeclared default unchanged | Exact qualified constructor identity | N/A: in-memory registry | Node; dialect independent | Generated registration and registry | Core registry regression + existing #3125 STI suite |
| Permission gate uses same namespace | Production-style registration feeds permission lookup | Exact declared permission granted by explicit permission set | Synthetic pluralized permission, missing principal or absent grant cannot replace declared grant | Authenticated caller with explicit set, no system/superadmin bypass | N/A: permission-set/catalog check avoids database | Node; same guard semantics for both DBs | Public users operation guard | Owning users regression; consuming native production proof by coordinator |

No table/schema/dependency changes. Build scanner before core, then core before
public-package users/consumer tests. Worker captures baseline failures before the
two owning fixes, then focused tests and owning typechecks/builds. Ingestion
feedback source is unchanged; prior exact-head coverage must be reconciled by
the coordinator against this additional commit.

## Worker evidence (2026-10-10)

Baseline `edcdd13e4` reproduces all three boundaries: parsed scanner output uses
the wrong collection (1 failure), generated real-constructor registration ignores
the manifest declaration (3 failures, 2 controls pass), and the public permission
guard denies the declared grant (1 failure). With the fixes, focused scanner
conversion/inheritance tests pass 48/48; registry, existing STI and consumer
generation tests pass 42/42; the public users guard regression passes, including
declared grant allow, synthetic/absent grant deny and missing-principal deny.

Scanner/core builds and typechecks pass; users typecheck includes source and
Svelte checks and passes. Full logs are retained under
`/home/will/Work/tmp/smrt-3736-collection/`. Database dialect tests are N/A for
these pure metadata and explicit permission-set checks; the coordinator's rebuilt
consumer native proof owns real production boot/database integration. Compiled
consumer diagnosis must load the generated registration before the endpoint:
endpoint-only imports do not represent application startup.
