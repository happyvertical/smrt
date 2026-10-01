# Optional native files

Import browser APIs from `@happyvertical/smrt-mcp-openai/files` and server
annotation from `@happyvertical/smrt-mcp-openai/files/server`. Neither is loaded
by ordinary tools. This is a bounded small-file adapter, not a filesystem.

`withOpenAiFileEntrypoint(existingWorkflow, ['.txt'])` adds the pinned file
entrypoint and validates `{file:{name,resourceUri}}`. The existing read workflow
must resolve the reference through its provider and current trusted principal,
owner and active tenant. A handle, filename or `_meta["openai/resource"].path`
is never authority. Remote servers must never read a host path as their own disk.

After the portable bridge connects, create `OpenAiFileSession` with its initial
file input, an existing `authorityTool`, a `fallbackTool`, `maxBytes` (1–16384)
and explicit MIME allowlist. The authority tool receives `{file,operation}` and
must reject anonymous, other-owner, other-tenant, guessed, revoked and stale grants
using the application's existing policy/provider APIs. Successful empty tool
results mean the application authorized that operation; the adapter does not
supply a second grant database. No browser-supplied identity is accepted.

The host independently enforces the opaque grant. Reads request the selected
text/blob representation and validate exact URI, MIME and decoded byte count.
Each operation checks application authority; reads recheck after the host result.
Writes require a fresh read with `writable:true` and a nonempty ETag, always send
`ifMatch`, reject parallel writes and never retry. Every outcome, including saved,
conflict, too-large or unknown upstream failure, requires another authorized read.
A host ETag is a compare/write guard, not an idempotency token.

One bounded subscription refreshes only the initial URI and rechecks authority.
Refreshes coalesce, revocation disposes the session, and stale/disposed results
cannot update content. Dispose on UI unmount. Reconnect or a new file needs a new
session; no handle migration is attempted. Unsubscribe is best effort during
teardown, while local callbacks and authority end immediately.

Absent/unknown resource capability uses the ordinary `fallbackTool` workflow
for read/import/open/download or editor launch. It receives `{file,operation}`;
it must return usable text/links/UI through the same application policy. The
fallback does not silently replay a proposed native write. The user completes
editing through the ordinary application workflow.

`openOpenAiFile` requires explicit application confirmation, an existing provider
tool resolving the selected object, and an exact trusted `allowedPaths` list. The
host open request uses only the authorized provider's returned path. It never
accepts a caller's raw path or reads that path on the server. Without native file
opening, the provider tool's ordinary open/download result is returned. A remote
provider should return a normal authorized download workflow, not desktop paths.

## Protocol and evidence

Pinned OpenAI source revision `e314720a0daac326217d1f123fcf51647868fa9f`:
`docs/spec.md`, `typescript/src/shared/file-entrypoint.ts`,
`typescript/src/app/resources.ts`, `typescript/src/app/files.ts`, and
`typescript/src/shared/resources.ts`. Full Zod unions define wire fields.
Native browser capability keys are `experimental["openai/resource"]` and
`experimental["openai/files"]`, each `{}`; neither has a version field. The
adapter uses the existing portable bridge's origin/source/lifecycle enforcement.
There is no SDK-v1 helper, second server, or fabricated server subscription.
Host resources are intercepted by the browser host; server SDK-v2 HTTP carries
ordinary principal-authorized entrypoint tools and fallbacks (2026-07-28).

Run build, typecheck, test, test:e2e, test:files:e2e, verify:pack and
verify:files:pack with `pnpm --filter @happyvertical/smrt-mcp-openai` after normal
install and dependency builds. FILES-TEST-DESIGN.md maps adversarial coverage.
Synthetic HTTP/browser fixtures use no real files or user data. Actual OpenAI
product/build/platform access is unavailable here; these tests do not establish
live OpenAI host compatibility or permit advertising observed host support.

Subscription lifecycle regression (#3214 review round 1): notifications during a
pending write coalesce into a fresh authorized read after the write settles.
Superseded refreshes retry a read without disposing the session; authority and
validation failures still terminate it. Disposal dispatches best-effort host
unsubscribe and releases local registration synchronously, allowing immediate
replacement even when the host never replies. Deterministic session tests cover
delayed read/write completion, the refreshed ETag, revocation, and replacement
while unsubscribe is withheld.

Resource URIs are preserved verbatim and reject Windows drive prefixes as well as URLs and filesystem paths. Matching resource-update notifications invalidate in-flight reads before callbacks publish content; refresh retries still obtain fresh authority. A session invalidated by the bridge's initial synchronous snapshot immediately releases its lifecycle listener.
