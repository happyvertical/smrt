# Continuous integration architecture

SMRT uses hosted runners for static checks and HappyVertical ARC runners for
builds and tests. The internal Turborepo server is the build-output cache;
GitHub Actions cache archives are deliberately not used for `.turbo/cache`.
If the remote cache is unavailable, Turbo performs a cold build.

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

- `arc-happyvertical-node` is the normal Node.js runner. It has exact Node and
  pnpm versions, native build dependencies, and a PostgreSQL client. It has no
  Docker daemon or privileged sidecar.
- `arc-happyvertical` is the compatibility runner for workflows that require
  Docker or deployment tooling.
- SMRT jobs select the node runner when the repository variable
  `CI_NODE_RUNNER_ENABLED` is `true`; otherwise they use the compatibility
  runner. PostgreSQL shadow validation always targets the node runner.

The pnpm store and runner workspace must remain on the same node-local
filesystem so pnpm can hardlink packages. Do not restore the RAM-backed split
mounts without measuring runner memory and install latency. The shared setup
action also points `TMPDIR` at the workspace-backed runner temp directory so
SQLite fixtures and other temporary test files bypass the container overlay
filesystem. ARC runners can provide `CI_TEST_TMPDIR` to route those files to a
bounded, test-only tmpfs; other runners retain the workspace-backed fallback.

## Pull requests and merge groups

`CI_MERGE_QUEUE_ENABLED` controls the staged rollout:

- Unset/false: PRs run the historical full suite and publish dry-run. This
  preserves the existing required status contexts during observation.
- `true`: PRs run affected build, typecheck, tests, touched coverage, relevant
  knowledge checks, and affected PostgreSQL coverage. The complete suite and
  publish dry-run run for `merge_group`.

`Required CI` is the eventual sole required status. Its aggregator explicitly
checks different expected job sets for PR and merge-group events. Do not change
the ruleset until this context has completed successfully on ten representative
PR runs.

After those runs:

1. Set `CI_NODE_RUNNER_ENABLED=true` and verify one non-required/shadow run.
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
SHA-256. The summary verifies complete package membership and uniform versions.
The release job publishes those tarballs sequentially and safely skips versions
already present on npm during a retry.

The manual `publish-mode=changesets` option is an emergency fallback for the
first two successful artifact-based releases. Remove the option after both
releases complete and downstream consumers install the published packages.

## Acceptance and rollback

Compare ten successful runs before and after each rollout step. Stop if setup
p95 exceeds 45 seconds, runner memory exceeds 8 GiB, required contexts vanish,
or retries/failures increase. Target setup p50 below 30 seconds, queue p95 below
two minutes, and at least 30% fewer self-hosted runner-minutes per PR.

Rollback by clearing the three repository variables, restoring the previous
required status list, and removing the merge-queue rule. PostgreSQL can be
removed from the required aggregator without altering SQLite coverage. The
artifact publisher can temporarily fall back to Changesets through manual
dispatch.
