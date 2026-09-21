# Versioning and releases

SMRT uses Changesets to version the fixed package group declared in
[.changeset/config.json](.changeset/config.json). Release automation owns
changeset generation, versioning, and publishing; contributors must not create
or edit changeset files manually.

## Release timing

Merges accumulate into a release batch. [Batched Release](.github/workflows/on-merge-main.yml)
runs daily at 07:17 UTC or by manual dispatch for an urgent release; merging a
PR does not itself trigger publication. The batch defers while merge groups
are active to avoid invalidating speculative merge-queue work.

The batch delegates to [Publish](.github/workflows/publish.yml). It runs the
fallback test/build jobs when merge-queue validation is disabled. Publish
prepares versioned artifacts, validates the release package set, publishes it,
and updates release refs and the GitHub release. Consult those workflows for
current gates, publishing modes, and documentation-deployment conditions.

## Where releases go

A release is published to **our own registry, `https://npm.happyvertical.com/`**,
and recorded against it; npmjs is a mirror. On 2026-09-21 the npmjs token
expired and npm then placed a 72-hour security hold on the one account that
owns the scope, so no release could ship and nothing in our control could
shorten it (#2998, #3002). Publishing no longer depends on npmjs; building a
release still reads third-party dependencies from it. Four rules follow.

- The primary is the literal `RELEASE_PRIMARY_REGISTRY` in `publish.yml`, and
  `scripts/release-registry.mjs` refuses any host outside its
  `ALLOWED_PRIMARY_HOSTS`. It is deliberately **not** a repository variable:
  the publish token is written for and sent to that host, so changing it must
  be a reviewed change. `Publish Release` authenticates with
  `NPM_HAPPYVERTICAL_PUBLISH_TOKEN` and proves it with `npm whoami` before
  anything irreversible.
- **Every npm call that names a registry must use `registryArgs()`** from
  `scripts/release-registry.mjs`, which passes `--registry` *and*
  `--@happyvertical:registry=`. `--registry` alone is not enough: this repo's
  `.npmrc` and every package's `publishConfig.registry` point the scope at
  npmjs, and npm lets those override `--registry`, so the publish would go to
  npmjs while reporting success. Only the scope flag on the command line
  outranks them.
- `Mirror Release to npmjs` is a separate, best-effort job. It downloads each
  tarball **from the primary** and publishes that exact file, because consumer
  lockfiles pin a tarball integrity hash and a rebuilt tarball would not match.
  It is forward-only (versions newer than npmjs's newest), runs even when no
  release was cut, and never fails the workflow, so a missed mirror is repaired
  by the next batch without a version bump. A version npmjs permanently
  refuses (published there before and removed) is recorded as skipped and does
  not hold back later versions. If the release version exists on both
  registries with different checksums it is reported as `DIVERGED`; that
  cannot be reconciled and needs a new version. `MIRROR_BACKFILL=true` fills
  older gaps deliberately; `MIRROR_STRICT=true` makes a manual repair run fail
  loudly.
- The emergency `changesets` publish mode still publishes straight to npmjs
  with `NPM_TOKEN`. The primary proxies npmjs for the scope, so versions
  published that way remain installable from it.

Consumers point the scope at the primary with one line and need no token:

```ini
@happyvertical:registry=https://npm.happyvertical.com/
```

## Contributor input

Use conventional commits and a clear PR description. The
[auto-changeset script](scripts/auto-changeset.ts) reads commits since the latest
release tag and uses core as the representative package for the fixed group.

While versions remain pre-1.0:

- Breaking changes (`!` or `BREAKING CHANGE`) produce a minor bump.
- Other releasable commits, including non-conventional fallback subjects,
  produce a patch bump.
- Releases must stay below 1.0.0; the workflow guards/corrects versioning.

A manually added changeset causes the generator to skip automatic generation.
Put changelog detail in the PR/commits instead. Do not run create/version/publish
commands as contribution-preparation steps; follow [WORKFLOW.md](WORKFLOW.md).

For a read-only version-policy check:

```bash
node scripts/check-version-limit.js
```

## Diagnosing a missing release

Check whether a scheduled/manual batch has run and whether the merge queue
allowed it to proceed. Then inspect the workflow's validation, artifact, and
publishing logs. The generator needs releasable commits after the last tag;
existing changeset files suppress generation. A merged PR alone does not
promise an immediate new version, npm publication, or tag.
