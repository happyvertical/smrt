# Continuous integration architecture

SMRT uses hosted runners for lightweight static and control-plane checks and
the shared `arc-happyvertical-nodocker` broker lane for general builds, tests,
and publishing. The
internal Turborepo server is the build-output cache; GitHub Actions cache
archives are deliberately not used for `.turbo/cache`. If the remote cache is
unavailable, Turbo performs a cold build.

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
  GitHub-hosted when they do not benefit from a self-hosted cache. Aggregation
  is not uniform: `required-ci` is hosted, but `test-packages-result` runs on
  `arc-happyvertical-nodocker` even though it only reads `needs.*.result`. It
  is capped at the standard rather than moved, because it backs a required
  status.

The PR caller uses `pull_request_target`, so GitHub loads runner selection from
the trusted base branch rather than contributor-controlled merge YAML. It passes
a PR head SHA to reusable general-CI workflows only when the head repository
equals `github.repository`; merge-group and trusted push workflows use the
broker normally. External fork PRs keep a base-revision hosted control-plane
check, while the self-hosted validation and publish-dry-run calls are skipped
and `Required CI` rejects the run. Broker admission must also deny those fork
events before making a reservation.

`CI_NODE_RUNNER_ENABLED` is gone from this tree — nothing reads it, and the
migration it was conditioned on is live. If the repository still defines the
variable it is inert and can be deleted.

The pnpm store and runner workspace must remain on the same node-local
filesystem so pnpm can hardlink packages. Do not restore RAM-backed split
mounts without measuring runner memory and install latency. The shared setup
action also points `TMPDIR` at the workspace-backed runner temp directory so
SQLite fixtures and other temporary test files bypass the container overlay
filesystem. Self-hosted runners can provide `CI_TEST_TMPDIR` to route those
files to a bounded, test-only tmpfs; other runners retain the workspace-backed
fallback.

## Job timeouts

Validation jobs on the self-hosted lanes use `timeout-minutes: 45`. The value
is a standard, not a per-job estimate: the previous spread ran from 5 to 45,
mostly unexplained, and the low end was close to the pool's own queue wait
(p90 1483-1933s measured over 180 jobs, against a median execution of 39-50s).
A ceiling near that scale is fragile — it leaves nothing for a cold Turbo cache
or a slow checkout, and it invites cancelling healthy work.

`timeout-minutes` is measured from the moment a job starts executing, not from
when it is queued, so this ceiling does not govern queue wait and raising it
does not fix a job that is requeued while waiting. That behaviour is tracked
separately in happyvertical/iac#1282. Do not treat a change here as a fix for
requeueing.

These jobs deliberately sit below the standard, with the reason recorded next
to the setting or here:

- GitHub-hosted jobs that set a timeout (`dependency-audit` at 10,
  `mobile.yml`'s two Linux Gradle jobs at 30). Hosted runners never enter the
  self-hosted queue, so the fragility above does not apply and their values can
  track observed runtime.
- `required-ci`, which only reads `needs.*.result`. It finishes in seconds, so
  failing fast is correct for a job that just reports other jobs' results.

`postgres-tests` is at the standard 45. #2164 retired the unserved
`arc-happyvertical-node` label, deleted the `node-runner-smoke` workflow that
ran only there, and moved this job onto the general `arc-happyvertical` pool —
the pool the 45 was measured on — so the standard applies to it for the same
reason it applies to every other job there. Its earlier 30 was inherited from a
label whose scale set was quiesced to zero runners, where `timeout-minutes`
never governed anything.

`publish-release` is at the standard 45 but that value is load-bearing
independently of it: 45 is the documented sequential-registry recovery window
below, and `scripts/publish-workflow-policy.test.mjs` asserts the exact number.
Moving the standard later does not by itself license moving that job.

Two related constraints are deliberately not per-job settings:

- Several GitHub-hosted jobs set no `timeout-minutes` at all and inherit
  GitHub's 360-minute default. That is a separate gap from this standard; it is
  not a licence to leave a self-hosted job uncapped.
- A merge queue configured with a 60-minute timeout measures wall time, which
  includes queue wait; a chain of 45-minute jobs can exceed it. Tune the queue
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
- `true`: PRs run lint, affected typecheck and tests across the changed
  packages and everything that depends on them, touched coverage, and — only
  when knowledge-sensitive paths change — affected knowledge freshness. The
  complete suite runs for `merge_group`.

Publish dry-run sits outside that split: it runs for same-repository PRs and for
`merge_group` in both modes. No lane in `on-pull-request.yml` or
`test-suite.yml` runs PostgreSQL in either mode; PostgreSQL lives only in
`postgres-tests.yml`, described below.

`Required CI` is the sole required repository-validation status. Its aggregator
requires the same eight jobs to succeed for both PR and merge-group events; what
differs between the two is the mode `test-suite.yml` runs in, not the set of
jobs the aggregator checks.

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
