# Runtime-profile reference workload fixture

This directory is test-only. `copyRuntimeProfileReference()` starts with the
published SvelteKit template, overlays the representative `ReferenceWorkItem`
application object, and produces a generated manifest before any schema is
created.

Use the exported helpers in `index.ts` rather than constructing registry or
database state directly:

- `copyRuntimeProfileReference()` copies the one shared application source.
- `generateReferenceFixtureManifest()` produces the generated schema/action
  artifacts from that copy.
- `initializeReferenceFixture()` creates a file-backed local runtime.
- `seedReferenceFixture()` provisions ordinary owner, tenant, membership,
  session, asset-link, and queued-workflow state with non-PII fixture data.
- `inspectReferenceFixture()` / `canonicalizeReferenceFixture()` provide an
  identifier-free assertion shape for later runtime-profile tests.

The asset record deliberately points to a `fixture://` source URI rather than
shipping a blob. The following portability work supplies fixture payloads when
it needs to exercise blob movement.
