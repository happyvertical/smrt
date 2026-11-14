# Assistant turn drivers

`mountAssistantRoutes({ turnDriver, resolveTurnDriver })` and
`runAssistantTurn({ turnDriver })` accept an `AssistantTurnDriver` with
`run(context, callbacks): Promise<void>`. Types are exported from the package
root and `./sveltekit`. No driver means the existing `runToolLoop`, with the
same model options, browser suspension/resume, budgets, persistence policy,
and wire events. An external driver replaces the loop only.

The route resolves `resolveTurnDriver(ctx)` once per send/resume, before
storing the user message. Its context includes the authenticated principal,
request event, validated but untrusted `requestContext`, and selected model.
An undefined result falls back to the static `turnDriver`, then the built-in
loop. Selection belongs to the host; never authorize an engine from request
input alone. A resolver may throw the same inference-unavailable error used
by the model factory to preserve the structured `ai_unavailable` 503 and its
engine-status/settings response. Other resolver failures become the existing
sanitized `assistant_unavailable` 503. Refused sends author nothing.

Without an external driver, `ai` is either an SDK-compatible client or a
factory called once per turn with that same authenticated request context.
That path supports user-specific model adapters, including adapters that
translate `chat(messages, options)` / `onProgress` and omit unsupported
sampling, token-limit or streaming options. Chat does not cache the factory's
result between requests. External drivers do not resolve `ai` at all.

## External adapter

```ts
import {
  mountAssistantRoutes,
  type AssistantTurnDriver,
} from '@happyvertical/smrt-chat/sveltekit';

const driver: AssistantTurnDriver = {
  async run(context, callbacks) {
    // Replace this body with the host's CLI/agent adapter.
    // Supply context.signal to its subprocess and MCP transport.
    callbacks.text('I am checking the studio.');
    callbacks.done({ text: 'The studio is ready.' });
  },
};

export const { GET, POST } = mountAssistantRoutes({
  turnDriver: driver,
  systemPrompt: 'Help the studio owner.',
  allowedTools: [],
});
```

`context` carries server-selected thread/session identity, origin message id,
prior user/assistant messages (oldest first), the new user message, system
instructions/persona guidance, the principal, optional permission ceiling,
allow-listed manifest/server tools and an `AbortSignal`. The route mirrors
that allow-list onto the session for authoring too. External drivers are
trusted server integrations: the host must bind their MCP credentials and
execution to this same principal, tool set, tenancy and permission ceiling.
Reporting a tool event is not execution authorization. No engine is imported
by chat, and driver callbacks never execute a tool.

The callbacks map directly to engine progress:

- `text(delta)` emits the existing `token` preview.
- `await toolCall({ id, name, args })` emits a server `tool_call` step and
  authors a tool-call row. Names are canonical app slugs, not provider aliases.
- `await toolResult({ id, ok, result?, error? })` emits the matching result
  step and authors a tool-result row. `result` is serialized text; `error`
  must be user-safe, as it is shown in the step. Unknown, duplicate or
  unoffered calls/results fail the turn without authoring an unauthorized row.
- `await approvalNeeded({ id, callId, tool, summary })` emits the additive
  `approval_needed` wire event and waits for the host bridge described below.
- `done({ text, usage? })` selects the final answer and optional aggregate
  `ToolLoopUsage` for `onUsage`. Chat authors the final answer once `run`
  settles. Blank answers use the configured empty-answer fallback.
- `error(error)` or a thrown error logs detail through `onError`, authors any
  partial text and a sanitized failure row, and emits the existing `error`
  event. A run returning without `done` is also a failure.

Call `done` or `error` once and settle `run`; callbacks after termination or
abort are ignored. Await tool callbacks to preserve persistence ordering.
Request abort and response-body cancellation reach `context.signal`; chat
settles as cancelled even if the engine fails to settle. The adapter must
stop its subprocess and MCP activity when aborted. Partial streamed text is
saved on cancellation. All rows are authored by `ChatService` in the turn's
existing database lifetime and linked to the originating user message.
External tool-call and result rows are saved by default; the built-in loop's
`authorInvocation`/failure-collapse policy is unchanged.

External loops currently receive server tools only. Browser tool
suspension/resume remains owned by the default driver; selecting an external
driver on a browser continuation explicitly fails with
`driver_resume_unsupported`. Do not change engines between the legs of a
suspended browser turn. Existing dock token, step, message and terminal event
handling renders external progress without a new transport or panel.

## Owner approval bridge

`AssistantApprovalRequest`, `AssistantApprovalDecision` and
`AssistantApprovalWaiter` define the server-write boundary. Mounted routes default
to app-runtime's durable owner authority over the canonical smrt-approvals ledger.
Chat rebuilds requests from the pending offered call, authors them to the thread,
streams `approval_needed`, and waits for the authenticated owner's exact decision.
The driver must await it before executing and honor denial; its host/MCP adapter
must execute under the original principal with live permissions and the supplied
ceiling. It must never expose the decision route as a model tool.

