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

The integration rebase audit repeated MCP package-specialist context for
`approvals` and the architecture query for a reusable Svelte decision card,
then inspected package exports and all approval/decision/confirmation Svelte
sources. `smrt-approvals` exports the gate/ledger and no Svelte UI.
Projects' ApprovalActions/PreviewApprovalPanel require project workflow states
or preview identities; timesheets' queue requires time-entry rows; commerce's
PricingVersionDecision requires a pricing version; reports' ReportConfirmation
requires a report proposal and save operation. Those domain contracts cannot
represent a server-tool hold without fabricating domain data. Card/Button remain
the reusable UI layer for AssistantApprovalCard.

| New production file | Reuse search and result |
| --- | --- |
| `app-runtime/src/owner-approvals.ts` | MCP review/context + intent index; `rg` approval/hold/owner/decision in runtime, approvals, users, core and shell. Extends ApprovalService with tool execution envelopes; uses canonical owner-role membership APIs. No new approval model. |
| `chat/src/assistant-approvals.ts` | MCP review/context; `rg` approval/policy/destructive/wait in chat, runtime, shell and inference. Adapts the existing tool/driver callbacks to OwnerApprovalAuthority; no existing host-neutral durable tool adapter fit. |
| `chat/src/svelte/components/assistant/AssistantApprovalCard.svelte` | MCP review, architecture and approvals specialist context; `rg` by approval/decision/confirmation names and purpose across packages. Reuses smrt-ui Card/Button/i18n; domain widgets above do not accept tool holds. |

The browser-free `./assistant-approvals` entry exports `observeAssistantApproval`
for hosts that already execute approved actions. It observes the same authority
until completion, with abort/timeout cleanup, without consuming or executing.
`AssistantApprovalCard` optionally accepts a host-authorized `presentation` and
`detail` snippet for an existing decision endpoint and server-loaded view.
Tricia supplies its builder/draft preview through that snippet; the shared card
owns headings, status, controls and messages. The normal transport-verified card
keeps its existing behavior and polling.
## Holds outside a thread

Pass `approvalContinuations` alongside the same `approvals` authority to
`mountAssistantRoutes`. The existing owner approvals list includes persisted
non-thread records and outcomes. Its same-origin decision route delegates only
records with a trusted continuation binding; ordinary thread holds retain their
existing thread/session checks. `AssistantApprovalCard` accepts no `threadId` for
this owner list, reusing the existing HTTP transport. No parallel approval route
or UI is added. The template host tests exercise the real decision route after
recreating the host and its authority, including an external MCP delete and a
native cookbook disable.

Authenticated thread message reads also project native continuation approvals
through the existing `AssistantApprovalCard` wire shape. The message and
approval-list routes share one owned-thread reader: tenant, requesting user,
trusted human profile and thread must all match, and the authority rechecks
live ownership. Missing/malformed principal bindings are excluded. A revoked
owner can still read their ordinary conversation, without native hold projections.
Synthetic message ids are `approval:<public approval id>`; timestamps come from
the canonical record. Persisted cards are deduplicated by approval id. Native
public views use that same public id for `callId` and omit arguments, recovery
context/keys and raw results; decisions still use the existing continuation rail.
Generic tool presentation uses a fixed safe caption unless the trusted async
`presentApproval(record)` callback derives a business preview from the canonical
hold. That caption appears in both the public summary and explicit presentation;
the generic card never promotes a raw stored/model summary. See
[turn presentation](turn-drivers.md) for private pass provenance and public paging.
Projection is enabled by either an explicit approval authority or configured
continuations using the default database-backed live-owner authority. Ordinary
chat without either option does not query the owner ledger.

The existing message route has no cursor: it loads at most 200 persisted messages.
Recent terminal native references share a 200-item historical bound with those
messages and are excluded when older than the persisted page. Unsettled native
holds remain visible even when older, then the merged response is chronological.
The underlying owner authority list remains unbounded; this projection does not
introduce a second store or claim storage pagination. Route recreation and thread
switches reconstruct the same ids and current canonical status without writes.

The existing route suite covers real SQLite native holds, malformed/foreign
user/profile/tenant/thread bindings, revoked owner access, persisted-card dedupe,
reload, safe succeeded/denied outcomes, and the 201-message boundary. Existing
built-in holds retain their correlation ids and authored transcript behavior.

D1 second-rebase compatibility: transport mode also works without `threadId`,
using the existing transport's owner-list endpoint. It still verifies persisted
state before enabling controls and reports failures. Presentation/detail mode
keeps precedence, exact legacy labels and no transport polling. The card's
parameterized DOM cases cover thread and owner-list success/refusal; restoring
the old thread-only render/poll guards makes both owner-list cases fail. The
unchanged app-shell suites exercise Tricia's presentation/detail and connection
contracts. No duplicate card or decision route is introduced.
