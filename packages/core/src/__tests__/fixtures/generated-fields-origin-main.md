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
- List query grammar (#5439): the same two list routes read their filter with
  `parseRestListWhere(searchParams, model)` inside the typed-400 guard, so a
  repeated query parameter is refused and boolean/datetime values are decoded
  against the model's fields; the list route's refusal body keeps the
  normalized error code.
- Generated write paths (both MCP servers `single/index.ts` and
  `modular/handlers/index.ts`, the list and item routes of each model, and
  `sync/apply/+server.ts`): each writable policy asks
  `ObjectRegistry.isServiceOptionInput()` which body keys are fields.
- Generated read routes (the list and item routes of each model:
  `compat_plain/+server.ts`, `compat_plain/[id]/+server.ts`,
  `compatroots/+server.ts`, `compatroots/[id]/+server.ts`): every list,
  count and point read resolves its tenant read scope at request time with
  `resolveAnonymousTenantReadScope()`, for every model, since tenancy can be
  registered at runtime. The same four files then also enter the caller's
  tenant through core's request hooks when the model is tenant-scoped at
  request time, and choose the read cache policy and ETag tenant
  discriminator at request time.
- Request-path checks (#5164): both MCP servers (`single/index.ts`,
  `modular/handlers/index.ts`), the list and item routes of each model, and
  `sync/apply/+server.ts` apply the update-input, filter and tenant write gate
  rules (an update assigns declared fields only, a list filter names readable
  fields, a write to a tenant-scoped model needs a tenant, a create through a
  base selects only subtypes open on the transport).
- Sync tenant (#5164): `sync/apply/+server.ts` enters the caller's tenant for
  a model whose tenancy is registered at runtime, as the CRUD routes do.
- Ambient request tenant (#5164): the list and item routes of each model and
  `sync/apply/+server.ts` read the request's tenant for the runtime exposure
  gate from `locals`, else from the tenant context already active for the
  request.
- Request tenancy (#5375): the list and item routes of each model and
  `sync/apply/+server.ts` resolve the request's tenancy through core
  (`enterRequestTenancy`) for every model, with no generation-time tenancy
  switch, and read the cache policy and validator from the bound tenancy.
- MCP request tenancy (#5375): both MCP servers (`single/index.ts`,
  `modular/handlers/index.ts`) run each tool inside the tenancy resolved for
  its model at call time.
- Sync create type (#5375): `sync/apply/+server.ts` rejects a create whose
  payload selects a type its STI target does not write.
- MCP served models (#5375): both MCP servers (`single/index.ts`,
  `modular/handlers/index.ts`) pass the models they serve to each tool's
  request tenancy, so a family member outside them is not served through its
  base.
- MCP tenancy at call time (#5375): both MCP servers (`single/index.ts`,
  `modular/handlers/index.ts`) turn the installed tenancy layer on when a
  tool's model is tenant-scoped at call time.
- Emitted family members (#5375): the list and item routes of an STI model
  with members, and `sync/apply/+server.ts` of a manifest with an STI family,
  pass the family members (sync: the models) the manifest generates to the
  request tenancy, so a member registered elsewhere is not served through its
  base (sti case only; the plain case has no family and is unchanged).
- Protected-field writes (#5195; the list and item routes of each model and
  `sync/apply/+server.ts`): the emitted `applyWritablePolicy` helper is gone.
  Create and update bodies pass `prepareWriteInput()` from core, which refuses
  a changed protected field with `VALIDATION_FIELD_NOT_WRITABLE`; the item
  route builds the body after loading the row.
- Protected-field writes through MCP (#5195; both MCP servers
  `single/index.ts` and `modular/handlers/index.ts`): the emitted
  `applyWritablePolicy` helper is gone. Create and update arguments pass
  `prepareWriteInput()` from core; an update compares them with the loaded row.
- Protected fields the caller cannot read (#5195): the emitted item route,
  the emitted sync route and both emitted MCP servers pass the caller's read
  permissions (`locals`, `PUBLIC_JSON_OPTIONS`) to `prepareWriteInput()`, which
  refuses such a field whatever its value instead of comparing it.
- Shared route decision (#5195; the list and item routes of each model,
  `sync/apply/+server.ts`, `_changes/+server.ts`, `_events/+server.ts`): the
  emitted guard copies are gone. Handlers call `requireRouteAccess` and
  `requireRouteBody`, which ask `authorize` from core for sign-in, the
  `<collection>.<action>` permission and the tenant a write body names; reads
  drop tenant filters with `stripTenantFilters`. A create that selects an STI
  subtype and an update or delete of a subtype's row decide under the subtype's
  policy (`modelDecision`, `FAMILY_POLICY`). The feed routes ask `authorize` on
  the `_feed` collection, and `_events` takes its CORS from the shared policy
  (`applyRouteCors`) instead of its own helpers. Manifest, schema, DDL,
  migration and OpenAPI digests are unchanged; only the emitted route digests
  moved.

## Re-baseline of the emitted routes for #5195

`sourceRevision` (and `BASELINE` in the test) is now
`45e9002f44c2e6207b59e6efd8c9f33310462cc2`, the commit whose production sources
under `packages/core/src` produced the current digests, so the capture gate
(`SMRT_CAPTURE_ORIGIN_MAIN`, a clean `git diff` of production sources against
that commit) applies to it. The digests were not recaptured from a pre-#5195
tree: the #5195 route templates change the emitted SvelteKit routes on purpose,
and the digests of exactly those files were replaced (the entry above lists
the change). Compared with the fixture on `release/5195-auth-contract` before
this change, only `source/sveltekit/**` digests moved (five per case: the list
and item routes, `sync/apply`, `_changes`, `_events`). The manifest, schema,
registry schema, OpenAPI, DDL (`ddl/*`), migration and `source/single/**` /
`source/modular/**` digests, and the SQLite deployment SQL, are identical to
the #4972 baseline `0f16192e1b3b5d64b639cce688aaa35075a71464`.

Re-baselined again for the typecheck fix of the emitted denials (#5195): the
`source/sveltekit/**` digests moved (list, item, `sync/apply`, `_changes`,
`_events` routes of both cases) because denial bodies are built as a variable
before `error()`. Every other digest is unchanged, and the revision above is the
commit whose production sources produced them.
- Route limits (#5198; every emitted route file): each handler, and the feed
  and sync routes, begins with `routeRateLimit(locals, request, getClientAddress)`, which calls
  `enforceRouteLimits` from core and returns its 429 (`Retry-After`) before any
  decision; with no limits configured it admits. The digests of the emitted
  routes were re-baselined by hand for this one addition; nothing else moved.
- Request metering (#5199; every emitted route file): each method handler is
  renamed `<METHOD>Metered` and re-exported behind `withRouteMetering`
  (`vite-plugin/route-metering.ts`, applied inside the CORS wrapper), which
  reports the response status and the decided principal to core's meter sink
  after the handler decided. The digests of the emitted routes were
  re-baselined by hand for that wrapper; nothing else moved.
