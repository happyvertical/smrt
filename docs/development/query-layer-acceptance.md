# Query-layer acceptance (#2815)

This harness measures a synthetic representative library catalog. It does not
reproduce anytown's production dataset, its 519-statement page, authentication
middleware, or wall-clock timings. No production access or AI provider is needed.

## Test design

| Behavior / invariant | Reachable trigger / positive | Negative | Actor / executor | Runtime / edge | Level / command |
| --- | --- | --- | --- | --- | --- |
| Latest catalog chains and stable page | Browse 25 current facts from 25 three-revision chains; exact ordered IDs and values | Superseded revisions, global rows and other tenant facts excluded from tenant-only page | Active tenant A, regular base database connection | SQLite and PostgreSQL 17; public `browseCatalog` | Integration; commands below |
| Tenant authority | Tenant A reads A; explicit global helper includes global rows | Tenant A requesting B is rejected | Tenant A/B; public tenancy interceptors | Both dialects; no HTTP authentication claim | Integration; same command |
| Concurrent cached projections | Three independent panels request the same cold cached projection; identical results | Other tenant row must never appear | Tenant A; normal base database connection on both revisions | Both dialects; public `list` | Integration; same command |
| Statement accounting | Driver executions, including metadata, inside each measured operation | Unsupported driver fails rather than undercounts | Test observer; same executor as framework | PostgreSQL `query`, SQLite `execute` or native statement execution | Integration; same command |
| Before/after parity | Identical fixture and harness at exact baseline and merged framework | Comparison rejects changed output or less than 10x catalog/request reduction | Isolated disposable databases | No production page claim | Comparison script (below) |

Persistence setup is outside the measured request window and is identical for
both revisions. It creates explicit unique slugs and deterministic UUIDs and
timestamps. No framework methods are mocked. Mutation atomicity is N/A: the
measured workload is read-only, and child junction tests own mutation acceptance.
Junction pagination, job polling, schema changes, SQL upserts and serialization
remain independently validated by their child suites. In particular, #2834 owns
the generated and explicitly migrated `NULLS NOT DISTINCT` index proof required
to activate SDK #1246 for ordinary framework schemas. Only catalog and panel
read statements contribute to this representative page total.

## Reproduction

Baseline is
`cc355e952516990f82419eaed566f8c8b6855469`; final evidence must name the merged
framework revision as well as the harness revision. Use the repository's pinned
Node/pnpm and documented install/build, never a substitute dependency tree.

The opt-in test is `packages/facts/src/__tests__/query-layer-acceptance.test.ts`.
Normal package tests skip it. For each revision, install and build in its own
worktree, then run from the worktree root (use absolute output paths outside the
checkout):

```sh
pnpm install
pnpm build
SMRT_QUERY_ACCEPTANCE=1 TEST_DB_ADAPTER=sqlite SMRT_QUERY_ACCEPTANCE_OUTPUT=/tmp/query-before-sqlite.json pnpm --filter @happyvertical/smrt-facts test src/__tests__/query-layer-acceptance.test.ts
SMRT_QUERY_ACCEPTANCE=1 SMRT_QUERY_ACCEPTANCE_OUTPUT=/tmp/query-before-postgres.json node scripts/run-with-ci-postgres.mjs -- pnpm --filter @happyvertical/smrt-facts test src/__tests__/query-layer-acceptance.test.ts
```

The PostgreSQL command requires the existing CI service URL file or
`CI_POSTGRES_BASE_URL_FILE` pointing to a local PostgreSQL 17 administrative
connection. The runner creates and drops a disposable database. The test refuses
an unmanaged PostgreSQL database before connecting. Do not use an application
connection, a shared fixture schema, or a production connection.

Create the baseline with `git worktree add --detach <baseline-directory>
cc355e952516990f82419eaed566f8c8b6855469`, then copy only the acceptance test file
from the harness revision into the same relative path. The framework source and
lockfile must remain at the baseline. Run the identical commands on merged main
with output filenames `query-after-sqlite.json` and `query-after-postgres.json`.
Record `expected_candidate_sha` from the independently verified merged framework
revision measured by the after run (the recorded result below uses
`e1916a0365c933b7dc403952e18722e3d3196cf8`). Future runs must supply their actual
merged revision; do not derive this expected value from the report being checked.
Compare using the harness revision's script:

```sh
node scripts/compare-query-layer-acceptance.mjs /tmp/query-before-sqlite.json /tmp/query-after-sqlite.json "$expected_candidate_sha"
node scripts/compare-query-layer-acceptance.mjs /tmp/query-before-postgres.json /tmp/query-after-postgres.json "$expected_candidate_sha"
```

The comparison requires the exact baseline SHA, the supplied full candidate SHA,
identical ordered results, and
at least 10x fewer catalog and aggregate request statements. A failed threshold
is evidence that the goal has not been demonstrated; do not change the fixture
to manufacture a pass.

Each report retains all observed SQL text, per-component counts, result values,
dialect, actual Git HEAD and the SHA-256 of the complete harness source (including
its fixture recipe). Comparison rejects differing hashes and any warm-panel SQL. Capture the complete
command output separately.
Schema provisioning, seeding and the explicit global visibility check precede
the measured window: model initialization and adapter metadata may therefore be
warm, but no cached panel query has run. The catalog is uncached; the three panel
calls share one initially cold cache key. A fourth warm read is reported
separately and is excluded from the aggregate. Tenant-denial checks also remain
outside the page total. No SQL is subtracted from a measured component.

