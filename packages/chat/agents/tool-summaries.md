# Tool summaries and engine adapters

`describeAssistantTool` / `toolSummary` own human tool words moved from shell.
The existing `describeTool(name, args?, outcome?)` seam now receives completed
`{ ok, observation }` results. Existing two-argument host callbacks still work.
Both built-in and external turns use it for result step labels and the default
persisted tool message (`toolCallData.label` too). Successful built-in results
are now authored by default; `authorInvocation` can still replace or suppress
them. Failure diagnostics and their collapse policy remain intact. The dock
renders existing labels/content; no new event type or rendering stack exists.
Only a short name/title, bounded list count or safe explicit summary enters a
label. Raw payloads, JSON, machine paths, SQL and credential-shaped text never
belong in a chip. Arguments are not used as record names. Unknown offered tools
get generic words; unoffered calls retain the existing unknown-tool gate.

`@happyvertical/smrt-chat/engines` is Node-only. Chat → inference is acyclic
(`pnpm check:package-dag`). `createChatGPTAssistantAI(options)` wraps inference's
`createChatGPTModel` as the SDK `chat` subset accepted by the loop. Tools/raw
provider calls, signal, text and total usage survive; inference sends only
`chat` + `onProgress`, with no sampling/token/reasoning/stream options or key
fallback. `createInferenceAssistantAdapters({ binding, status, cli, chatgpt,
api? })` returns `{ resolveTurnDriver, ai }` for `mountAssistantRoutes`. The host
reads the authenticated user's stored binding, never `requestContext`. Selection
and status are cached only for that Request; missing binding selects the existing
configured API factory. An unavailable/invalid selected engine refuses before
writing and never falls back to another billing path.

`createAgentCliTurnDriver({ tool, bind })` adapts `runAgentTurn`. `bind(context)`
returns the host's MCP endpoint, token mint/revoke, private state directory,
lookup dependencies, exact tool policy and owner/turn-filtered approval observer.
The MCP endpoint MUST enforce the original principal, tenant, permission ceiling,
allow-list and durable approval policy on execution: stream inspection happens
later and cannot authorize an effect. Inference retains loopback restrictions,
key stripping, private empty working directory, built-in-tool lockdown and process
and credential cleanup. Chat authors text/tool rows exactly once. Each CLI turn
starts fresh with chat history as untrusted context; no credential or CLI session
store is added. Full arguments come from inference's append callback rather than
its intentionally clipped display event. Summaries are computed before result
clipping and passed through the existing describe result argument; the CLI owns
the raw model observation. Optional `canonicalToolName` maps MCP wire aliases to
chat's offered slugs, while `allowTool` still gates the MCP wire name. A mapper
returning undefined denies; aliases never broaden the offered set.

The driver's optional `waitForApproval` uses the existing trusted host-waiter
contract: it OBSERVES the MCP host's existing durable hold, never creates another
ledger, decides, consumes or executes it. Mounting uses that waiter unless an
explicit chat approval bridge is configured; do not combine two authorities.
A pending result is never authored as a successful effect. The driver awaits the
owner's decision, then asks for a new turn; it cannot automatically restart the
exited CLI process. Abort releases observation, removes listeners and never grants
approval. The host must expose its authenticated decision/status endpoint to the
existing approval card (or supply its own existing card through the dock slot).

## Validation design

All tests use Node/SQLite, fake models and inference's stub CLI. No provider,
container or real login is required. No new database schema, SQL executor,
transaction or dialect behavior is introduced.

