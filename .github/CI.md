# Continuous integration architecture

SMRT uses hosted runners for lightweight static and control-plane checks and
the shared `arc-happyvertical-nodocker` broker lane for general builds, tests,
and publishing.
There are two build-output caches, split by lane: self-hosted runners use the
internal Turborepo server, and GitHub-hosted runners use GitHub Actions cache
entries written through the `caching-for-turbo` shim (key prefix `turbogha_`)
described under Hosted Turbo cache below. Raw GitHub Actions cache archives of
`.turbo/cache` remain deliberately unused — the archive model pays full
upload/download for a mostly unchanged blob and races on save. If either
remote cache is unavailable, Turbo performs a cold build; a cache outage
never fails a job.

## Manifest generation

SMRT package builds scan each source tree once. The Vite plugin creates the
initial manifest during `configResolved`, reuses it for the first `buildStart`,
and rescans only on later watch rebuilds. Do not restore an unconditional first
`buildStart` scan; it doubles manifest work for every non-watch library build.

Vitest still generates one test manifest per package process so test-local
`@smrt()` classes remain discoverable. Core's exhaustive suite is different:
the build job seeds the cacheable `@happyvertical/smrt-core#generate:test`
task, and all three core shards restore that exact output before invoking
Vitest. A Turbo cache outage may make a shard regenerate the manifest, but must
never prevent the tests from running.

## Runner selection

