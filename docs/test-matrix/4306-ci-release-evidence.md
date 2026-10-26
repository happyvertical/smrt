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

Implementation validation on 2026-10-25 at `ff5bec434` (main includes
SDK 0.107.0):

- Frozen install, build (80/80 tasks), and root typecheck (157/157 tasks) passed.
- Full `pnpm test` passed: 157/157 Turbo tasks, 81 cached, followed by the root
  script checks; exit 0. Elapsed Turbo time was 1h 1m 33.689s.
- All eleven CI/export gates passed: packed analytics HTTP rendering on Vite
  7 and 8, the control suite, all 48 package export verifiers, webhooks Svelte
  and browser checks, lint, format, strict knowledge, audit policy, Node-root
  loading, and the pre-push hooks. The Node-root gate retains its existing
  products allow-list; it does not establish products SSR support.
- Validation used the documented private scratch directory and system Chromium.
  The bundled-browser attempt failed on missing host `libgbm.so.1`; the
  documented system-browser run passed. Both records were retained.
- The packed-export negative comparison produced actual HTTP 500 responses in
  both Vite versions when the Svelte condition was removed. Cache fixtures and
  the quiescent 80-producer hash comparison passed before subsequent test-only
  repairs and upstream integration; their source behavior is unchanged.
- Earlier failures remain in the evidence record: shared hook/race budgets,
  missing users fixture temp-directory fallback, app-runtime ownership fixture
  isolation, and CLI Vitest discovering a Node-runner test. None count as
  successful validation. The shared budget/cleanup fixes are now on main.
- The app-runtime repair preserves custody and lease assertions (76 targeted
  cases passed, three platform skips). CLI Node-runner tests now live beside
  the root verifier and remain required by the control suite; all 1,480 CLI
  tests passed after relocation, with 67 existing skips.

The independent release/security review is the next gate. This evidence update
changes documentation only; runtime and test sources match the validated commit.

Baseline measured; after timings pending. No optimization or reuse decision is
considered validated merely because its unit tests pass. Exact-revision review,
documented repository validation, and representative live CI evidence remain
required before declaring #4306 complete.

## Accepted admission review fixes: test design

| Behavior/invariant | Reachable trigger | Positive case | Negative/failure case | Actor/context | Executor/transaction | Runtime | External edge | Level/command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| One acknowledged grant per unchanged head and open window | Repeated PR/group reconciliation | Live validation plus latest authenticated App success reuses the saved nonce | Newer pending, wrong App/context/nonce, close/reopen, or legacy missing window identity requires fresh admission | Trusted controller and release App; unrelated writers cannot authenticate a grant | Protected Git-state CAS; reservation retries cannot replace a newly acknowledged nonce | Node | GitHub reverse-chronological status inventory and quota | Controller/state tests; `node --test scripts/release-admission*.test.mjs` |
| Status write failure retains exactly the required fence | POST fails after reservation | Definitive HTTP 4xx rejection cancels only its exact grant | Network, redirect, 5xx and malformed success remain unsettled; failed pending revocation never freezes | Release App writer; terminated exact writer for manual acknowledgement | Exact-grant CAS; close/reopen clears reuse identity but retains unknown writes | Node | GitHub status POST response and independent writer/status evidence | Forge/controller/state tests; owning command above |
| Uninterrupted drain observes concurrent acknowledgement | close polls while green POST settles | Same invocation refreshes and revokes before freeze | Owner/attempt/phase changes stop the old closer before status writes | Exact Batched Release owner | Fresh protected state read per poll; owner-checked CAS | Node | Delayed status acknowledgement and queue refs | Controller test; owning command above |
| Retry does not consume redundant pending statuses | Closed callback or drain retry | Latest authenticated identical pending status is reused | Different status, unauthenticated writer or failed revocation cannot count as success | Release App/context/SHA | Read-only status inventory before POST; unknown failure remains fail closed | Node | GitHub status quota | Controller tests; owning command above |

These are targeted regressions for the accepted blockers; no SQL dialect or
browser execution is involved because this protocol uses GitHub/Git CAS only.

Accepted-fix evidence on 2026-10-25, based on `d3d9a3b44e01` plus the
uncommitted admission review patch:

- The final nine selected regression cases all fail against the original
  implementation copied from `d3d9a3b44` (exit 1), including repeated PR/group
  reconciliation, acknowledgement during uninterrupted drain, owner replacement,
  stale reservation races, window boundaries and definitive rejection cleanup.
- `node --test scripts/release-admission*.test.mjs`: **80 passed**, zero failures.
- `pnpm test:ci-scripts`: **437 passed** in eight suites, zero failures/skips,
  exit 0. `git diff --check` passed.
