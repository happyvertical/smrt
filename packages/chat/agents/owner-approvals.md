# Durable assistant approvals

Read `src/assistant-approvals.ts` for policy and the adapter over app-runtime's
`OwnerApprovalAuthority`. Reuse the typed approval wire contract and existing
external driver callbacks, tool-loop execution seam, ChatService authoring gate,
route auth/origin/thread checks, HTTP transport and smrt-ui Button/Card/i18n.
No duplicate approval model, ledger, generated CRUD route or provider integration.

Default policy uses canonical manifest action / extra-tool slug; destructive
arguments on a multiplexed tool can only add a hold, never downgrade a destructive
slug. Host per-tool override precedes per-operation override. Client declarations,
engine-selected approval ids and summaries, or `approved` arguments never grant
permission. External requests are rebuilt from the pending, offered canonical
call and host summary. Explicit `waitForApproval` without `approvals` preserves the
legacy trusted host callback contract; it must itself supply durability/owner auth.
The default bridge uses the app-runtime authority, including across processes.

Built-in holds stop after the tool round (`approval`). The envelope saves the
original actor, tenant, allow-list, permission ceiling, session, thread and origin
message. Decide re-resolves offerings and permissions and intersects the saved
ceiling; it never substitutes the deciding owner as executor. It consumes once
before execution, completes before authoring, and writes a tool result/refusal to
the same thread. A tenant owner may decide another requester's hold without receiving their thread history. A crash after consumption cannot safely be retried automatically;
`executing` is an explicit unknown-outcome state for reconciliation. Pending
requests survive restart; external engine processes do not resume automatically.
A restored pending external hold may be denied/expire, but approval without its
live driver cannot restart that driver. The low-level engine/MCP adapter still
owns enforcement of live tool permissions for external effects.

The SQLite default uses migrated smrt-approvals application schema plus a runtime
system envelope table. Do not create approval model schema on request. Other
storage engines require a host authority/store integration and its own tests.

## Test design

Commands: package `test`, `typecheck`, filtered dependency `build`; root `lint`,
`format-check`, `knowledge:check --strict`. All new tests are Node/SQLite plus
jsdom components, scripted models, fake external drivers, no provider/container.

| Behavior/invariant | Reachable trigger | Positive case | Negative/failure | Actor/context | Executor/transaction | Runtime/dialect | External edge | Level | Command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Built-in hold | Model calls server delete | Persisted/streamed pending; no execution | Model approved flag cannot bypass | Original principal/owned thread | Existing tool-loop principal context + canonical authority | Node/SQLite | Tool call + SSE | Route integration | Package test |
| Decision/resumption | Owner posts decision | Original args/principal run once; result authored | Deny, repeat, malformed, foreign origin/tenant/non-owner | Owner × owned/foreign thread × tenant | Authority consume before executeAsPrincipal; ChatService author | Node/SQLite | HTTP decision | Route integration | Package test |
| Permission ceiling | Decision after grants/offer changes | Live intersection preserves allowed action | Revoked tool/permission cannot run | Original actor, never decider | Existing PermissionResolver + execution gate | Node/SQLite | Host extra tools | Route integration | Package test |
| External wait | Driver requests approval | Same durable authority releases wait | Denial/abort never grants approval | Bound driver principal/call | Canonical gate + live host execution contract | Node/SQLite | Driver callbacks | Route integration | Package test |
| UI projection | Persisted tool call mounted | Accessible translated controls/outcome; reload terminal status | No verified pending state: disabled; HTTP failure alert | Authenticated browser/owned thread | HTTP transport; no browser decision authority | jsdom | Transport optional methods | Component | Package test |
| Default regressions | Ordinary read/no driver | Existing suites remain green | Existing browser/loop failure gates | Existing fixtures | Existing transactions | Existing package runtimes | Existing SSE/driver contract | Regression | Full package test |

Reuse search evidence: MCP `review_smrt_project` on app-runtime and chat;
`build_context` architecture query for durable owner approvals/holds/cards; intent
index `Human approval steps`; name and purpose `rg` searches across smrt-ui,
smrt-svelte, chat, core, app-runtime, approvals and app-shell. Existing generic
`ApprovalService` and primitives were reused. ConfirmDialog is modal and cannot
represent a durable inline thread card; app-shell's ApprovalCard is tied to shell
object/action/draft types and shell styling, so the shared chat card composes the
existing primitives while shell remains untouched.
