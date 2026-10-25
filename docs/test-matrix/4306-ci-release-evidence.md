# CI selection and release evidence (#4306)

Risk: high — required-check admission, release credentials, and irreversible
registry publication. This work preserves `Required CI` and
`postgres-required`; no merge or live ruleset change is authorized by this PR.

## Baseline and targets

The pre-implementation measurements and source run links are recorded in
[the issue baseline](https://github.com/happyvertical/smrt/issues/4306#issuecomment-6386186109).
One representative successful run per class was sampled; these are not p95s.

| Change class | PR + merge validation | Release dispatch wait | Release duration |
| --- | ---: | ---: | ---: |
| UI export plus packed SSR regression (#4303) | 61m40s | 25m26s | 26m32s |
| Shared runtime plus lock/tooling (#4177) | 48m59s | 23s | 22m20s |
| Persistence (#4156) | 47m39s | 256m47s | 21m34s |

Runner queues were 2–3 seconds. Execution and release scheduling dominate.
The initial engineering targets are metadata/export validation <=45 minutes,
eligible frozen-batch dispatch <=5 minutes, and representative release <=25
minutes. Shared-runtime and persistence validation must not regress. These
are hypotheses, not measured improvements. The sampled export change also
adds a core test; it is not a description-only metadata change.

## Behavior-to-test contract

### Change classes and required stages

The new impact report is diagnostic; it does not replace the existing affected
package selector or authorize a skipped gate.

| Change class | PR and merge-group obligations | Release obligations |
| --- | --- | --- |
| Description/author/license metadata only | Existing affected selection plus control-plane tests; public export checks remain available | Frozen source, versioned packed artifacts and Planner qualification |
| Exports or package contents | Package/export verification and affected consumers; packed analytics HTTP SSR remains in core coverage | Validate the actual versioned tarballs, including packed consumer/Planner gates |
| Shared runtime, scanner, lock or workflow | Conservative full diagnostic scope; existing package, browser, PostgreSQL and aggregate gates remain | Fresh qualification; no cross-run receipt reuse |
| Persistence or tenant/authentication inputs | Affected package tests and all registered ordinary-role PostgreSQL suites, partitioned without omissions | Existing package qualification plus exact publication inventory |

`Required CI` now also requires the script/control-plane lane. The independent
`postgres-required` context requires both matrix shards to succeed. Browser work
can start after its scope/build prerequisites without waiting for package tests.

All rows run as a same-repository contributor or trusted GitHub workflow.
External-fork validation must remain rejected by the existing admission guard.
Node 26 and the repository-pinned pnpm are the supported control-plane runtime.
SQL dialect is N/A for selector/receipt unit tests: these inspect inputs and
results, not application rows. Selected persistence suites retain their actual
database coverage and ordinary-role PostgreSQL execution.

| Invariant / reachable trigger | Positive case | Negative / failure case | Executor / transaction | External edge | Level / command |
| --- | --- | --- | --- | --- | --- |
| CI control-plane tests gate PR and merge results | Script suite succeeds and aggregate accepts it | Skipped, cancelled, failed suite cannot pass aggregate | GitHub job dependency results; no DB transaction | Required CI context | Workflow contract; `node --test scripts/ci-control-plane-workflow.test.mjs` |
| Independent browser validation does not wait for package tests | Selected workbench lane starts after successful scope | Failed scope cannot start it; full mode still requires build | GitHub job DAG; no DB transaction | Hosted scheduling and required aggregate | Workflow contract and representative live timing |
| Packed Svelte entrypoints have effective export conditions | Real UI package, separate source/compiled targets and plain currency export pass | Missing/shadowed Svelte condition or missing target fails | Packed filesystem traversal; no DB transaction | Svelte SSR resolution | `node --test scripts/verify-package-types-exports.test.mjs` plus real UI pack verification |
| Impact selection follows both source revisions | Changed package and reverse consumers selected | Removed/renamed package or dependency cannot vanish from scope | Read-only exact Git objects | Git base/head identity | Unit/integration; `node --test scripts/ci-impact.test.mjs` |
| Unknown selection inputs fail broad | Known package input selects proven closure | Missing history, malformed manifests, unknown paths/config select full or fail | Read-only Git objects | Workspace and implicit test/build imports | Unit/integration; `node --test scripts/ci-impact.test.mjs` |
| Metadata classification preserves public contracts | Description-only edits distinguished from runtime inputs | Exports, scripts, dependencies, packaging changes retain consumer checks | Parsed manifests at base and head | Published package resolution | Unit; `node --test scripts/ci-impact.test.mjs` |
| Shared harness/toolchain changes invalidate scope | Full suite selected for global inputs | Lock/workflow/scanner/vitest changes cannot be treated as leaf edits | Read-only Git objects | Relative imports outside package graph | Unit; `node --test scripts/ci-impact.test.mjs` |
| Reuse requires authenticated equivalent evidence | Exact inputs and successful trusted producer | Stale/forged/partial receipt or differing tree falls back to validation | Immutable artifact plus independently verified run provenance | GitHub artifact/run API | Receipt and workflow tests required before enabling reuse |
| Frozen releases exclude later admissions | Finite admitted set drains before snapshot | Admission race, replacement group, partial publication cannot reopen unsafely | Atomic durable admission state; registry writes are irreversible | GitHub queue/ref API and registry | State-machine and live integration evidence required before activation |
| PostgreSQL sharding preserves the complete suite | Current Turbo graph assigns every registered suite exactly once | New nested packages, missing ingestion, failed/cancelled/skipped shard fail closed | Independent PostgreSQL service per shard; unchanged ordinary SQL role | Turbo task graph and required aggregate | `node --test scripts/postgres-test-shard.test.mjs scripts/release-window-workflow.test.mjs` |
| Generated declarations do not invalidate their own producer | Clean, generated and warm-cache hashes match; cached build restores declarations | Source, core generator and handwritten declarations still invalidate dependent tasks | Real Turbo execution in isolated fixture | Turbo file hashing and local artifact cache | `node --test scripts/turbo-generated-inputs.test.mjs` |
| Durable admission survives concurrent writers and lost events | CAS refresh, finite drain and exact-owner reconciliation | Missing state, foreign writer, stale owner, deadline and publication races retain protection | Protected Git state branch and App-only status | GitHub refs/rules/runs API | `node --test scripts/release-admission*.test.mjs` |
| A delayed green status cannot escape its release window | Every PR/group status grant is acknowledged before drain revocation and freeze | Delayed POST, duplicate callback, reused SHA and unknown write remain fenced; explicit acknowledgement rejects forged or absent App evidence | Exclusive CAS grant plus independently verified terminated writer and nonce-bearing status | GitHub status and workflow-attempt API | `node --test scripts/release-admission.test.mjs scripts/release-admission-state.test.mjs` |
| Partial release resumes original content | Original completed attempt, verified bundle and packs, idempotent primary publication | Running owner, substituted/expired ZIP, unsafe extraction, wrong parent/ref/version rejected before writes | Immutable bound artifacts and isolated Git worktree; no candidate scripts | GitHub artifact service and primary npm registry | `node --test scripts/recover-release.test.mjs` |
| Packaged analytics renders over HTTP | Correct Svelte export returns successful HTTP | Broken export reproduces server failure | Built consumer process; DB N/A | Vite 7/8, Svelte SSR, published package exports | Existing `packages/core/src/consumer-plugin/analytics-context-packed-ssr.test.ts` |
| SQLite process races retain assertions and bound child lifetime (#4310) | Three process-pair phases finish within the scoped integration budget | A stalled child is terminated within 15 seconds; cancellation must await actual child closure before removing its database directory | Independent uncached SQLite runtimes; unchanged transaction assertions | Node child processes and Vitest cancellation | Reactions package tests, controlled contention, stalled-child and live-child abort-order probes |
| Hook budgets match declared test budgets (#4311) | All 33 affected effective Vitest project contexts have matching budgets | Non-inherited root settings cannot stand in for child-project budgets; unaffected analytics projects stay unchanged | Vitest configuration resolution; no DB transaction | Shared manifest-registration setup | Effective configuration proof plus types, mobile-contract and web suites |
| Unmapped legacy-lease ancestry is isolated from application data (#3877 fixture repair) | Home-owned application fixtures serialize initialization and wait for a live legacy lease while `/tmp` reads as uid 65534 | Ambient `/tmp` fixtures previously failed application custody preflight before reaching lease assertions; ownership rejection remains unchanged | Independent SQLite initializer/legacy-holder processes; existing lease assertions retained | Mocked filesystem ownership; home fixture and legacy lease teardown | `pnpm --filter @happyvertical/smrt-app-runtime test src/local-runtime.test.ts`: 76 passed, 3 skipped with ambient `/tmp`; package typecheck passed |

## Reuse and scope constraints

- Package-level graph reachability is conservative. Commerce backend code
  imports `smrt-ui/currency`; users and ingestion also declare UI dependencies.
  A UI export edit cannot simply bypass their persistence tests.
- Test-only source exemptions require proof: relative Vitest imports and
  generated test manifests create dependencies beyond package.json.
- Existing tarball manifests prove inventory, version and SHA-256, not trusted
  source/toolchain/workflow provenance.
- Planner release qualification currently resolves an external starter and
  fresh dependencies. A repository tree/lock digest alone cannot justify reuse.
- The packed-export sweep exposed missing Svelte conditions on assets, content
  and images `./workbench`, Planner `./commands`, and products `./components`
  and `./stores`.
  Their conditions select the existing targets. Products' components and stores remain
  precompiled client code; condition validation does not establish SSR support.
- PR heads, merge-group heads, squash commits and versioned release artifacts
  are distinct identities until equality is proven for the relevant contract.
- The approved release direction is a bounded admission window. Active-run
  polling and a timestamp cutoff do not atomically exclude newly green groups.
  Publication requires a reviewed durable admission mechanism before activation.

## Evidence status

Implementation validation on 2026-10-24:

- Control-plane suite: 423 passing tests; workflow syntax validation passed.
- Build: 80 tasks passed. Root type checking: 157 tasks passed.
- All 48 registered package export verifiers passed. Packed analytics HTTP
  rendering passed on Vite 7 and 8; the broken-export comparison failed as expected.
- Generated-declaration cache fixtures passed; all 80 producer hashes matched
  the quiescent post-build graph.
- Reactions' approved vote/close race-test correction passed all 27 package
  tests, type checking, Svelte checking and build; it changes no production code.
- Root lint, format, strict knowledge, audit policy and the existing Node-root
  gate passed. The Node-root gate retains its existing products allow-list.
- Full root tests remain unresolved: local runs hit the injected 10-second
  manifest-setup hook deadline; the subsequent cluster run completed 101/109
  Turbo tasks before the reactions SQLite process-race test exceeded its
  five-second unit-test budget. Complete failure logs were retained.
- The owner approved including #4310 and #4311 as separate attributed commits
  with explicit scope exceptions. #4310 gives the three-phase SQLite race a
  60-second integration budget with 15-second child deadlines and guaranteed
  reaping. #4311 pairs hooks with already-declared test budgets, as required by
  `TESTING_STANDARD.md`; it changes no selection, retries, pools or assertions.
  Integrated full validation and independent review remain required.
- The subsequent root run completed 115/121 Turbo tasks before app-runtime's
  two unmapped-`/tmp` lease cases failed custody preflight: their application
  data also lived under the mocked foreign-owned `/tmp`. The test-only repair
  gives those two fixtures a home-owned parent and preserves runtime custody,
  serialization, and legacy-lease assertions. The full targeted file passed
  (76 passed, 3 skipped), package typechecking and source Biome checks passed,
  and no home fixture remained after teardown. This check deliberately retained
  ambient `tmpdir() === '/tmp'`; the documented owned-scratch profile in
  `TESTING_STANDARD.md` avoids the original fixture collision and explains the
  other session's passing run. Both repaired cases also passed with all four
  documented scratch variables set to a fresh user-owned directory, which was
  removed after the run. Integrated root validation is still required.

Baseline measured; after timings pending. No optimization or reuse decision is
considered validated merely because its unit tests pass. Exact-revision review,
documented repository validation, and representative live CI evidence remain
required before declaring #4306 complete.
