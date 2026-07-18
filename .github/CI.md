# Continuous integration architecture

SMRT uses hosted runners for lightweight static and control-plane checks and
the shared `ci-linux-x64` pool for general builds, tests, and publishing. The
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

- `ci-linux-x64` is the default selector for general Linux work. It combines
  ARC capacity with allowlisted PXE hosts using one workflow-facing label.
- `arc-happyvertical-node` is reserved for the runner-image smoke test and
  PostgreSQL shadow validation. Those jobs depend on its cluster-local database
  URL mount and intentionally do not join the general pool.
- Lightweight lifecycle, policy, aggregation, stale-management, and mobile
  jobs remain GitHub-hosted when they do not benefit from a self-hosted cache.

The retired `CI_NODE_RUNNER_ENABLED` switch no longer controls job placement
and can be removed from the repository after this workflow migration is live.

The pnpm store and runner workspace must remain on the same node-local
filesystem so pnpm can hardlink packages. Do not restore RAM-backed split
mounts without measuring runner memory and install latency. The shared setup
action also points `TMPDIR` at the workspace-backed runner temp directory so
SQLite fixtures and other temporary test files bypass the container overlay
filesystem. Self-hosted runners can provide `CI_TEST_TMPDIR` to route those
files to a bounded, test-only tmpfs; other runners retain the workspace-backed
fallback.

## Pull requests and merge groups

`CI_MERGE_QUEUE_ENABLED` controls the staged rollout:

- Unset/false: PRs run the historical full suite and publish dry-run. This
  preserves the existing required status contexts during observation.
- `true`: PRs run affected build, typecheck, tests, touched coverage, relevant
  knowledge checks, and affected PostgreSQL coverage. The complete suite and
  publish dry-run run for `merge_group`.

`Required CI` is the sole required repository-validation status. Its aggregator
explicitly checks different expected job sets for PR and merge-group events. Do
not change the ruleset until this context has completed successfully on a
representative code-changing PR run.

After that canary run:

1. Verify the `ci-linux-x64` ARC/PXE canary and one representative SMRT run.
2. Set `CI_POSTGRES_ENABLED=true` after the disposable cluster and runner URL
   mount pass the manual shadow workflow.
3. Set `CI_MERGE_QUEUE_ENABLED=true`.
4. Replace the existing required status list with `Required CI`.
5. Add a repository merge queue using merge commits, concurrency one, group
   size one, zero wait, all-green behavior, and a 60-minute timeout.

When merge queue mode is enabled, the main workflow skips duplicate tests and
the standalone build. The versioned release build, exact-artifact publication,
and documentation deployment remain on main.

## PostgreSQL isolation

Packages opt in with a `test:postgres` script. The wrapper obtains the
disposable URL from `CI_POSTGRES_BASE_URL` or the read-only file named by
`CI_POSTGRES_BASE_URL_FILE`, creates a uniquely named database, exports all
supported PostgreSQL test URL variables plus libpq's `PG*` connection
variables, including supported URI query parameters, and drops the database
afterward. IAC
stores the same credential in SOPS-encrypted Secrets in the database and runner
namespaces; the node runner mounts only the URL copy. It has no production
database secret access.

Scheduled and PR PostgreSQL lanes remain skipped until the repository variable
`CI_POSTGRES_ENABLED` is `true`. Manual dispatch remains available for shadow
validation before the lane is required.

Rotate both encrypted copies in one IAC commit, reconcile the database Secret
first, and wait for CloudNativePG to report the managed role reconciled before
restarting the node runner scale set. Existing jobs keep their mounted Secret;
new jobs receive the rotated URL.

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

The manual `publish-mode=changesets` option is an emergency fallback for the
first two successful artifact-based releases. Remove the option after both
releases complete and downstream consumers install the published packages.

## Acceptance and rollback

Compare ten successful runs before and after each rollout step. Stop if setup
p95 exceeds 45 seconds, runner memory exceeds 8 GiB, required contexts vanish,
or retries/failures increase. Target setup p50 below 30 seconds, queue p95 below
two minutes, and at least 30% fewer self-hosted runner-minutes per PR.

Rollback runner placement by restoring general jobs to
`arc-happyvertical-node`. Merge-queue rollout can be reversed independently by
clearing `CI_MERGE_QUEUE_ENABLED`, restoring the previous required status list,
and removing the merge-queue rule. PostgreSQL can be removed from the required
aggregator without altering SQLite coverage. The artifact publisher can
temporarily fall back to Changesets through manual dispatch.