- `arc-happyvertical-nodocker` is the default selector for general Linux work
  (happyvertical/iac#1316, #2194). It is the workflow-facing broker lane alias;
  only runner-pool policy chooses its backing capacity. Its Pods carry no
  Docker daemon — that is the point: dropping the dind sidecar takes each Pod
  from 26 GiB to 14 on a memory-bound fleet, and none of the jobs on it speak
  to Docker.
- `arc-happyvertical` remains the selector for jobs that need the dind
  sidecar. Today that is only the dormant `postgres-tests.yml` (gated on
  `vars.CI_POSTGRES_ENABLED`, unset), whose `services:` container needs a
  Docker daemon until the node-level CI Postgres
  (willgriffin/nixos-config#224) is adopted in its own change.
- `arc-happyvertical-node` is retired and must not be selected. Nothing
  registers it, and because iac quiesced the scale set to `minRunners`/
  `maxRunners` 0 — GitHub's queue-drain mode — a job naming it is still assigned
  and then queues until it times out rather than failing. `.github/actionlint.yaml`
  omits the label so lint rejects it instead. If a node capability lane is ever
  activated again it needs a fresh, served label.
- Lightweight lifecycle, policy, stale-management, and mobile jobs remain
  GitHub-hosted when they do not benefit from a self-hosted cache.
- Three `test-suite.yml` jobs are pinned to a plain `ubuntu-latest`
  permanently (#2236, phase 0 of happyvertical/iac#1349): `affected-scope`
  (checkout plus a paths-filter), `lint` (Biome via `npx`, no workspace
  install), and `test-packages-result` (no checkout at all — it reads
  `needs.*.result` and exits). None runs a Turbo task or `setup-environment`,
  so none can restore from the internal cache or the hosted shim, and the
  fleet's memory is irrelevant to all three. On the fleet they could instead
  wait out a netboot of up to 780 s, or queue behind the heavy shards on an
  8-slot pool. Hosted minutes are free and unmetered on this public
  repository, so the move costs nothing and returns the slots. This resolves
  the aggregation asymmetry previously recorded here: `test-packages-result`
  and `required-ci` are the same shape of job and are now on the same lane.
  Backing a required status argues for starting promptly, not for queueing.
- Every job in `test-suite.yml` that is still on the fleet, and every
  self-hosted job in `publish-dry-run.yml`, selects its runner through the
  emergency lane selector
  `${{ vars.CI_HOSTED_FALLBACK_ENABLED == 'true' && 'ubuntu-latest' || '<label>' }}`.
  Flipping that repository variable moves the merge-blocking validation path
  onto GitHub-hosted runners without a workflow merge — which would itself
  need the down fleet. Both files must carry it because `Required CI`
  aggregates jobs from both; a lever that moved only the test suite would
  leave the aggregator blocked on queued dry-run jobs. It is a manual
  lever, not a dispatcher; automated hosted fallback is tracked separately.
  The three pinned jobs above carry no lever, and must not be given one: they
  are already hosted, so a fallback has nothing to move them to, and an
  expression with one reachable branch invites a reader to believe the other
  is live. The release publish path, standalone build, and postgres jobs stay
  on the self-hosted label and queue instead. actionlint does not validate
  labels inside expressions, so the allowlist in `.github/actionlint.yaml` is
  unaffected. The variable selects only the runner: on `pull_request_target`
  events both main-scoped cache write paths stay closed — the Turbo shim
  refuses the event and the pnpm-store `actions/cache` step is skipped (see
  Hosted Turbo cache) — so fallback PR validation builds and installs cold
  while merge-group fallback runs stay warm. The merge queue, not PR
  validation, is the gate that decides what lands.

The PR caller uses `pull_request_target`, so GitHub loads runner selection from
the trusted base branch rather than contributor-controlled merge YAML. It passes
a PR head SHA to reusable general-CI workflows only when the head repository
equals `github.repository`; merge-group and trusted push workflows use the
broker normally. External fork PRs keep a base-revision hosted control-plane
check, while the self-hosted validation call is skipped and `Required CI`
rejects the run on that skipped result. Broker admission must also deny those
fork events before making a reservation.

`CI_NODE_RUNNER_ENABLED` is gone from this tree — nothing reads it, and the
migration it was conditioned on is live. If the repository still defines the
variable it is inert and can be deleted.

The pnpm store and runner workspace must remain on the same node-local
filesystem so pnpm can hardlink packages. Do not restore RAM-backed split
mounts without measuring runner memory and install latency. The shared setup
action also points `TMPDIR` at the workspace-backed runner temp directory so
SQLite fixtures and other temporary test files bypass the container overlay
filesystem. Self-hosted runners can provide `CI_TEST_TMPDIR` to route those
files to a bounded, test-only scratch volume; other runners retain the
workspace-backed fallback.

That volume is **disk-backed, not a tmpfs**. On the metal fleet it is a plain
`emptyDir` with a size limit and no `medium: Memory`, so writes land on the
node's state disk: 9.5 ms per synced write measured inside a runner Pod on
`metal-782bcb5e4e67`, 3.8 ms on `pxe-runner`. That latency is why
`packages/vitest` strips durability from file-backed SQLite test databases
(#2221) — before it did, catalog-seeding tests issuing roughly 41k fsyncs
took 200-400 s each against a 60 s timeout.

Do not "fix" that by making the volume memory-backed. Memory-backed volumes
were deliberately removed from this Pod shape because they are charged
against the container memory limit, and the runner's current memory figure
was settled only after a smaller shape measured an 18% merge-queue failure
rate; the reasoning lives next to the shape in `willgriffin/nixos-config`.
Making synced writes cheap belongs in the runner image instead
(happyvertical/iac#1329).

## Hosted Turbo cache

GitHub-hosted runners cannot reach the internal Turbo cache server, so the
shared setup action starts the `rharkor/caching-for-turbo` shim on them: a
localhost server speaking the Vercel remote-cache API that stores one GitHub
Actions cache entry per Turbo task hash under the `turbogha_` key prefix. The
gate is `runner.environment == 'github-hosted'` — the pod-injected `TURBO_*`
variables are runner process env, which the `env` context in a step `if:`
cannot see. Self-hosted pods therefore never start the shim and keep the
internal server. The `turbo-cache-shim` input (`auto`/`on`/`off`) is the
per-call kill switch; `on` is debug-only because the shim's `GITHUB_ENV`
exports would shadow the pod-injected internal cache env. The step also
refuses `pull_request_target` events — those runs carry main's cache write
scope while executing PR-head code, so the shim there would hand unreviewed
code a write path into entries every other run restores — and it sets
`continue-on-error` so a shim that fails to start degrades the job to a cold
build instead of failing it. The pnpm-store `actions/cache` step in the same
action is skipped on `pull_request_target` for the same write-scope reason:
`pnpm install` runs PR-head lifecycle scripts, and the saved store would be
a main-scoped entry trusted runs restore.

Two properties of this pool differ from the internal server and matter for
trust in it. Entries are immutable: a save against an existing `turbogha_`
key fails, so the first write for a task hash wins until the entry expires
or is pruned. And Turbo only re-executes when a hashed input changes: a main
commit that changes a helper script outside a task's declared inputs keeps
the old hash, so the stale entry keeps winning — forcing the seed would not
replace it. The exposure is bounded (it requires a helper-only change, the
lane is emergency-only, and idle entries expire in seven days), and the
remediation is pruning `turbogha_` entries when activating the fallback
after a suspect change, not forcing builds. The durable fix for a recurring
case is declaring the helper in the task's `inputs` in `turbo.json`, which
benefits the internal cache equally.

GitHub Actions cache is branch-scoped: runs restore only entries written by
their own branch or by main. PR and merge-group runs cannot warm each other,
so `turbo-cache-seed.yml` (push to main, daily schedule as a 7-day-idle
eviction backstop, manual dispatch) seeds `build` and `typecheck` — the
latter pulling `generate:test` through its task dependencies — which are
exactly the task types `test-suite.yml` restores. `test` tasks are
environment-sensitive and deliberately not seeded. The scheduled and push
runs stay skipped until the repository variable
`CI_HOSTED_TURBO_CACHE_ENABLED` is `true`; manual dispatch bypasses the
variable so the lane can be validated first, mirroring the PostgreSQL lane.

The `turbogha_` pool shares the repository's 10 GiB Actions cache quota with
`mobile.yml`'s Gradle entries (about 3.8 GiB when this lane was added) under
least-recently-used eviction. An unbounded Turbo pool degrades the mobile
nightly to slower cold Gradle runs rather than breaking it, but watch the
usage report the seed job prints. The shim's built-in cleanup options apply
only to its S3 provider, so pruning here is manual:
`gh cache list --key turbogha_` and `gh cache delete`. Entries idle for
seven days expire on their own.

## Job timeouts

Standalone validation jobs on the self-hosted lanes use
`timeout-minutes: 45`. The value is a standard, not a per-job estimate: the
previous spread ran from 5 to 45, mostly unexplained, and the low end was close
to the pool's own queue wait (p90 1483-1933s measured over 180 jobs, against a
median execution of 39-50s). A ceiling near that scale is fragile — it leaves
nothing for a cold Turbo cache or a slow checkout, and it invites cancelling
healthy work.

The heavy jobs in `test-suite.yml` intentionally use 90 minutes. #2210 raised
them after healthy merge-group work was cancelled at the old 45-minute ceiling
(runs 30798553114 and 30832703730); this is execution headroom, not a response
to queue wait. Keep 45 for the standalone jobs below unless they have their own
measured reason to move.

`timeout-minutes` is measured from the moment a job starts executing, not from
when it is queued, so this ceiling does not govern queue wait and raising it
does not fix a job that is requeued while waiting. That behaviour is tracked
separately in happyvertical/iac#1282. Do not treat a change here as a fix for
requeueing.

These jobs deliberately sit below their otherwise applicable ceiling, with the
reason recorded next to the setting or here:

- GitHub-hosted jobs that set a timeout (`dependency-audit` at 10,
  `mobile.yml`'s two Linux Gradle jobs at 30, and `test-suite.yml`'s
  `affected-scope` and `lint` at 10). Hosted runners never enter the
  self-hosted queue, so the fragility above does not apply and their values can
  track observed runtime. The last two came down from the 90-minute heavy-suite
  ceiling when they were pinned to hosted (#2236); at 6 s and 18 s measured, ten
  minutes is a hang guard rather than a capacity budget.
- `required-ci` and `test-packages-result`, which only read `needs.*.result`.
  Both finish in seconds, so failing fast is correct for a job that just
  reports other jobs' results.
- Publish Dry Run's `publish-dry-run-summary`, which only downloads and verifies
  artifacts before reporting upstream results. It runs on GitHub-hosted capacity
  with a ten-minute hang guard and skips cancelled workflows. Keeping it off the
  metal lane is required: an `always()` metal summary can be newly queued after
  an invalidated merge group is cancelled, preventing the run from becoming
  terminal and making queue-idle checks report phantom work.

`postgres-tests` remains at 45 as a deliberate exception. #2164 retired the unserved
`arc-happyvertical-node` label, deleted the `node-runner-smoke` workflow that
ran only there, and moved this job onto the general `arc-happyvertical` pool —
the pool the 45 was measured on — so the standard applies to it for the same
reason it applies to every other job there. Its earlier 30 was inherited from a
label whose scale set was quiesced to zero runners, where `timeout-minutes`
never governed anything.

`publish-release` is at the standalone 45-minute standard, but that value is
load-bearing independently of it: 45 is the documented sequential-registry
recovery window below, and `scripts/publish-workflow-policy.test.mjs` asserts
the exact number. Changing the heavy-suite ceiling does not by itself license
moving that job.

Two related constraints are deliberately not per-job settings:

- Several GitHub-hosted jobs set no `timeout-minutes` at all and inherit
  GitHub's 360-minute default. That is a separate gap from this standard; it is
  not a licence to leave a self-hosted job uncapped.
- A merge queue configured with a 60-minute timeout measures wall time, which
  includes queue wait; a chain of self-hosted jobs can exceed it. Tune the queue
  timeout at the queue, not by shrinking job ceilings back toward the queue
  wait.

`agent-policy.yml` is synced from the shared policy source rather than authored
here; its timeout belongs to the policy control plane, so it is not changed in
this repository.

## Pull requests and merge groups

`CI_MERGE_QUEUE_ENABLED` selects which validation shape a pull request gets. It
is `true` on this repository; the unset/false branch is retained only as a
reversal lever.

- Unset/false: PRs run the historical full suite.
- `true`: PRs run lint and typecheck across the changed packages and everything
  that depends on them. Their selected test-task closure is split into three
  deterministic non-core shards; when Turbo's selected test-task closure also
  contains core, the existing three Vitest core shards run. The selectors read
  Turbo's dry-run task list, log selected/total package counts, and emit each
  selected non-core test task exactly once, so wide core closures use the full
  suite's parallel shape without silently changing coverage. The core and
  package matrices deliberately do not overlap: each permits two runners, and
  a shared four-runner burst would transfer feedback latency to fleet queue
  pressure. Only when knowledge-sensitive paths change do PRs also run
  affected knowledge freshness. The complete suite runs for `merge_group`.

Coverage Gate and Publish Dry Run are merge-group only (#2214 items 4 and 8).
Both used to run in both lanes while the merge group re-ran them in full
regardless, so the PR copies were duplicate fleet occupancy rather than the
binding gate — and Coverage Gate additionally paid a cold full build on PRs,
because the seed `build` job is full-mode only. Neither loses meaning in the
merge group: `check-coverage.mjs` resolves its diff base as `BASE_REF || 'main'`
plus `merge-base`, which is correct for the synthetic merge-group head. The
trade is that a coverage or packaging regression now ejects from the queue
instead of reddening the PR; authors can pre-check coverage locally with
`node scripts/check-coverage.mjs --packages <list>`.

Publish Dry Run's gate lives inside `publish-dry-run.yml`, not on its caller.
Every reusable or self-hosted job in `on-pull-request.yml` must carry the
canonical trusted-base admission expression byte-for-byte, so narrowing a lane
from the caller's `if:` is not available — gate the called workflow instead.

Both gates key off `CI_MERGE_QUEUE_ENABLED`, not off the event alone, because
clearing that variable is the documented rollback lever and it stops GitHub
producing `merge_group` events at all. Coverage Gate gets this for free: the
caller's `mode` expression falls back to `full` on the same lever, so it runs on
PRs again. Publish Dry Run tests the lever explicitly — without it, a rollback
would leave packaging unvalidated all the way into `publish.yml`, since
`on-merge-main.yml` runs test and build but never a pack validation.

No lane in `on-pull-request.yml` or `test-suite.yml` runs PostgreSQL in either
mode; PostgreSQL lives only in `postgres-tests.yml`, described below.

`Required CI` is the sole required repository-validation status. Seven jobs must
succeed for both PR and merge-group events; Publish Dry Run is required only for
`merge_group`, where it runs. The aggregator still fails if it reports anything
other than `skipped` or `success` on a PR, so re-enabling it there cannot
silently leave it un-gated.

Rollout status:

1. Done. The `arc-happyvertical` broker landed in #2124, and every self-hosted
   job selects it.
2. Pending. `CI_POSTGRES_ENABLED` is still unset, so the scheduled PostgreSQL
   lane stays skipped. Set it to `true` after a manual `postgres-tests.yml`
   dispatch passes on `arc-happyvertical`.
3. Done. `CI_MERGE_QUEUE_ENABLED` is `true`.
4. Done. The required status list is exactly `Required CI`.
5. Done. The repository merge queue uses squash merges, up to five entries
   building concurrently, one entry merged at a time, zero wait, all-green
   behavior, and a 60-minute timeout.

When merge queue mode is enabled, the main workflow skips duplicate tests and
the standalone build. The versioned release build, exact-artifact publication,
and documentation deployment remain on main.

## PostgreSQL isolation

Packages opt in with a `test:postgres` script. The wrapper obtains the
disposable URL from `CI_POSTGRES_BASE_URL` or the read-only file named by
`CI_POSTGRES_BASE_URL_FILE`, creates a uniquely named database, exports all
supported PostgreSQL test URL variables plus libpq's `PG*` connection
variables, including supported URI query parameters, and drops the database
afterward.

`postgres-tests.yml` runs on `arc-happyvertical` and supplies its own PostgreSQL
service container, passing `CI_POSTGRES_BASE_URL`. The general lane does not
mount the cluster-local URL that `CI_POSTGRES_BASE_URL_FILE` names, and its
runner image already provides the libpq client binaries the wrapper needs for
`createdb`/`dropdb`. The wrapper stays on its managed path, so each package
still gets its own database under `--concurrency=2`; no job depends on a
cluster-local credential, and there is no production database secret access.

There is no PR-triggered PostgreSQL lane. `postgres-tests.yml` triggers on
`workflow_call`, `workflow_dispatch`, and a nightly `schedule`, and its only
caller, `on-demand-validation.yml`, is dispatch-only. The scheduled run stays
skipped until the repository variable `CI_POSTGRES_ENABLED` is `true`, which it
currently is not. Manual dispatch bypasses that variable and remains available
for validation before the lane is required.

Interrupted jobs are cleaned hourly after six hours. Tests must never use a
fixed shared database name or remove the wrapper from their package script.

## Release artifacts

Routine releases are batched to avoid repeatedly invalidating merge-queue work.
Merging a pull request advances `main` once and does not invoke the publisher.
`.github/workflows/on-merge-main.yml` runs daily at 07:17 UTC and can also be
dispatched manually for an urgent release. Each run versions every eligible
commit since the previous release, so a group of merged pull requests produces
one release commit and tag. The workflow checks for active merge-group runs and
queue refs before starting and again before the irreversible registry and Git
release phase. An API error or non-idle queue fails closed and defers the
release. Once registry publication begins, the matching `main` and tag update
must complete so the registry and Git release cannot be stranded out of sync.
To publish a specific cohort immediately, let every pull request in the cohort
merge and the queue drain before dispatching `on-merge-main.yml`; do not enqueue
new work while that release is publishing.

Do not restore a `push` trigger on the batch workflow. A release commit changes
the base of every speculative merge-group branch; publishing after each merge
therefore cancels or restarts validation for entries still in the queue (#2174).

Each package is packed once. Pack shards verify that exact tarball and emit a
schema-versioned manifest containing package name, version, filename, and
SHA-256. Profiles and Sales validation additionally install each exact tarball
into an isolated consumer, run the built CLI to generate `.smrt/register.js`,
and import the generated file so every manifest-advertised root import is
proven against the publish artifact. The summary verifies complete package
membership and uniform versions.
The release job publishes those tarballs sequentially and safely skips versions
already present on npm during a retry. The final publisher consumes only those
prebuilt artifacts, so it skips a redundant workspace dependency install and
retains a 45-minute recovery window for sequential registry writes. Registry
reads prefer fresh metadata, and post-publish verification retries six times
with bounded exponential backoff so temporary npm propagation or stale negative
cache entries do not strand the release before its Git refs are written. After
creating the release commit and tag locally, it resets inherited Git
authentication, supplies the release App credential directly, and dry-runs the
exact atomic ref push before publication. The publisher checkout does not
persist its own credential, preventing duplicate `Authorization` headers when
ARC workspaces resolve through different paths. After publication, the release
commit and tag are pushed atomically, so GitHub cannot record only one ref.

If an interrupted run publishes only part of a lockstep version, a later main
commit must not fill in the remaining packages under that same version: the
artifacts would come from different source trees. Keep the npm collision guard,
apply the interrupted run's exact generated version patch to reserve that
version in Git, and let the next merge publish the complete package set at a new
version. The version patch is retained for 30 days so this recovery remains
available after the short-lived build and package artifacts expire.

Documentation installs as an isolated workspace under `docs/`. Its pnpm build
policy explicitly allows the `core-js` and `sharp` install scripts required by
the locked Docusaurus dependency graph; CI must not bypass or interactively
approve that policy.

The manual `publish-mode=changesets` option is a standing emergency fallback,
not a time-boxed one. Both trigger paths default to `artifacts` and
`on-merge-main.yml` never passes the input, so the fallback is reachable only
through manual dispatch. Its versioning half is not dormant: `prepare-release`
runs `changeset:auto` and `changeset:version` on every release regardless of
mode, so only the publication step differs between the two.

## Acceptance and rollback

Compare ten successful runs before and after each rollout step. Stop if setup
p95 exceeds 45 seconds, runner memory exceeds 8 GiB, required contexts vanish,
or retries/failures increase. Target setup p50 below 30 seconds, queue p95 below
two minutes, and at least 30% fewer self-hosted runner-minutes per PR.

Runner placement remains brokered through `arc-happyvertical`; change backing
capacity only in runner-pool policy, not workflow labels. Merge-queue rollout
can be reversed independently by clearing `CI_MERGE_QUEUE_ENABLED`, restoring
the previous required status list, and removing the merge-queue rule.
PostgreSQL is not part of the required aggregator, so toggling
`CI_POSTGRES_ENABLED` never alters SQLite coverage. The artifact publisher can
temporarily fall back to Changesets through manual dispatch.

The hosted Turbo cache lane has two independent clearable levers:
`CI_HOSTED_TURBO_CACHE_ENABLED` stops scheduled and push seeding (entries then
expire within seven days), and `CI_HOSTED_FALLBACK_ENABLED` returns
`test-suite.yml` to the self-hosted label. The per-call `turbo-cache-shim:
'off'` input disables the shim for a single caller.

The fallback lever has been rehearsed. With `CI_HOSTED_FALLBACK_ENABLED` set
to `true`, PR validation re-resolved every job from the self-hosted label to
`ubuntu-latest` and `Required CI` succeeded in 8.1 minutes of wall clock
([run 30969467329](https://github.com/happyvertical/smrt/actions/runs/30969467329)):

| job | hosted | ceiling (`timeout-minutes`) |
| --- | --- | --- |
| `publish-dry-run` prepare | 6.0 min | 45 |
| Coverage Gate | 5.8 min | 90 |
| `validate-publish-shards` (two) | 1.3 and 1.4 min | 45 |
| Affected build, typecheck, tests | 1.1 min | 90 |
| Lint | 0.3 min | 10 |
| `Detect Affected Validation Scope` | 0.1 min | 10 |

Nothing approached a ceiling, and these are cold numbers: PR validation runs
on `pull_request_target`, where the Turbo shim is refused, so no job restored
from the hosted cache pool. The last two rows carry their post-#2236 ceilings;
they were at the 90-minute heavy-suite ceiling when the rehearsal ran.

Two limits on what that rehearsal proves. It exercised the pull-request path
in `affected` mode, not a `merge_group` run in `full` mode, so the six
`test-core` and `test-packages` shards remain unmeasured on hosted. And the
lever is repository-wide: flipping it moves every open pull request, not only
the one being tested. Re-measure with a full merge-group transit before
treating hosted as an equivalent lane rather than an emergency one.

### Phase 0 hosted pinning (#2236)

Those rehearsal numbers are the baseline for pinning `affected-scope`, `lint`,
and `test-packages-result` to hosted permanently (Runner selection, above).
The rehearsal measured them as a *fallback*; the pinning makes the same
placement the steady state, so the per-job durations should reproduce and are
not the interesting result.

The interesting result is the second-order one: three jobs per validation pass
stop taking a slot on an 8-slot fleet, which should show up as reduced queue
wait for the heavy shards rather than as faster light jobs. Record after
merge, comparing ten runs either side:

| measure | before | after |
| --- | --- | --- |
| `Lint` duration | 0.3 min hosted (rehearsal) / fleet baseline TBD | |
| `Detect Affected Validation Scope` duration | 0.1 min hosted (rehearsal) / fleet baseline TBD | |
| `test-packages-result` duration | fleet baseline TBD | |
| `test-core` shard queue wait (p50/p95) | | |
| `test-packages` shard queue wait (p50/p95) | | |
| `Required CI` wall clock, `merge_group` | | |

Queue wait is the gap between a job's `createdAt` and `startedAt`, which
`timeout-minutes` never governs — see Job timeouts. If the heavy shards' wait
does not improve, the freed slots were not the binding constraint and the
capacity oracle in phases 1-2 of happyvertical/iac#1349 is the next lever, not
a wider pinning. Rollback is per-job and independent: restore the lever
expression and the 90-minute heavy-suite ceiling on any job that regresses.
