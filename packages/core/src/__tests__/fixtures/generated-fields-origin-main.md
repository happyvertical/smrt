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

## Recapture at the merge into the data-shape release (#4920)

#4972 landed on `main` while the data-shape release branch was open. That branch
changes plain-model output on purpose: the generated SvelteKit registration
imports the build schema (#4929), a shared-table subclass gets a PostgreSQL
`CHECK` (#4932), and manifests record stated options (#4942). The baseline for
"#4972 changes nothing for a model without calculated fields" is therefore the
branch just before the merge, `0f16192e1b3b5d64b639cce688aaa35075a71464`.

The fixture was recaptured with the same gate: production sources under
`packages/core/src` (and the excluded test helpers) restored from that commit,
`SMRT_CAPTURE_ORIGIN_MAIN` set to it, then the merged sources restored and the
comparison run again without updating. Seven digests changed, each one listed
above as a branch change; the SQLite deployment SQL did not. The gate now also
excludes `packages/core/src/__tests__/**` (the fixture's own folder), which the
`**/__tests__/**` pattern did not match at that depth, so recapture was
impossible once the fixture existed. The file name keeps `origin-main` so the
history stays easy to follow.

## Digest updates for intended changes to generated source

The comparison still pins every artifact. When a change is meant to alter
emitted source, the digests of exactly the files it alters are replaced by
hand with the new values, and the change is listed here. Manifest, schema,
DDL, migration and OpenAPI digests have not moved since the recapture above.

- Generated list routes (`compat_plain/+server.ts`, `compatroots/+server.ts`):
  the list and count handlers answer a where clause the collection refuses
  with its 400 status.
- Generated write paths (both MCP servers `single/index.ts` and
  `modular/handlers/index.ts`, the list and item routes of each model, and
  `sync/apply/+server.ts`): each writable policy asks
  `ObjectRegistry.isServiceOptionInput()` which body keys are fields.
- Generated read routes (the list and item routes of each model:
  `compat_plain/+server.ts`, `compat_plain/[id]/+server.ts`,
  `compatroots/+server.ts`, `compatroots/[id]/+server.ts`): every list,
  count and point read resolves its tenant read scope at request time with
  `resolveAnonymousTenantReadScope()`, for every model, since tenancy can be
  registered at runtime.
- Generated update paths and output (both MCP servers `single/index.ts` and
  `modular/handlers/index.ts`, the list and item routes of each model, and
  `sync/apply/+server.ts`): an update is assigned with `applyUpdateInput()`,
  and items are serialised through `toPublicJSONValue()` /
  `publicSerializerOf()`.
- Generated list paths (both MCP servers `single/index.ts` and
  `modular/handlers/index.ts`, and the list route of each model): the caller's
  filter and ordering pass `assertQueryAccess()` first, and the list route
  answers any typed 4xx refusal of the query with its status.
- Generated MCP tools (`single/index.ts`, `modular/handlers/index.ts`): the
  get, update, delete and item-action cases read `id` / `slug` through
  `requireIdentifierArgument()` / `identifierArgument()`.
- Generated sync route (`sync/apply/+server.ts`): each target carries
  `tenantScoped` and `principalContext`. Its write policy is no longer baked
  into the target table: payloads pass `prepareWriteInput()` (#5195).
- Generated create paths (both MCP servers `single/index.ts` and
  `modular/handlers/index.ts`, and the list route of each model): a create
  target selected through an STI base passes `assertCreateTargetSurface()`.
- Generated MCP error results (`single/index.ts`, `modular/handlers/index.ts`):
  a `TENANT_ISOLATION_VIOLATION` with no public message of its own is
  reported as `permission_denied` / "Permission denied.".
- Round-2 request-path checks (both MCP servers, the list and item routes of
  each model, and `sync/apply/+server.ts`): create input passes
  `assertCreateInput()`; routes authenticate before the exposure gate and read
  the request tenant from every \`locals\` source; item-route lookups map
  typed refusals; the sync route checks exposure in \`run\`, update payloads
  with \`assertUpdateInput()\` and super-admin bypass per target.
- Protected-field writes (#5195; the list and item routes of each model and
  `sync/apply/+server.ts`): the emitted `applyWritablePolicy` helper is gone.
  Create and update bodies pass `prepareWriteInput()` from core, which refuses
  a changed protected field with `VALIDATION_FIELD_NOT_WRITABLE`; the item
  route builds the body after loading the row. MCP sources are unchanged.
