# Generated-field compatibility baseline

`generated-fields-origin-main.json` was captured from the production TypeScript
sources at local `origin/main`, commit
`b16fc4c9075e50a6410a6039e1df295a42473c26`, before applying #4915. The capture
ran `generated-fields-compatibility.test.ts` with those sources restored from
Git, then restored the working sources. A second run against that same baseline
passed without updating the expectations.

The JSON stores SHA-256 digests of exact, unnormalized output bytes and the
SQLite DDL used to represent an existing pre-PR deployment. Coverage includes a
plain runtime model and a three-level STI hierarchy with a required, unique
field declared on its middle class. The comparison includes runtime manifest,
registry/schema-generator definitions, SQLite/PostgreSQL/DuckDB DDL, live
migration diff against the baseline deployment, full OpenAPI, monolithic and
modular MCP source, and all emitted SvelteKit TypeScript source.

Digests keep this fixture small without weakening byte equality. Do not update
it from the feature branch to accept changed output. The capture-only variable
`SMRT_CAPTURE_ORIGIN_MAIN` must name the pinned baseline revision; ordinary test
runs read the checked-in expectations and never write them.

Capture is gated by `git diff --quiet` against the source revision above for
all production files under `packages/core/src` (including added/deleted files;
tests, fixtures and testing helpers are excluded). The test checks the worktree,
not the branch name or HEAD, so restoring the actual baseline sources is
required before setting `SMRT_CAPTURE_ORIGIN_MAIN` to that SHA. Git failures
also refuse capture. The flag is checked before any fixture write.

The original capture executed `generated-fields-compatibility.test.ts` with
`SMRT_CAPTURE_ORIGIN_MAIN=b16fc4c9075e50a6410a6039e1df295a42473c26` after
restoring production sources with `git show` from that commit, then reran the
comparison without updating expectations. The digest representation and values
remain unchanged in round 3; provenance enforcement does not recapture them.