## Results

The exact pre-epic baseline ran successfully on both real dialects on 2026-09-12
(Node 26.8.1, pnpm 11.25.0; repository Node requirement is >=24.18.0).

| Framework revision | Dialect | Catalog | Three cold panels | Warm panel (separate) | Request total |
| --- | --- | ---: | ---: | ---: | ---: |
| `cc355e952516990f82419eaed566f8c8b6855469` | SQLite | 51 | 3 | 0 | 54 |
| `cc355e952516990f82419eaed566f8c8b6855469` | PostgreSQL 17 | 51 | 3 | 0 | 54 |
| `e1916a0365c933b7dc403952e18722e3d3196cf8` (merged) | SQLite | 1 | 1 | 0 | 2 |
| `e1916a0365c933b7dc403952e18722e3d3196cf8` (merged) | PostgreSQL 17 | 1 | 1 | 0 | 2 |

Both passed the exact 25-row ordered result assertions, projection parity,
explicit global visibility and cross-tenant denial. The baseline worktree had
only the copied untracked harness; `pnpm build` passed all 67 tasks on both
revisions. Both comparisons passed: **51x fewer catalog statements and 27x fewer
representative page statements**, with identical ordered results and zero SQL on
the separate warm read. The measured revision was confirmed merged on 2026-09-12 at 23:19:30 UTC.

All four reports bind the identical fixture and harness source SHA-256:
`9f52f41d8fcd400ff9b839e5362d397c141d9a2be44fb5d3fba6dcff9497dc8d`.
The baseline and measured candidate use their own locked dependency installation.
The measured main commit includes the migration prerequisite and reviewed
pagination code. Its queue squash contains the reviewed pagination tree atop the
merged migration commit.

Final integration validation passed: root tests (131 tasks; 4,808 core tests and
320 facts tests), root type checking (131 tasks), final forced build (67 tasks),
the facts PostgreSQL lane (3 tests), lint, format checking, dependency audit,
instruction-chain validation and both strict knowledge checks. Optional database
lanes skipped by the ordinary root suite remain separately represented by the
real PostgreSQL acceptance runs and child evidence below.

## Independent epic completion evidence

These child proofs remain distinct from the two-statement read-only page. The
final completion record must preserve their exact reviewed revisions and checks.

| Contract | Owning change / proof |
| --- | --- |
| Catalog chain behavior and tenant/STI scope | [PR #2827](https://github.com/happyvertical/smrt/pull/2827), retained by bounded SQL traversal in #2841 |
| Bounded empty, semantic and exact text-fallback pages | [PR #2841](https://github.com/happyvertical/smrt/pull/2841): larger-than-page fixtures, normalized storage/backfill, provider failures and beforeList/afterList authorization |
| Bounded junction reads and bulk lifecycle writes | [PR #2831](https://github.com/happyvertical/smrt/pull/2831): dialect, tenant, rollback and mutation-filter coverage |
| Cached reads retain executor isolation | [PR #2832](https://github.com/happyvertical/smrt/pull/2832): concurrent misses, error/retry and real PostgreSQL transaction isolation |
| Idle runner polling | [PR #2825](https://github.com/happyvertical/smrt/pull/2825): 66 to 6 job statements over equivalent steady 60-second windows; lease recovery remains bounded |
| Membership lookup and UUID migration contract | [PR #2828](https://github.com/happyvertical/smrt/pull/2828): ordered tenant/user index; existing explicit UUID migration path |
| Native nullable conflict upsert | [SDK PR #1246](https://github.com/happyvertical/sdk/pull/1246) plus [PR #2839](https://github.com/happyvertical/smrt/pull/2839): generated and migrated matching indexes, warm one-statement writes, concurrency/tenant integrity, duplicate preflight and rollback/retry; actual PostgreSQL 14 fallback preserved |
| Plain-object serialization | [PR #2835](https://github.com/happyvertical/smrt/pull/2835): output equivalence, performance and browser behavior |

Existing deployments must separately follow the facts package's
[normalized catalog migration/backfill procedure](../../packages/facts/README.md)
and the [NULL-equal conflict-index maintenance procedure](../../packages/core/agents/null-equal-indexes.md).
A PostgreSQL version check alone cannot establish index readiness. Neither
production migration nor removal of consumer-specific workarounds was performed
by this acceptance harness.

The selected integration lane is SQLite and PostgreSQL 17. Canonical DuckDB Fact
persistence remains blocked by the pre-existing self-FK issue
[#2830](https://github.com/happyvertical/smrt/issues/2830); the pagination child's
supplemental DuckDB SQL fixtures are not canonical end-to-end Fact evidence.
This 25-row active-leaf fixture does not replace the child's branch, cycle,
large-table pagination or custom authorization tests.


## Drive-by fixes

Required production regeneration exposed stale registration metadata. Commit
`baa0007ad7f76763c151f08d3a0eb19a57c820e2` updates exactly one generated line in each
of these files (three insertions and three deletions):

- `packages/assets/src/lib/server/smrt-register.ts`
- `packages/content/src/lib/server/smrt-register.ts`
- `packages/images/src/lib/server/smrt-register.ts`

Decoded changes are limited to package versions 0.49.2 → 0.49.3 and content's
already-declared `@happyvertical/smrt-users` development dependency. Canonical
package discovery includes both dependencies and development dependencies. No
package declarations or object/schema definitions changed. The canonical outputs
passed the complete root validation above; the integration work's ownership was
explicitly extended to retain these three generated metadata repairs.