An explicitly supplied `waitForApproval` without `approvals` retains the trusted
host callback integration: it must durably store the exact call and authorize the
owner itself. Direct entry points without any bridge deny. Abort releases the
wait without granting permission. Durable defaults, policy, routes, card and crash
limits: [owner-approvals.md](owner-approvals.md).

## Validation

`src/sveltekit.test.ts` (external turn drivers) covers the authenticated SQLite route,
stream ordering, tool and text persistence, origin links, safe failures,
abort propagation, per-user/request driver and model resolution, history,
offer/ownership gates and approval waits. Existing assistant-turn and dock
suites cover the unchanged default loop/wire reader. No live engines,
providers, MCP servers or containers are required.

The behavior-to-test matrix below uses `pnpm --dir packages/chat test` for
all rows. Each case is route integration on Node/SQLite with fake engines;
`ChatService` remains the data executor in the existing turn lifetime. There
are no new SQL statements, schema, transaction boundaries or retries; the
existing service/default-loop suites retain those dialect and atomicity
contracts. No external engine or durable approval-store implementation is
claimed here.

| Behavior/invariant | Reachable trigger | Positive case | Negative/failure case | Actor/context | Executor/transaction | Runtime/dialect | External edge | Level | Command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Authoring and wire parity | Send with a driver | Text, calls, results, final and origin links saved | Upstream failure saves partial and safe failure | Authenticated owner/thread | ChatService/turn lifetime | Node/SQLite | Engine callbacks → existing SSE reader | Route integration | Package test |
| Offer and ownership gates | Foreign send or reported tool | Offered canonical tool accepted | Foreign actor 404; unoffered or duplicate call refused | Owner × foreign actor × owned thread | ChatService/turn lifetime | Node/SQLite | Canonical app slugs | Route integration | Package test |
| Model/driver selection | Context engine selection | Two users get their own adapter/driver; history retained | Unconfigured resolver 503 without a user row | Authenticated request/user | ChatService/no writes on refusal | Node/SQLite | SDK factory and driver resolver | Route integration | Package test |
| Terminal contract | Engine settles | Done ends once | Missing done, unmatched result and duplicate call become safe errors | Owner/thread | ChatService/turn lifetime | Node/SQLite | Missing or malformed callbacks | Route integration | Package test |
| Abort/stop | Request abort or body cancel | Signal reaches driver | Never-settling run/approval released; late events ignored | Owner's active turn | ChatService/turn lifetime | Node/SQLite | AbortSignal | Route integration | Package test |
| Approval seam | Pending tool requests approval | Host decision awaited and event emitted | Missing bridge denies; cancellation denies | Bound principal and pending call | Host hook; durability deferred to C3 | Node/SQLite | Approval request/decision | Route integration | Package test |
| Default loop | Send with no driver | Existing loop and dock tests unchanged | Existing provider/tool/browser-failure cases retained | Existing principal fixtures | Existing service/loop transactions | Existing package suite runtimes | Existing model and browser wire | Package regression | Package test |

## Reuse audit

Audited against base `06c0b64fe3` using `git diff --stat 06c0b64fe3 HEAD`:
C1 adds one production helper module and this contract reference; its driver
tests extend the existing route suite. It adds no component, model, route or
production tool. Existing
`mountAssistantRoutes`, `runAssistantTurn`, `AssistantTurnOptions`,
`MountAssistantRoutesOptions` and `AssistantTurnEvent` are extended in place.

The configured `smrt-dev-mcp` server was available. `review-smrt-project`
reviewed `packages/chat` with duplicate detection and source evidence;
`introspect-project` listed the existing chat models, `build-context`
(architecture) searched for external assistant loops, tool callbacks and
approval waits, and `build-package-specialist-context` searched chat's
assistant recipe and tool contracts. This server exposes no dedicated
component/intent/recipe search tool, so those lookups also read
`docs/knowledge/intents/index.md`, its human-approvals reference, the recipe
sources and the source packages with `rg`.

Both names and purposes were searched in `packages/smrt-ui`, `smrt-svelte`,
`chat`, `core`, `agents`, `inference`, `approvals`, `app-runtime` and
`app-shell`: `turn.?driver`, `external.*(agent|loop|turn)`, `toolCall`,
`AssistantClientToolCall`, `AssistantClientToolResult`, `ToolInvocation`,
`approval.*(wait|decision)`, `approved: boolean`, `confirmSave`, `consent`,
`holdForUser`, and `chat.assistant`. The results and decisions are:

