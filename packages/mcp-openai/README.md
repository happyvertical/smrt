# @happyvertical/smrt-mcp-openai

Optional navigation and settings for SMRT MCP Apps. Ordinary SMRT apps do not
import this package. The `./client` entry is browser-only and depends on the
portable `@happyvertical/smrt-mcp-apps` bridge; the root entry composes existing
app-MCP workflows without creating another server or authorization policy.

## Contract and scope

This package implements the navigation/settings child of [#3202](https://github.com/happyvertical/smrt/issues/3202)
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

Only implemented features are declared. Context/messages/mentions/files/forms are
separate M6 children. Settings support booleans, strings/enums/length bounds,
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
query parameters as untrusted input, never as identity or approval.

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
