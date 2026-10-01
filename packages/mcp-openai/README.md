# @happyvertical/smrt-mcp-openai

Optional navigation, settings, context, messages and mentions for s-m-r-t MCP Apps. Ordinary s-m-r-t apps do not
import this package. The `./client` entry is browser-only and depends on the
portable `@happyvertical/smrt-mcp-apps` bridge; the root entry composes existing
app-MCP workflows without creating another server or authorization policy.

## Contract and scope

This package implements the navigation/settings and context/messages/mentions children of [#3202](https://github.com/happyvertical/smrt/issues/3202)
under the [M0 integration standard](../../docs/content/architecture/mcp-apps-integration.md):

- Global and thread entrypoint metadata on idempotent read UI tools accepting `{}`.
- Structured primitive settings and permission-filtered layout actions; modern
  discovery advertises `capabilities.extensions['openai/settings']` only when
  both settings tools are in the request's authorized catalog.
- Resource display-mode metadata and portable display requests with inline fallback.
- Validated native/web app links and observed host deep links resolved through an
  existing domain-authorized read tool.
- Manifest onboarding declaration; packaged skill/assets verification belongs to M7.

Exact baseline: [OpenAI extension spec e314720](https://github.com/openai/mcp-extensions/blob/e314720a0daac326217d1f123fcf51647868fa9f/docs/spec.md),
revalidated as upstream main on 2026-09-30 UTC, and the [official extension guide](https://developers.openai.com/plugins/build/extensions)
and [UI guide](https://developers.openai.com/plugins/build/chatgpt-ui). The SDK v1
OpenAI helper is deliberately not a dependency. Server transport uses native
scoped MCP SDK 2.0.0 / protocol `2026-07-28`; browser Apps uses `2026-01-26`.

Only implemented features are declared. Files/forms remain separate planned M6 children. Settings support booleans, strings/enums/length bounds,
numbers/integers/range/multiple bounds. Arbitrary regex patterns are explicitly
rejected to avoid running unbounded patterns; applications can use an enum or
an existing domain validator. No silent schema downgrade occurs. Metadata is
bounded to 64 KiB, depth 16; settings to 64 fields, strings to 4096 characters,
routes to 2048 characters. Unknown fields/types fail closed.

## Server composition

Use `withOpenAiEntrypoints(existingReadWorkflow, ['global', 'thread'])` and pass
the result to the existing `createMcpAppServer({ workflowTools })`. It retains the
handler and portable `_meta.ui.resourceUri`. Initial tool results still render
without duplicate entrypoint calls. Give thread views distinct descriptive titles.

`bindOpenAiSettings({ schema, read, update, server: () => appServer })` wraps two
existing workflow definitions. Add its `workflows` to that server, then mount it
with `extensions: ({ tools }) => settings.extensions(tools)`. The callback runs
on `server/discover` with the same verified principal and filtered catalog used
for tool discovery. Neither annotations nor extension metadata grant permission.

Read handlers return `structuredContent: { schema, values, layout? }`, with a
value for every property. Update handlers receive `{ set: { changedField: value } }`
and return `structuredContent: { values }`. Updates are absolute-value assignments,
not toggles or increments. The binding verifies their declared read/write effects,
requires idempotent assignment, validates inputs/outputs, and never retries.

**Owning handlers must authorize resource ownership, recheck active tenant and
membership, and persist patches atomically using their existing executor and
revision policy.** The adapter does not provide persistence, transaction guards,
or domain approval. The host wire contract has no revision parameter; do not add
an invented field. Workflows requiring a human review/revision token should keep
that flow in the application, rather than force it into native settings. Tests
exercise an owning SQLite transaction, guarded update, rollback and retries.

Pass `openAiDisplayMetadata({ availableDisplayModes: ['inline', 'fullscreen'],
preferredDisplayMode: 'fullscreen' })` as a declared resource's `metadata`.
Resource security metadata and digest remain owned by app-MCP. `pip` is not part
of this pinned OpenAI display contract. Omitted fields preserve upstream defaults;
preferences remain hints.

`openAiOnboardingDeclaration('./skills/setup/SKILL.md')` returns only
`{ extensions: { 'com.openai': { onboardingSkill: ... } } }`. Merge that into the
plugin manifest; it does not install or execute the skill.

## Browser navigation and fallbacks

Import `./client`, pass the existing `McpAppBridge` to
`observeOpenAiNavigation({ bridge, resolveTool, onResult, onFallback })`, and call
the returned disposer when unmounting. It consumes bounded `rawHostContext` from
the bridge's validated origin/source and lifecycle, recognizes only
`openai/deepLink: { url }`, and calls the designated server tool with `{ url }`.
The domain tool must reject guessed or cross-tenant objects. Server applications
can use `resolveOpenAiNavigationTarget` to dispatch only an authorized read tool.

Repeated identical routes do not duplicate calls; new routes cancel old requests
and ignore stale replies. URLs are app-relative, fragment-free, traversal-free,
and reject protocol-relative, double-encoded and control-character forms. Treat
query parameters as untrusted input, never as identity or approval. The literal
query delimiter is separated before pathname decoding, so encoded question marks
cannot hide traversal segments. Traversal-like text in query values remains legal.

Only a rejected tool call or an `isError` result selects the `denied` fallback.
Consumer callback exceptions are not authorization failures and never retry a
fallback. Callbacks should handle their own rendering errors; uncaught exceptions
in asynchronous result/fallback callbacks surface as unhandled promise rejections.

`createOpenAiAppLink` emits pinned desktop (`codex`), mobile (`chatgpt`) or web
formats with separately encoded plugin/tool/path components. `openAiNavigationLink`
requires explicit `'present'` support to choose a native link; `'absent'`, unknown
or malformed support uses a configured HTTPS application URL. This support input
is a deployment/observed-host decision, **not an invented MCP capability field**.
Entrypoints/onboarding similarly have no client advertisement in the pinned spec;
keep ordinary tool/setup navigation available. Native structured settings are
optional: the same settings tools and application settings page remain usable.

`requestOpenAiDisplayMode` uses negotiated portable modes; missing/unknown modes
or a rejected request return `'inline'`. The UI must actually retain its inline
layout and render an ordinary link when navigation cannot be resolved.

## Context, messages and composer mentions

Browser consumers import `updateOpenAiModelContext` from `./context` and
`sendOpenAiMessage` from `./messages`. Server consumers import
`withOpenAiMentionSearch` and `resolveOpenAiMentionSelection` from `./mentions`.
These subpaths share the existing portable bridge and authorized app-MCP server.

`updateOpenAiModelContext({ bridge, value, native })` replaces context with
`{ text: { text, title?, thumbnail? }, structuredContent? }`. Text is nonempty and
at most 16384 characters; titles are limited to 512. Set `background: true` on the text value to emit assistant-only audience
metadata; background is a presentation
hint, **not a privacy boundary**: the model/provider still receives the context.
Only send data authorized for that recipient. Negotiated `openai/modelContext`
uses the supplied native callback. Missing support or native failure falls back
to portable text and structured content, without native metadata. Abort/disposal
prevents a late fallback.

`sendOpenAiMessage({ bridge, value, native })` accepts text and `target: 'active'`
(the default) or `'new'`. Active conversations can use portable text messages.
New conversations require negotiated `openai/message` and a native callback;
missing or malformed support rejects before any message reaches the active
conversation. Unknown targets/modalities fail closed and sends are not retried.

`withOpenAiMentionSearch(existingReadWorkflow)` declares app-only composer search
metadata and a `{ query }` input (at most 256 characters, including empty search).
Its owning handler returns `structuredContent: { items }`, with at most 25
`{ type: 'resource', resourceUri, title, subtitle?, icons? }` entries. Handles
are nonempty opaque strings of at most 2048 characters; titles/subtitles are
nonempty and bounded to 512. Each of at most eight icons requires `src` (2048),
with optional `mimeType` (128), up to eight nonempty `sizes` strings (32 each),
and `theme: 'light' | 'dark'`. Unknown fields and malformed values reject.
The published output schema describes these same closed objects and limits.

Search results are discovery hints, never authorization grants. Pass the exact
returned `resourceUri` as the existing selection workflow's argument through
`resolveOpenAiMentionSelection({ server, tool, arguments, principal })`. The
application supplies the trusted, freshly resolved principal; app-MCP policy
rechecks actor, active tenant, scopes and membership on every call, and the
owning workflow rechecks handle ownership. Never derive identity from a handle,
browser metadata or search-time permission. Guesses, cross-tenant calls and
revocation after search must not select private data. This helper adds no
selection handler, identity provider, persistence or authorization policy.

## Validation and evidence

Run `pnpm install`, then the documented dependency build and package gates:

```sh
pnpm exec turbo build --filter=@happyvertical/smrt-mcp-openai...
pnpm --filter @happyvertical/smrt-mcp-openai typecheck
pnpm --filter @happyvertical/smrt-mcp-openai test
pnpm --filter @happyvertical/smrt-mcp-openai test:e2e
pnpm --filter @happyvertical/smrt-mcp-openai verify:pack
```

The behavior/threat matrix is in [TEST-DESIGN.md](TEST-DESIGN.md). Protocol tests
use the actual SDK client and HTTP mount, including real loopback JWKS/MCP sockets
through the public M2 auth gateway with token, actor, tenant and revocation denials; the browser suite uses a real Chromium
sandboxed iframe with no-network CSP and built browser output. Packed exports
are checked for declaration and browser/server boundaries. Existing app-MCP full
suite/typecheck/pack and portable bridge gates also apply to integration changes.
The coordinator schedules all root gates and independent review.

**No actual OpenAI host compatibility is claimed.** The synthetic host does not
prove desktop, Work web, iOS, Android or account rollout support. No configured
OpenAI host connection or deployable registered synthetic plugin was provided;
record exact host/build/platform, auth profile, asset revision and observed
navigation/settings outcomes before claiming supported-host acceptance. The
upstream support matrix is expected support only; web refers to Work, excluding
classic ChatGPT. Actual host acceptance remains open for M8.