| Introduced file/symbols | Existing capability and reuse decision |
| --- | --- |
| `src/assistant-turn-driver.ts`: `runExternalAssistantTurn`, its local `persist`, `enqueue`, `active` and abort closures | Reuses `sendAgentReply`/ChatService, `resolveTurnReply`, `replyMetadataFor`, the existing turn reporter, SSE producer and status/step/message contracts. No existing loop-independent bridge fits: `runPersonaConversationTurn` and `streamPersonaConversation` own model loops; shell `runAgentTurn` and `holdForUser` depend on shell models, credentials and event bus. Engine extraction belongs to C2, not this bridge. The queue only orders this driver's callbacks; it is not a durable/background queue. |
| Same file: `AssistantDriverToolCall`, callback tool-result parameter | Derives the call from `Pick<AssistantClientToolCall, 'id' \| 'name' \| 'args'>` and reuses `AssistantClientToolResult` directly. Existing `PendingClientToolCall` adds browser effect; `ToolInvocation` describes completed execution, not a started call. No duplicate field declarations remain. |
| Same file: `AssistantTurnDriver`, `AssistantTurnDriverContext`, `AssistantTurnDriverCallbacks` | New loop-independent host contract; reuses `AIMessage`, `PrincipalBinding`, `PrincipalTool`, `ManifestTool`, `ToolLoopUsage` and `AbortSignal`; `AssistantTurnOptions.thread` refers to the context's thread type. Existing model-loop options and shell-specific engine dependencies are not interchangeable with a host-owned loop. |
| Same file: `AssistantApprovalDecision`, `AssistantApprovalWaiter`; existing `src/assistant-turn-events.ts`: `AssistantApprovalRequest` | New transport notification/result and wait-hook contract only. `smrt-approvals` already owns durable `ApprovalRequest`, `ApprovalDecision` (approve/reject/request_changes), `ApprovalService.decide` and `consume`; they are not a callback outcome or chat tool-call notification. C3 must adapt that authority rather than implement another ledger. Shell `HoldOutcome` includes execution results and shell events and cannot serve as a package-neutral wait result. Chat's `RuntimeReportConfirmationHost.confirmSave` accepts only a report spec/hash and rejects to deny; data-surface confirmation is a required/none policy. Neither represents a generic pending tool notification or approval outcome. |
| Removed `src/sveltekit.turn-driver.test.ts`: its local `Round`, `Actor`, `scriptedAI`, `text`, `discoverTool`, `locals`, `events`, `mount`, `call`, `createThread`, `listMessages`, `send` and setup callbacks | Name/purpose searches found the same private helpers in `src/sveltekit.test.ts`. Moved all 11 driver cases into a nested describe there and deleted the duplicate file. Existing case bodies are unchanged; the new cases now reuse its SQLite/user/tenant fixtures, fake model/tool and SSE reader. No production tool is registered. |
| `agents/turn-drivers.md` | Contract documentation for the extension of existing `chat.assistant`/`AssistantDock`; no new recipe, UI or model. |

The review's missing-`smrt-svelte` dependency/shell advisories describe the
existing dev workbench, not new driver imports. `workspace-aliases.js`
explicitly documents that dev-only source alias: declaring the dependency
would introduce the prohibited `chat → smrt-svelte → smrt-content → chat`
cycle. Production driver code introduces neither that import nor a new
shell; no dependency change is appropriate for C1.

## Work profiles and design interception

`resolveWorkProfile(context, name?)` selects intelligence from authenticated
owner settings before authoring the user message. It receives a requested name
only on escalation; known design flows select `design` in the initial callback.
The resolved profile is forwarded to inference and its budgets govern the loop.
Background work must request `background` explicitly. Profile selection never
changes principal, tenant, permission ceiling, allow-list or owner approvals.

Hosts declare structural tools with `designTools`, or trusted tool metadata
`annotations.workProfile: 'design'` (core cookbook tools provide this annotation).
The built-in loop checks the whole proposed batch before executing any call.
External drivers MUST call `context.beforeToolExecution(canonicalSlug)` at their
**authenticated MCP execution boundary**, before effects or approval creation.
A later CLI tool-call stream event is too late. Interception aborts and settles
the old pass, then restarts once under design while retaining completed tool
observations. The intercepted assist call never executes.

Production hosts use `onDesignEscalation(context, input)` to enqueue a durable
design job. Returning `{runId, message?}` ends the request with `done.runId` and
prevents inline restart. Without the hook, the shared bounded turn restarts
inline once. `resolveWorkProfileRuntime` reselects an engine on that restart.
`Thinking this through` identifies escalation using the existing status stream.

Stored assistant rows contain `metadata.workRun`: profile, engine, actual model
when reported by the engine, effort, cumulative tokens, duration, tool calls and
fallback. `onWorkRun` receives the same sanitized accounting; the default logs
one line. CLI adapters report observed execution through `callbacks.execution`;
this also preserves spent assist work when escalation aborts its attempt.

