# MCP Apps and OpenAI integration standard

This standard governs the implementation under [epic #3202](https://github.com/happyvertical/smrt/issues/3202).
M0 establishes architecture and SDK feasibility, not production integration.
See [ADR 0002](../../adr/0002-mcp-apps-integration.md) for package ownership.

## Evidence baseline

Inspected on 2026-09-30:

- SMRT base `d4628634c98794629608cff02b29b3ffb981c350`; split server/client/node SDK `2.0.0`, protocol `2026-07-28`, conformance CLI `0.2.0-alpha.11`.
- [Iolaus da89cb0](https://github.com/willgriffin/iolaus/tree/da89cb0eefbc80a5672ab2b91845bf11750c04a6): its `/api/mcp/+server.ts` re-exports a REST-shaped GET tool list. Migration to SMRT's protocol adapter is required; an existing endpoint named MCP is insufficient evidence.
- [OpenAI extension specification e314720](https://github.com/openai/mcp-extensions/blob/e314720a0daac326217d1f123fcf51647868fa9f/docs/spec.md) and [helper manifest](https://github.com/openai/mcp-extensions/blob/e314720a0daac326217d1f123fcf51647868fa9f/typescript/package.json): helper `0.1.0` peers on `@modelcontextprotocol/sdk ^1.29.0` and optional `ext-apps ^1.7.5`. This supersedes the epic's earlier inspected extension revision.
- [Portable Apps specification](https://github.com/modelcontextprotocol/ext-apps/blob/82221c0c8ce7661efa6771c9d461511b1650495f/specification/2026-01-26/apps.mdx), pinned independently of the base MCP protocol.
- [OpenAI UI documentation](https://developers.openai.com/plugins/build/chatgpt-ui) inspected on the same date; this mutable page is guidance, not a pinned compatibility artifact.

The SDK probe lives in
`packages/mcp-conformance-fixture/src/mcp-apps-sdk-compatibility.test.ts`.
It exercises native v2 HTTP discovery, tool listing, empty entrypoint arguments,
text/structured results, resource listing/reading and preserved extension metadata.
Unknown tool/resource and malformed URI cases exercise failure propagation.
Absent UI capabilities and an unknown request metadata key do not prevent
headless operations. No new dependency is needed.

Run `pnpm --filter @happyvertical/smrt-mcp-conformance-fixture test` and
`pnpm --filter @happyvertical/smrt-mcp-conformance-fixture typecheck` after the
repository install/build. The existing generated-server conformance tests must
also stay green. The synthetic probe establishes SDK feasibility only: it does
not establish that SMRT's current application adapter exposes resources, that a
host renders them, or that the official OpenAI helper supports v2.

## Four surfaces, one application

| Surface | Execution context | Authority |
|---|---|---|
| Server MCP | Local process or authenticated server | Server principal, operation policy and domain services |
| Browser WebMCP | An open application page | Browser registration for mounted interactions; server enforcement for data operations |
| Portable MCP Apps | Sandboxed embedded UI | Host bridge for interaction, server MCP for protected data |
| OpenAI extensions | Supporting OpenAI host | Optional negotiated/discovered features; never additional domain authority |

Reuse canonical operation schemas, effects and exposure declarations. A mounted
form/table or view intent must not become a remote tool simply because it is
registered in WebMCP. Remote operations cannot require a browser tab. UI calls
must reach the same authorization, validation, confirmation and audit path as
ordinary MCP calls. Do not maintain separate CRUD permissions for each host.

The [WebMCP integration](../webmcp-integration.md) remains authoritative for
mounted tools and intents. Reuse public registries and thin bindings; do not
assume `document.modelContext` exists in an embedded iframe.

## Protocol and capability contract

Use SDK v2 and the portable resource MIME type `text/html;profile=mcp-app`.
Tools associate resources through `_meta.ui.resourceUri`. Implement resources
with native v2 APIs. The OpenAI server helper's current SDK v1 peer prevents
its direct adoption; this does not prevent native resource/metadata support.

Clients and servers must negotiate the supported MCP protocol before relying
on an extension. For the modern protocol use `server/discover` and per-request
metadata, not an assumed legacy initialization session. Do not claim older
protocol support without an explicit tested compatibility contract.

Only expose optional interactive affordances when the relevant host capability
is supported. Preserve complete text and structured results without UI. Unknown
extension keys must not grant capabilities; unknown enum values must cause a
safe fallback or a clear unsupported-feature error. Missing optional fields
must retain documented defaults. Validate metadata at the owning boundary,
including resource URIs, display modes, entrypoint schemas and tool names.

Global entrypoint tools must accept empty arguments. Discovery must not leak
private object data. Separate app-only tools from model-visible tools explicitly;
visibility and effect annotations are hints, not authorization. Cache discovery
by authorized exposure, never by a global authenticated/unauthenticated boolean.

## Security and deployment invariants

Follow [remote MCP authorization](remote-mcp-authorization.md). The application
gateway owns OAuth; SMRT validates the resulting principal at every protected
operation. OAuth discovery, authorization code with PKCE, issuer/resource/scope
validation and token lifecycle must be exercised against a real issuer in M2.
Browser login alone does not satisfy remote MCP authorization.

Bind principal and active tenant server-side on calls, resource reads, task
polling/cancellation, subscriptions and continuation. Recheck permissions when
state resumes. Never accept tenant identity or approval from iframe metadata.
No tokens, sessions or secrets belong in HTML, tool results or model context.
A UI-only result field is still disclosed to the host; minimize candidate data
and explicitly bound model-visible projections.

Mutations must retain the owning workflow's confirmation, idempotency keys,
transaction affinity and audit records. Retrying a tool or reopening a UI must
not repeat submission. Host confirmation is not Iolaus's final human approval.
Keep final employer transmission in Iolaus's established review flow until an
explicitly reviewed domain contract permits another path.

Resources must be predeclared, versioned and deterministically built. Default
CSP to no network and no permissions; review each additional origin or frame
permission. Reject undeclared external assets. Validate bridge origins, message
shapes and lifecycle ownership. Unmounting must dispose registrations and cancel
stale updates. File URLs and host file identifiers are untrusted references,
not permission to read/write arbitrary server or local paths.

Local deployments retain loopback/private storage and explicit local process
credentials. Self-hosted deployments supply their own HTTPS issuer/gateway.
Cloud deployments require verified account and tenant isolation; an environment
profile alone is not multi-customer readiness. The local stdio bridge must
forward resources and supported extensions before local UI support is claimed.
Each profile must disclose what data leaves the installation through tools,
context, files or host rendering. Packaging support and public publication are
separate from successful protocol tests.

## Extension inventory and fallback

The pinned OpenAI matrix describes **expected launch support**, not observed
behavior. Its web column means Work browser and excludes classic ChatGPT.
All OpenAI-specific features below belong to M6; M3 supplies resource transport,
M4 portable UI lifecycle, M5 durable continuation, and M7 packaging/onboarding assets.

| Feature | Documented platforms | Required fallback/constraint |
|---|---|---|
| Global and thread entrypoints | Desktop, Work web, iOS, Android | Ordinary discoverable workflow tool; empty global arguments; no private data in descriptors |
| File entrypoints | Desktop | Explicit import/open workflow; validate extension and ownership |
| Structured settings | All four | Application settings page; modern `openai/settings` discovery, permission-checked writes |
| Resource display modes | All four | Portable inline UI; validate supported modes |
| MCP App deep links | Desktop, Work web, iOS | Ordinary app URL; Android unsupported in this snapshot |
| Messages | All four, mobile restrictions | Portable `ui/message`; omit unsupported attachments/fields |
| Plugin onboarding | All four | Ordinary setup flow; packaged onboarding skill path validated by M7 |
| Model context | All four, iOS thumbnail restrictions | Portable bounded context; omit unsupported thumbnail fields |
| Local file opening | Desktop | User-mediated download/open; no arbitrary path authority |
| File resources, subscriptions and writes | Desktop | Explicit file workflow; reauthorize each read/write and handle stale subscriptions |
| Composer mentions | Desktop | Search/select operation; selected IDs reauthorized server-side |
| OpenAI form elicitation | Desktop, Work web | Portable supported input or application form; explicit unsupported error if no safe path |

Feature-detect capabilities rather than branching on host brand. Preserve
portable `ui/*` methods where available; OpenAI aliases are optional. Do not
promise mobile behavior from desktop tests. The pinned specification owns exact
field signatures and mobile restrictions; M6 must generate contract cases from
its full schemas, including unknown values and capability absence.

## Staged delivery and release gates

| Stage | Required evidence before claiming support |
|---|---|
| M0 | Reviewed ownership/standard, SDK probe, existing generator regression suite, explicit host-access result |
| M1 | Canonical metadata/exposure, workflow composition, schema and effect parity across adapters |
| M2 | Real issuer allow/deny matrix: actor × ownership × tenant context, expired/wrong-resource tokens, reconnect |
| M3 | Resource discovery/read policy, metadata preservation, modern transport and local bridge; headless fallback |
| M4 | Portable host bridge, Svelte bindings, mounted registry reuse; hostile messages, disposal, CSP and asset budgets |
| M5 | Durable task/approval/resume, cancellation, retries/partial failure, idempotency and audit without duplicate state machines |
| M6 | Each extension's presence/absence/unknown/malformed/upstream-error cases plus actual host versions/platforms |
| M7 | Opt-in scaffolds, reproducible bundles, manifest/package validation, diagnostics and deployment instructions |
| M8 | Iolaus opportunity browse → inspect → prepare → human review, across all three profiles; isolation and portability |

[#2179](https://github.com/happyvertical/smrt/issues/2179) is closed but its
read-only generated template acceptance is not implemented by M0. Carry its
no-network default, policy-covered UI calls, reference-host tests and 100 KiB
raw template budget into M3/M4. Reuse the versioned discovery work in
[#2181](https://github.com/happyvertical/smrt/issues/2181) and coordinate reference
profile/WebMCP parity with open [#2547](https://github.com/happyvertical/smrt/issues/2547).
Respect the API exposure-set direction in [#2654](https://github.com/happyvertical/smrt/issues/2654);
M1 must reconcile that contract instead of introducing another exposure toggle.

Live-host evidence is **not available in M0**: no configured Iolaus MCP Apps
connection or host test fixture is supplied in this checkout, and M0 introduces
neither a deployable application endpoint nor the browser component. Before
M8 completion, capture host product/build/platform, protocol, asset revision,
auth profile and actual negotiation/render/interaction outcomes. Until then,
entrypoint metadata transport is proven locally; host rendering and end-to-end
Iolaus compatibility remain unverified.

## Protocol hygiene negative assertions

`pnpm check:mcp-protocol-hygiene` rejects retired protocol features in package
sources and tooling. It recognizes this narrow session-header absence assertion
in `.test`/`.spec` JavaScript or TypeScript files with `expect` imported from Vitest:

```ts
expect(responses.every((response) => !response.headers.has('mcp-session-id'))).toBe(true);
```

The TypeScript parser must find an expression-statement expectation, a synchronous
single-parameter arrow callback, that parameter's exact `headers.has` call, and a
literal `true` matcher. Unbound or locally rebound `expect`, malformed syntax,
positive/unasserted checks, optional chains, and mixed boolean expressions receive
no exception. Only the verified header literal is excluded from lexical scanning;
other retired tokens or actual session uses on the same line still fail. This is a
static syntax rule, not a claim that the test executed or that runtime APIs cannot
be replaced. Runtime conformance tests remain required.

The gate's optional `--root <repository>` argument selects a package tree for
isolated CLI regression fixtures; CI and hooks use the repository default. The
root `pnpm test:ci-scripts` suite exercises acceptance and retained denials.