- These commands used Node 26.10.0 / pnpm 11.25.0, CPU affinity 0–3 at nice 10,
  scratch `/home/will/Work/tmp/smrt-4306-review` for `TMPDIR`, `TMP`, `TEMP` and
  `CI_TEST_TMPDIR`, and the documented system Chromium executable
  `/run/current-system/sw/bin/chromium`. No builds, containers, registry/GitHub
  writes, or heavy root/package suites were run for this targeted follow-up.
- Local logs: `/tmp/smrt-4306-admission-final-baseline.log`,
  `/tmp/smrt-4306-admission-after.log`, and
  `/tmp/smrt-4306-ci-scripts-review-fixes.log`. Independent exact-patch review
  remains the next gate; these local checks do not replace rollout evidence.


## Producer artifact retry identity (PR #4324 review)

| Behavior/invariant | Reachable trigger | Positive case | Negative/failure case | Actor/context | Executor/transaction | Runtime | External edge | Level/command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Consumers use successful producer IDs across retries | Re-run failed Planner or publisher after preparation and packs succeeded | Attempt-2 consumer selects exact attempt-1 workspace, patch and both pack IDs | Missing or malformed producer IDs never admit publication; consumers cannot fall back to names or wildcards | Same trusted workflow run, default flag-off mode | Immutable Actions uploads; no replacement or overwrite | Node 26, Bash | Actions preserved `needs` outputs and exact artifact downloads | Workflow replay and aggregate shell; `node --test scripts/release-producer-retries.test.mjs scripts/release-window-workflow.test.mjs` |
| Partial pack retry retains independent identities | Only pack 1 failed before downstream jobs | Pack 1 attempt 2 plus pack 2 attempt 1, both using original prepared workspace | Failed, cancelled, skipped or absent results; missing/malformed ID/digest/attempt; duplicate IDs or future attempts fail closed | Separate pack jobs and result aggregate | Distinct producer outputs avoid matrix output collisions | Node 26, Bash | Actions partial rerun semantics | Workflow expression replay and executed aggregate shell; owning command above |
| Window retry cannot change reserved ownership or publication inventory | Flag enabled during a consumer/pack rerun | Original owner/attempt/source qualifies before original deadline | Attempt mix rejected; early assertion rejects wrong owner/source/phase/deadline and post-publication execution routes to original-owner recovery | Actions read credential; Planner has no App secret or write permission | Read-only forge rejects every non-GET before fetch; existing Git CAS and recovery schema unchanged | Node 26; SQL/browser N/A because protocol uses GitHub/Git | GitHub GET rules/state; immutable recovery artifact IDs/digests | Read-only adapter, window/controller and recovery tests; `node --test scripts/release-admission*.test.mjs scripts/recover-release.test.mjs scripts/release-producer-retries.test.mjs scripts/release-window-workflow.test.mjs` |
| No-release preparation remains a valid outcome | Version unchanged | Successful explicit `should-publish=false` needs no artifacts | Missing preparation decision cannot pass | Trusted preparation plus aggregate | Read-only result gate; no publication | Node 26, Bash | GitHub skipped-job results | Executed aggregate shell; owning retry command above |

The new consumer replay fails against the original `b9b9cae50` workflow because
consumer attempt 2 requests `publish-release-workspace-30-2`, while the successful
producer uploaded `publish-release-workspace-30-1`. The read-only adapter test
also fails before its implementation, because the old adapter requires an App
write token even for a qualification assertion. Exact-recovery tests continue
to require original-owner artifacts; producer digest outputs are metadata, not
a new claim of hard archive-digest enforcement.

Validation on 2026-10-25 against `b9b9cae50` plus this uncommitted patch:

- Both producer/consumer behavioral regressions fail against the original
  workflow (two expected failures). The read-only adapter case separately
  fails against its original constructor.
- Owning workflow, admission state/store/controller and exact-recovery tests:
  **106 passed**, no failures or skips.
- `pnpm test:ci-scripts`: **446 passed** in eight suites, no failures or skips.
- Full pre-push checks (`pnpm exec lefthook run pre-push --force`): all
  **17 jobs passed**, including strict knowledge, pinned Biome, standards and
  every workflow's actionlint/yamllint. `--force` executes these checks even
  before the parent commits this patch; the initial invocation without it
  skipped because no unpushed files existed and is not validation evidence.
- Final owning/control commands use Node 26.10.0 / pnpm 11.25.0, affinity 0–3,
  nice 10, scratch `/home/will/Work/tmp/smrt-4306-artifact-retries`, and the
  documented system Chromium executable. Initial narrow runs used the already
  installed Node 26.12.1; no toolchain changes, builds, containers, registry
  publication or GitHub mutations were required.
