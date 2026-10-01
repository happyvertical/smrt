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
| Private UI resource policy | SDK reads entrypoint resource over HTTP | Trusted current owner, active tenant, view scope, exact resource URI | Null principal, other subject/tenant, missing scope, revoked membership | Live route principal and fixture membership | Resource policy uses the same fixture authority; no public default | Native SDK HTTP resource read rechecks each request | Integration / `pnpm --filter @happyvertical/smrt-mcp-openai test` |

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
## Accepted round-1 regressions

- Navigation A → invalid → A must resolve again whether A completed or remains pending. Browser cases observe cancellation, restore the same route, and prove a late original reply cannot replace the restored result.
- Settings schema object-key order is immaterial at all nested levels. Changed numeric limits, enum contents, and enum array order remain rejected. Baseline tests fail before either fix and pass after.
- The reported frozen-install mismatch is rejected with actual clean-archive evidence: workspace Node-type override applies, and both baseline and current frozen installs exit0. No dependency or lockfile change is required.

### Accepted review regressions

The Chromium fixture imports the packed-output context/message helpers instead of
choosing a status label itself. It records every native and portable wire call.

| Trigger | Required observation | Regression level |
|---|---|---|
| Negotiated native context rejects | Helper awaits a second, portable replacement with plain text and structured content; native title/thumbnail/background metadata is absent | Exported-helper unit and Chromium wire/result |
| Caller aborts or bridge disposes while native context is pending | Late native failure cannot send any portable replacement | Unit abort and Chromium abort/disposal with held failure |
| New-conversation target with absent/unknown capability or missing native callback | Reject before dispatch; no portable `ui/message` reaches active conversation | Exported-helper unit and Chromium wire count |
| Active conversation without native support | One successful portable text message | Exported-helper unit and Chromium wire/result |
| Negotiated new conversation | One native message retains `target: new` and `send: true` metadata | Exported-helper unit and Chromium wire payload |

The same new tests against pre-fix production helpers fail on native rejection
fallback and all three unsupported new-conversation routes. These tests use a
synthetic host and do not establish actual OpenAI host compatibility.
## Reviewed workflow error contract integration

Current runtime workflow-handler failures resolve with `isError: true`, one
`Workflow execution failed.` text item and that same structured error message.
The integration fixture asserts that exact safe payload for adapter argument
validation, domain target refusal, provider rollback and stale revision, including
forged settings arguments over the real authenticated SDK HTTP route. Private
handler causes never become client-visible error text. Write counts and persisted
values still prove denied operations and rollback do not mutate state.

Principal/tenant/scope/revocation and catalog authorization remain separate:
those pre-handler access failures still reject. This fixture update does not
change navigation, settings, authentication or workflow production code.

## Accepted PR3267 regressions

| Behavior / trigger | Positive and negative case | Actor / executor / runtime / edge | Validation |
|---|---|---|---|
| Encoded query delimiter in pathname | `/safe%3F/../admin` and encoded dot segments rejected before resolver; literal query values containing `../` accepted | Untrusted host; no database executor; native validator and Chromium bridge wire | Package unit and browser; baseline3 native failures and traversal browser failure |
| Throwing UI callback after tool result | Successful result render throw is not denied; denied-result fallback throw executes once; transport rejection fallback remains once; later route recovers | Application callback; no transaction; Chromium actual helper and tools/call wire; uncaught callback error observable as unhandled rejection | Browser result/isError/transport-error regressions; baseline result and isError cases fail |

The fixture observes and prevents the browser's unhandled-rejection default only
to assert callback errors explicitly. Production does not swallow these errors or
map them to authorization denials. Existing cancellation/disposal/stale-result
contracts remain covered by the original browser suite. No new wire API is added.

## Accepted PR3271 mention regressions

| Behavior / trigger | Positive | Negative / failure | Authority / executor / runtime | Validation |
|---|---|---|---|---|
| Published mention output descriptor | Closed resource and icon fields expose exact required fields/bounds | Unknown fields disallowed; optional presentation does not become required | Static SDK descriptor; no persistence; Node | Unit descriptor and installed public runtime |
| Icon serialization | Optional sizes/theme retained, absent optional fields accepted | Non-array sizes, invalid elements, empty/oversize/more than eight sizes, unknown theme reject | Presentation only; no principal or transaction; Node | Baseline two failures/62 passes, then current package + installed |
| Returned mention selection | Exact searched resourceUri reaches existing authorized selection workflow | Guessed handle returns exact generic safe error; anonymous/other actor/tenant/missing scope/revoked membership never execute owning selection | Existing app-MCP policy plus owning read executor; selections/executions counters; SQLite authority fixture | Integration and fresh installed public workflow probe |

The selection test asserts no unauthorized selection or settings write, including
revocation after search. No new policy engine or public handler API is introduced.
The real Chromium context/message/navigation suite remains required. Files/forms
remain planned; synthetic evidence does not establish actual OpenAI host support.