Reuse audit: the developer intent index and MCP build-context architecture
inventory, plus name/purpose searches in chat/core/inference/smrt-ui/smrt-svelte,
identified the existing turn driver, tool-loop and cookbook annotations as the
owning seams. This extends those APIs; it adds no alternate approval ledger,
model registry, UI component or tool executor.

For durable jobs, the browser's `createAssistantHttpTransport({designRuns:true})`
reads `GET /design-runs?threadId=…` and posts `/design-runs/{runId}/stop` or
`/resume`. Hosts authenticate and owner-scope these routes. Each returns
`{run?:{runId,pass:{index,count,name},status,note?}}` with a one-based pass index.
The dock reloads progress when opening a thread, polls it, and reuses its status
and Stop controls; stopped/failed jobs offer Resume. Closing/unmounting the dock
leaves a durable job running. No browser id grants access to a run.

`formatAssistantReply(content, context)` is a trusted host presentation hook for
structured pass output. It returns human-facing `content` and optional metadata
before persistence; hosts can keep the validated output under
`metadata.designOutput` for their durable runner. That output is available only
on the trusted internal pass SSE handoff, never ordinary message wire objects.
Ordinary replies are unchanged.

Known design flows set `deferDesignTurn` to queue through that same durable hook
before any model call. Detached passes use the trusted `internalTurn(context)`
callback to supply private pass input and the original owner-message id. The
route still authenticates ownership and validates that original message against
the same thread and actor, but authors no synthetic user message and does not
rewrite the original send's lifecycle. Private pass bindings belong to the host,
not browser request flags. After that callback and the original-message checks,
the route records the request in its own WeakSet and stamps every assistant/tool
write with trusted `assistantInternalTurn` provenance via the existing author
metadata. This applies to the built-in loop, external driver, errors and tool
holds. Request headers, body/context fields and user-authored metadata cannot
select that provenance. Raw rows remain available to private provider history.

The ordinary message route requests `ChatService`'s conversation visibility.
It excludes marked assistant/tool rows and positively identified legacy assistant
rows with `designOutput`; user rows are never hidden by metadata. Filtering runs
before the visible limit using ordinary tenant/member-scoped collection pages
of 200, deterministic timestamp/id ordering, and the existing list-bound resolver.
Reply lookup rejects a hidden root and filters linked replies in the same way.
Raw service reads retain their previous default. Legacy unmarked tool rows have
no reliable run/pass linkage and are not deleted or heuristically attributed.
Public wire metadata includes only `workRun` and `designRunId`.

Hosts may opt into `toolPresentation: 'generic'` on the routes and AssistantDock.
It uses `describeAssistantTool` without raw observations, summaries or arguments;
unknown tool messages receive a fixed person-facing fallback. The same projection
covers live SSE messages, steps/status, stored legacy tool messages, and approval
references. The dock also suppresses raw browser-tool name/description/argument
fallbacks while retaining destructive warnings and the existing decision controls.
Public generic streams omit provisional model tokens; the final formatted answer
remains visible. Trusted internal handoff streams retain their original tokens.
Default clients and private provider history keep their existing contracts.

For meaningful approval previews under generic presentation, the trusted async
`presentApproval(record)` callback receives the canonical authorized hold and
returns only a host-derived business summary. The public summary and explicit
`presentation.summary` carry that caption; unsafe/unrecognized holds fall back to
“Review this change.” No raw stored/model summary is promoted by this option.
The existing card uses only the explicit presentation in generic mode; polling
and decisions still use the canonical authority.

The route tests cover built-in and external actual-tool passes, raw private SSE
handoff, reload, forged request flags, hidden-root refusal, legacy app-description
and ordinary-record tool rows, ordinary human/assistant retention, and 201 internal
rows ahead of the public page. DOM tests render legacy messages, browser-tool
confirmation and approval refresh with malicious raw captions and safe host previews.
Both default contracts and opted presentation run in the affected regression suites.

Token accounting is conservative: `workRun.tokens` is omitted if any completion
omits valid usage, including across escalation and browser continuations. An
explicit zero remains zero. `ToolLoopResult.totalTokens` remains the numeric
known subtotal; `usageKnown` distinguishes it from complete usage. API model
metadata uses a provider-reported model when available; effort describes the
requested profile effort, subject to provider support and normalization.

On durable admission, the intercepted assist turn is recorded separately before
`done`: a human handoff message carries `metadata.designRunId` and its original
`workRun` (spent tokens when fully known, elapsed time and calls). The durable
job's budget begins at its own admission; earlier assist work is not presented
as part of that job's usage. Missing observed external models remain unknown;
the requested profile alias is never substituted as an actual model.