- Logs: `/tmp/smrt-4306-artifact-consumer-baseline.log`,
  `/tmp/smrt-4306-artifact-readonly-baseline.log`,
  `/tmp/smrt-4306-artifact-retries-owning.log`,
  `/tmp/smrt-4306-artifact-ci-scripts.log`, and
  `/tmp/smrt-4306-artifact-pre-push.log`.

Live GitHub partial-rerun evidence remains pending; workflow expression replay
and executed gate scripts do not establish post-activation latency or live
Actions scheduling behavior.


## Accepted queue blocker: scaffold resource exports

The publish-pack queue run [40202530914](https://github.com/happyvertical/smrt/actions/runs/40202530914)
reached packages omitted by the earlier `verify:pack`-script sweep. Both
scaffold packages export authored files through `./template/*`: Svelte markup
and unrendered JavaScript placeholders are resources copied by the scaffolder.
The accepted fix introduces narrowly validated packed metadata rather than
changing their public export maps or executing template configuration.

All cases run as a package author/release validator on Node 26 with pinned pnpm.
SQL, transactions, browser rendering and tenant context are N/A: these tests
inspect tarball contents and static import closures only.

| Behavior/invariant | Reachable trigger | Positive case | Negative/failure case | Actor/context | Executor/transaction | Runtime/dialect | External edge | Level/command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Copied scaffold files are resources | Packed `smrt.resourceExports` declares a directory pattern | Real SvelteKit and static-JSON template packs pass without parsing placeholders | Undeclared executable wildcard still requires Svelte conditions | Package author/release validator | Packed filesystem; no mutation/transaction | Node 26; SQL N/A | Actual packed metadata and exported resource files | Fixture and real-pack integration; `node --test scripts/verify-package-types-exports.test.mjs scripts/verify-template-packed-exports.test.mjs` |
| Metadata cannot hide arbitrary exports | Malformed or overly broad resource declaration | Unique literal-directory pattern matches its exact unconditioned export and packaged files | Root, global, unknown, duplicate, conditional, escaping or missing-resource declarations fail | Package author/release validator | Packed filesystem; no transaction | Node 26; SQL N/A | Package.json metadata is untrusted input | Fixture command above |
| Runtime paths retain their checks | Runtime entry imports a declared resource | Ordinary runtime root and resource-copy APIs pass | Runtime Svelte edge, malformed JS or missing relative import inside resource directory still fails | Package author/release validator | Static import closure; no transaction | Node 26; SQL N/A | Public runtime entry and transitive imports | Fixture command above |
| Packed metadata is authoritative | Local and packed manifests differ | Valid packed declaration is used despite stale local metadata | Local declaration cannot hide missing packed declaration or runtime exports | Package author/release validator | Packed manifest; no transaction | Node 26; SQL N/A | Tarball/worktree mismatch | Fixture command above |
| Publish inventory includes packages without `verify:pack` | Publish validator discovers eligible packages | Both templates are packed with normal hooks and verified | A script-name-only sweep cannot count as complete publish coverage | Release validator | Existing publish inventory and shard execution | Node 26/pnpm 11; SQL N/A | Fixed release group plus explicit publishConfig | `node scripts/validate-publish-packages.js` (every shard); narrow real-template integration command above |

Evidence on 2026-10-25, based on `4286f91b1` plus this resource-export fix:

- Final regression tests against the original bundled verifier, copied into an
  isolated temporary repository: **10 passed, 9 failed**, exit 1. Both actual
  template packs reproduced their queue failures despite the new metadata:
  missing Svelte condition and unrendered `{{LATITUDE}}` JavaScript syntax.
- The same fixture and real-pack integration command against the fix:
  **19 passed**, zero failures/skips, exit 0. Both packs use ordinary
  `pnpm pack` lifecycle hooks and the root verifier's `--tarball` path.
- `pnpm test:ci-scripts`: **455 passed** across eight suites, zero failures/skips,
  exit 0. The real-template integration tests are included in this command.
- Narrow Biome 2.5.2 and `git diff --check` passed. Commands used Node 26.10.0,
  pnpm 11.25.0, CPU affinity 0–3 at nice 10, and the documented private scratch
  directory. No root build, browser test or container was needed for this fix.
- Inventory inspection found **74 publish-eligible packages**, of which only
  **48** have `verify:pack`. Complete publish-pack execution and exact artifact
  membership validation remain the coordinator's integration gate; the two
  narrow template packs alone do not establish that all 74 qualify.
- Full output: `/tmp/smrt-4306-resource-final-tests-base.log`,
  `/tmp/smrt-4306-resource-owning.log`,
  `/tmp/smrt-4306-resource-ci-scripts.log`, and
  `/tmp/smrt-4306-resource-biome.log`.

Live queue evidence after requeue remains pending. These checks do not claim
that a GitHub queue or publication attempt has succeeded.
