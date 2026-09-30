# M6a acceptance and threat matrix — #3212

Risk: high because settings updates and navigation target resolution cross the
principal/active-tenant boundary. This adapter never authenticates a browser or
owns persistence: existing app-MCP policy and workflow handlers remain authority.
Baseline: M0 integration standard; OpenAI spec `e314720a0daac326217d1f123fcf51647868fa9f`
(revalidated as upstream main); portable Apps `2026-01-26`; server MCP `2026-07-28`.
Official UI/extensions documentation fetched before design. Synthetic host evidence
is not actual OpenAI host evidence. External host access remains an acceptance gap.

All commands below use `pnpm --filter @happyvertical/smrt-mcp-openai`.

| Behavior / reachable trigger | Positive | Negative / failure | Actor/context | Executor/transaction | Runtime / external edge | Level / command |
|---|---|---|---|---|---|---|
| Entrypoint declaration and call | Global/thread tools accept `{}`, ordinary tool remains usable | Required arguments, unknown type, malformed/cyclic/oversized metadata, duplicate types | Existing authorized catalog | Existing workflow handler; no adapter transaction | Node; pinned descriptor schema | unit + HTTP / `test` |
| Settings discovery/read/update | Read schema/defaults/layout; partial absolute-value patch preserves other values | Missing value, invalid schema/enum/layout/tool, forged tenant/owner, revoked scope, guessed call | Owner A + tenant A allowed; anonymous/owner B/tenant B/revoked denied | Existing handler supplies atomic/versioned persistence; adapter never retries writes | Node/SQLite fixture; modern discovery + actual SDK client | integration / `test` |
| Settings retry/concurrency | Repeated identical assignment stable; independent field updates retained | Stale guard supplied by owning handler rejects; provider failure surfaces without retry | Same principal / active tenant checked on each call | Owning SQLite transaction/revision guard | Node/SQLite; no new DB dialect behavior | integration / `test` |
| Display modes | Inline/fullscreen metadata and portable bridge request | Unknown/pip/empty/duplicate modes; unavailable capability or upstream failure falls back inline | UI presentation only | N/A: no data mutation | Browser; portable display protocol | unit + real synthetic browser / `test`, `test:e2e` |
| Deep links | Percent-encoded native/web link; initialization and updates resolve using server tool | External/protocol-relative/traversal/fragment/oversized URL; spoofed origin, guessed target, denied handler, stale result | Browser data untrusted; server principal resolves target | Existing authorized read tool | Browser + Node; pinned URL and hostContext schema | unit + integration + browser / `test`, `test:e2e` |
| Capability fallback | Present uses supported feature; absent/unknown uses ordinary tool/app URL/inline | Malformed capability fails closed; host failure doesn't repeat writes | Trusted deployment observation, never host-name inference | N/A: UI fallback only | Browser/headless; no invented capability wire fields | unit + browser / `test`, `test:e2e` |
| Onboarding declaration | Relative packaged skill reference emitted | Absolute/traversal/wrong filename/unknown configuration | Static app configuration only | N/A: packaging assets checked by M7 | Node/browser; manifest extension only | unit / `test` |
| Package isolation | Plain Node server and browser client subpaths load packed output | OpenAI/v1 SDK symbols do not leak into portable package; browser has no Node/server imports | Consumer app | N/A: module boundary | Node/browser packed exports | build/types/package / `build`, `typecheck`, `verify:pack`, `test:e2e` |

Feature work: base-regression comparison N/A (no previous OpenAI adapter).
No host registration, deployment, directory publication, or real user data in fixtures.
Root gates and independent review are scheduled by the coordinator after integration.

## Final dependency composition

M2's public `smrt-app-mcp/auth` gateway is exercised with actual loopback JWKS
and MCP HTTP sockets plus a scoped SDK client. The gateway overwrites ambient
browser identity before M6's async discovery factory. One tenant-authorized
catalog still controls settings discovery and calls. This adds no new identity
provider or auth implementation.

| Behavior/invariant | Reachable trigger | Positive | Negative/failure | Actor/context | Executor/transaction | Runtime/contract edge | Level/command |
|---|---|---|---|---|---|---|---|
| Verified gateway → optional discovery and call | SDK connects to actual JWT-protected HTTP MCP route | Valid issuer/audience/scope maps owner + active tenant; settings advertised and patch persists | Missing/expired/wrong-audience/insufficient-scope token; other subject/active tenant; revoked membership; forged settings tenant | Synthetic owner A tenant A; other actor/tenant/revoked denied; ambient browser user never authoritative | Existing SQLite settings fixture transaction, no new auth store | Node/loopback HTTP, public M2 auth + native SDK2026-07-28 factory | Integration / `pnpm --filter @happyvertical/smrt-mcp-openai test` |

Dependency provenance and exact heads belong in the review packet; root validation
and independent high-risk reviews remain coordinator-owned.

## M6b context, messages and mentions — #3213

Risk is high: model-visible context crosses a privacy boundary, and composer
selection crosses principal and active-tenant authorization. Baseline: OpenAI
extensions `e314720a0daac326217d1f123fcf51647868fa9f`, Apps `2026-01-26`, and
server MCP `2026-07-28`. Synthetic browser/HTTP evidence does not claim an
observed OpenAI host.

| Behavior / reachable trigger | Positive | Negative / failure | Actor/context | Executor/transaction | Runtime / external edge | Level / command |
|---|---|---|---|---|---|---|
| Model context replacement | Bounded text with title/thumbnail; assistant-only background marked explicitly | Unknown fields, malformed icon, oversize text/cycle, missing capability, disposal or host error | Host metadata is inert; background still reaches model/provider | N/A, idempotent host replacement | Browser native capability / portable text+structured fallback | unit + synthetic browser / `test`, `test:e2e` |
| Message composition | Active target uses portable text; negotiated host gets exact native target metadata | Unknown capability, unsupported target/modality/resource link, mobile native limitation, upstream error | No principal or private host state accepted from message | N/A | Browser, capability absent or malformed | unit + synthetic browser / `test`, `test:e2e` |
| Composer discovery/search | Authorized workflow returns <=25 opaque resource handles | Forged tenant/ID, malformed/oversized query/result, anonymous/other owner/tenant/revoked caller denied | Verified principal and active tenant come from app-MCP request context | Existing M1 workflow and its owning read executor | SDK v2 HTTP transport; `app` visibility metadata | unit + HTTP integration / `test` |
| Selected mention use | Selected opaque handle is routed through current authorized workflow | Revocation after search, guessed/cross-tenant handle and upstream error denied | Principal and active tenant are re-read for selected call | Existing application workflow, no adapter transaction/retry | SDK v2 HTTP | integration / `test` |
| Package boundary | Node mention entry and browser context/message entries load packed | No v1 helper or OpenAI public types; malformed host never enables native path | Consumer package | N/A | packed Node/browser exports | build/types/pack / `build`, `typecheck`, `verify:pack` |