| Behavior/invariant | Trigger | Positive | Failure | Actor/context | Executor/transaction | Runtime/dialect | Edge | Level | Command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Summary parity | Built-in/external CRUD/list/unknown | Same step and persisted label | Payload/path/SQL/secret omitted; existing offer gates | Authenticated owned thread | Existing ChatService turn lifetime | Node/SQLite | Model/driver callbacks → existing SSE | Route integration/unit | chat test |
| CLI adapter | Stub text/tool/hold | Ordered persisted callbacks, full args, shared labels | Abort, failure, unoffered tool; no held success | Bound principal and host owner observer | Existing chat author; MCP host executes | Node/SQLite; subprocess OS | Inference runAgentTurn + token lifetime | Integration | chat test |
| ChatGPT factory | Fake plan model | Raw calls, progress, usage and signal | No unsupported options or API fallback | Per-request connection | No database writes | Node | Inference createChatGPTModel | Unit | chat test |
| Per-user selection | Stored binding/status | Each user gets their selected engine | Missing/unknown/unready refused, no fallback | Authenticated Request | Refusal before ChatService writes | Node | Existing resolver hooks | Unit/route regressions | chat test |

## Rebase interaction validation

| Behavior | Positive | Negative | Principal / executor | Boundary / check |
| --- | --- | --- | --- | --- |
| External manifest exposure | Enabled tools retain shared summaries | Disabled/unreadable models absent; a live closure refuses callbacks and approval acceptance | Original authenticated tenant; MCP endpoint remains effect authority | Driver bridge and real CLI stubs; chat suite |
| Saved owner approval | One execution after restart authors the shared outcome label | Refused/denied holds keep diagnostics and cannot replay | Captured principal/permission ceiling; existing durable authority and dispatcher | SQLite mounted routes; chat suite |
| App replacement and STI | Canonical provider identity gates the effective app class; explicit create subtype survives summary generation | Closed gate prevents dispatch | Original tenant; registry collection dispatcher | Tool-loop integration; chat suite |

Connect AI has no record/reference-picker dependency. It configures inference
before model offerings exist; reference picker source and screen composition are
unchanged. No artificial picker adapter is introduced.

## Reuse check

Configured MCP `review_smrt_project` reviewed chat and smrt-svelte; `build_context`
architecture query searched tool descriptions, engine adapters and connection
composition. The server exposes architecture/model listings but no standalone
component/intent/recipe search. Read the intent index and used `rg` name AND purpose
searches over smrt-ui, smrt-svelte, chat, core, inference and app-shell for
`toolSummary`, `summary`, `describeTool`, `ConnectAi`, `connect AI`, sign-in,
`runAgentTurn`, model factories, approvals, recipes and onboarding/settings.

New `src/tool-summary.ts` extends existing describe/label events, moving shell's
summary purpose to chat; reuses ToolInvocation's result shape. New `src/engines.ts`
reuses inference's engines, types and fake CLI fixtures, existing turn callbacks,
ChatService, route resolver/factory and trusted approval waiter. No new model,
route or tool is registered. Its internal serialization queue only adapts the
synchronous inference emitter to awaited chat callbacks. New tests extend the
existing SQLite route fixtures, with isolated engine fakes in engines.test.ts.
No equivalent shared adapter or summary generator existed in the owning packages.

Rebase reuse search: MCP `review_smrt_project` on chat/smrt-svelte and `rg`
`isManifestToolEnabled|isToolEnabled` plus exposure purpose searches in core,
chat, smrt-ui and smrt-svelte found core's `isRuntimeModelEnabled` and the four
existing chat dispatcher checks. `isManifestToolEnabled` consolidates those
checks in their existing owning module; external drivers reuse it. No new file.

Manifest create offerings and execution
now use core's public `ObjectRegistry.getCreateTargets` / `resolveCreateTarget`
API ([contract](../../core/agents/generators.md#public-collection-create-targets-a1b)).
`createType` is an optional qualified create target; `_meta_type` is a compatible alias.
The model's `type` field remains business data, including on STI families.
Selection occurs before filtering and uses the selected model's writable policy;
selectors are not persisted fields. Offerings and execution both use the original
principal's live runtime exposure context. The Profile/Bot assistant canary and
`src/create-targets.test.ts` cover all four dispatch paths, replacement, labels,
readonly fields, malformed/foreign choices and gated children on SQLite.
