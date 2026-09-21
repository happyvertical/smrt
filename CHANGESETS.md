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

## npm authentication

The final `Publish Release` job publishes by npm
[trusted publishing](https://docs.npmjs.com/trusted-publishers) (GitHub OIDC),
not a stored write token: a 90-day granular `NPM_TOKEN` expired on 2026-09-21
and stopped every release with a misleading `E404` on the first package
(#2998). Three constraints follow.

- Each package's trusted publisher on npmjs names `happyvertical/smrt` and
  `on-merge-main.yml`. npm validates the *calling* workflow, so dispatching
  `publish.yml` directly cannot publish unless it is registered as a second
  publisher.
- npm accepts OIDC only from GitHub-hosted runners, so that one job is pinned
  to `ubuntu-latest` while the other release jobs keep the ARC pool.
  `scripts/check-trusted-publish-preflight.mjs` fails the job before anything
  irreversible when the runner, OIDC endpoint, or npm version is wrong, or
  when npm refuses the trusted-publisher exchange for any package in the batch.
- A trusted publisher can only be added to a package that already exists. A
  **new** publishable package needs one manual first publish by an org owner,
  then its trusted publisher, before its first batched release — alongside
  adding it to the fixed group in `.changeset/config.json`.

Only the emergency `changesets` publish mode still receives `NPM_TOKEN`, and
it works only while that secret holds a live write token: deleting or letting
it expire disarms the fallback, which the job reports before publishing.

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
