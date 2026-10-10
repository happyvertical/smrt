# @happyvertical/smrt-chat

Chat rooms, threads, and agent sessions with app-controlled tool whitelisting.

## Dev Server

`pnpm --dir packages/chat dev` runs a package-local SvelteKit workbench. The root
route separates **Character setup** and **Chat dev** into tabs; switching tabs
retains the current character rig and chat state. The chat tab is an interactive
surface with a dev-only `/api/dev-chat` endpoint:
it uses `@happyvertical/ai` when local provider credentials are present and
falls back to a deterministic local assistant otherwise. `/api/dev-chat-stream`
is its SSE companion (#1936) — the same provider/local-fallback resolution wired
through `createChatStreamHandler` in plain mode, so an embedded `SmrtChatBackend`
client can exercise token streaming locally. `/previews` hosts the shared
component playground entries from `src/svelte/playground.ts`.

The root route also drives the **browser inference path**
(`@happyvertical/smrt-web/ai`: bitgpu, WebLLM, and route backends composed by
`createInferencePath`) and an **agent-addressable draft form** (`useViewIntent`
over `src/routes/chat-dev.intents.ts`, #2588). Their dev-config dependencies
(static optional-peer imports, `workspace-aliases.js` prefix rules, the theme
stylesheet import) and the stage→apply tool-call gotchas are in
[agents/dev-workbench.md](agents/dev-workbench.md).

Dev-only voice and opt-in local character persistence are documented in
[agents/dev-workbench.md](agents/dev-workbench.md#voice-and-local-character-persistence).
These endpoints are loopback-only demos; production hosts supply authenticated
principals, tenancy, and authorization to the owning services.

## Models

All seven models expose only generated REST/MCP `list`/`get`; structural tests
check the registry for accidental mutating operations. Writes go through
membership/owner-checked `ChatService` or the binding-checked voice adapter.

`ChatService` is a closed facade. Its collections and security-sensitive
helpers use ES `#private` fields/methods (TypeScript `private` is erased).
Collection classes are not exported from the package index. The agent-reply
bridge is a Symbol-keyed static accessible through a non-exported symbol held
by the module-local `sendAgentReply` function.

- **ChatRoom**: `roomType` (public/private/dm/agent), `status`, `topic`, `maxParticipants`, `lastMessageAt`. Tenant-scoped (required).
- **ChatMessage**: shared by users + agents. `role` (user/assistant/system/tool), `messageType` (text/system/action/file/tool_call/tool_result), `toolCallData` JSON. Unified model — no separate agent message type. Tenant-scoped (required).
- **ChatParticipant**: `role` (owner/admin/member/viewer), `onlineStatus`, `lastReadMessageId`, `isMuted`. Tenant-scoped (required).
- **ChatThread**: `rootMessageId`, `isResolved`, `messageCount`. Created via `ChatService.startThread()` (member-checked). Tenant-scoped (required).
- **ChatReaction**: `messageId`, `profileId`, `emoji`. Added/removed via `ChatService.addReaction()`/`removeReaction()` (member-checked, self-keyed). Tenant-scoped (required).
- **AgentSession**: `agentId` (application slug, string ref, not FK), `agentProfileId` (nullable `crossPackageRef` to `Profile` — the `bot` profile the agent AUTHORS as, #2995), `allowedTools` (JSON string array), `sessionContext` (JSON, sensitive), `systemPrompt`, limits (`maxTokens`/`maxMessages`/`expiresAt`). Optional tenancy.
- **VoiceSession**: short-lived voice-gateway binding over `(tenant, actorProfileId, personaId, room/thread/agentSession)` plus a persona snapshot, gateway `session_id`, expiry, replay tracking, and metadata. Tenant-scoped (required). Generated surface is read-only; creation and turns go through `createVoiceChatSession()` / `handleVoiceGatewayTurn()`.

## ChatService

Public writes take server-supplied `actorProfileId`; never trust a request's
`senderProfileId`, `role`, owner id, or participant id as authority.

| Operation | Authorization and behavior |
|---|---|
| `sendMessage()` | Room member; authors as actor with `role: 'user'`; no public membership bypass |
| `createRoom()` | Actor becomes owner |
| `startThread()` | Member; optional root message bound to room and tenant |
| `addParticipant()` / `removeParticipant()` | Owner/admin; self-leave allowed |
| `updateRoom()` | Owner/admin |
| `addReaction()` / `removeReaction()` | Member; self-keyed |
| `getOrCreateDM()` | Actor must be a DM participant |
| `createAgentSession()` | Actor becomes session participant; existing-session lookup tenant-bound; optional `sessionKey` isolates conversation subjects |
| `updateAgentSessionConfig()` | Owner; mandatory tenant-bound lookup |
| `sendAgentUserMessage()` | Actor must be session participant; authored as participant |

Read facade: `getAgentSession({agentSessionId, tenantId})`,
`findActiveAgentSessions({tenantId, agentId, participantProfileId})`, and
`getThread({threadId, tenantId})` are tenant-bound; consumers still check
ownership/context. `listRoomThreads({roomId, actorProfileId, tenantId})`,
`getThreadMessages({threadId, actorProfileId, tenantId, limit?})` (chronological),
`getRoomMessages({roomId, actorProfileId, tenantId})`, and
`getRoomForMember(roomId, actorProfileId, tenantId)` additionally require
membership of the server-supplied actor, not a caller-selected subject.

Trusted agent runtime imports `sendAgentReply(service, params)` only from
`@happyvertical/smrt-chat/internal/agent-runtime`. It is not a `ChatService`
method or package-index export. It authors as `session.agentProfileId` — the
agent's resolved `bot` Profile, NEVER the `agentId` slug (#2995) — accepts a
same-room/tenant thread, and enforces `allowedTools` fail-closed.

Private `#writeMessage` alone can select arbitrary authors/roles or bypass
membership. It binds every supplied `threadId`, `agentSessionId`, and
`replyToMessageId` to the same room **and** tenant. Internal enrollment supports
automatically created rooms, sessions, and participants.

## Agent Tool Whitelisting

`allowedTools` is a JSON array controlled by the consuming app. Fail-closed: an empty/unparseable whitelist permits NO tools. The internal `sendAgentReply(service, params)` function enforces the whitelist before emitting any `tool`/`tool_call` message; a caller cannot supply a `senderProfileId`/`role` to post as the agent, and the function is not reachable from the package index.

Principal-bound data discovery and reads are available as `PrincipalTool[]` via
`createDataSurfaceTools()` (re-exported by the chat package). Pass the tools as
`extraTools` to the persona conversation/tool loop. They use the same
fail-closed `allowedTools` offer/execution gates; RBAC, tenant, redaction,
bounded query results, and audit authority remain in the authenticated
`PrincipalRun` supplied by `@happyvertical/smrt-agents`.

## Runtime report tools (#3711)

`createRuntimeReportTools()` (`runtime-report-tools.ts`) returns four
`PrincipalTool`s for the persona `extraTools` seam: `reports.runtime.sources`,
`reports.runtime.define` (`preview` / `apply`), `reports.runtime.list`, and
`reports.runtime.run`. The model supplies only a declarative
`RuntimeReportSpec` from `@happyvertical/smrt-reports`; sources are a
server-owned allow-list gated by `run.assertOperation(collection, 'read')`, and
field policy, `readPermission`, and tenancy are enforced by the compiler against
the live run on every compile and every stored-report run. `apply` needs the
`specHash` of the previewed spec plus an app-owned `confirmation` host that
resolves only after a human approved that exact spec; with no host the tools are
propose-only and a model-supplied `confirmed` flag is ignored. Saving also needs
`create` on the `RuntimeReport` collection, and `list`/`run` need `read`; the
default `reportsCollection` is the `RuntimeReport` class itself, which resolves
to the catalog slug. A string `collection`/`reportsCollection` is used verbatim
as a catalog slug (never a class name); tests must run the tools under the real
`assertOperationPermission` guard so a wrong slug fails. A stored report is
written only by this confirmed `apply`: the model layer refuses every other
insert/spec change, and the generic manifest tools (`buildManifestToolCatalog`,
`invokeManifestTool`) never offer or run a `RuntimeReport` write. Stored-report
reads/saves run under the principal's tenant (`withPrincipalTenant`), refuse a
mismatching ambient tenant, and filter by the principal tenant explicitly. Contract and authority model:
[`packages/reports/agents/runtime-reports.md`](../reports/agents/runtime-reports.md).

## Conversational Harness (L3, #1891)

The `AgentSession` runtime depends on personas, agents, and users. Keep those
edges acyclic: none of those packages may depend back on chat.

- **`runToolLoop(options)`** (`tool-loop.ts`) — a bounded `tool_call → observe → respond` loop. Tools are **manifest operations** of installed packages: `buildManifestToolCatalog({ allowedTools })` reads the `PermissionCatalogService` catalog and keeps only the `(collection, action)` entries named in the persona's allow-list (the **offer gate**; absent/empty ⇒ NO tools). The loop runs inside one `executeAsPrincipal` context, and `invokeManifestTool` executes each op **in-process ("side door")** against `run.context.database` (the RLS tx when Postgres RLS is on), after re-asserting the fail-closed allow-list (`run.assertToolAllowed`) AND the catalog permission (`run.assertOperation`) — the **execution gate**. Bounded by a max-steps ceiling (`DEFAULT_MAX_STEPS = 8`): on the ceiling it disables tools for one final completion so the turn always terminates with text. A thrown tool error is classified (`classifyToolError`): permission denials and 401/403 are `not_permitted`; a `ValidationError` or 400/404/409/422 is `invalid_request` (observation: actionable message, `publicMessage` first, `code`, fix-and-retry hint); else (incl. 429) `execution_error`.
- **`runPersonaConversationTurn(options)`** (`persona-conversation.ts`) — binds a conversation to an `AgentPersona`/`ResolvedPersona`: runs as its principal (`runAsUserId`), offers only its `allowedTools`, speaks its instructions (`resolvePersonaInstructions`, layering approved learned directives), and injects its **recalled learning memory** (`personaLearningMemory`, isolated per `memoryScope`) into the system prompt. `bindPersonaToSession()` mirrors the persona's `allowedTools`/instructions onto the `AgentSession` so the chat authoring gate agrees with the loop's offer gate. Authors the reply (and each executed tool) via the internal `sendAgentReply` bridge. Tools run with the run-as user's **live** permissions unless the host passes a `permissions` snapshot (#2978), which `runToolLoop` forwards to `executeAsPrincipal` so a narrowed principal (e.g. a shared station) cannot reach grants — such as `readPermission`-gated data-surface fields — beyond that snapshot, including through `agents.invoke` delegation (the snapshot becomes the worker's permission ceiling).
- **Agent orchestration** (L3, #1892) — the loop accepts non-manifest **`extraTools`** (`PrincipalTool[]`, from `@happyvertical/smrt-agents`), gated by the *same* fail-closed allow-list. The standard **`invoke-agent`** tool (`createInvokeAgentTool`, slug `agents.invoke`) lets a conversational agent delegate to a **worker agent under its own principal** — the worker runs via `executeAsPrincipal` as the originating user (never its own authority), the principal is immutable along the chain, and its completion is surfaced back into the conversation. `runPersonaConversationTurn` filters `extraTools` by the persona's `allowedTools` (offer gate); the tool's `execute` re-asserts `assertToolAllowed` (execution gate). See `@happyvertical/smrt-agents` for the delegation envelope + transports.
- **Chat feedback capture** (`chat-feedback.ts`) — `captureChatFeedback()` + `acceptAppliedChange`/`rejectAppliedChange`/`correctResponse`/`rateResponse`/`thumbsUp`/`thumbsDown` write a `Feedback` row (personas) carrying the conversation's **correlation-id**, and (by default) reinforce the persona's learning memory (`reinforceFromFeedback`). So an in-chat reject decays a strategy below the reuse floor and it stops being recalled; a correction supersedes its stored value.

## Voice Gateway Turns (#1910)

Voice is an input mode for the existing persona chat harness, not a separate chat runtime. `createVoiceChatSession()` creates a short-lived `VoiceSession` for an authenticated actor/profile, binding tenant, persona, agent session, room, and optional thread. `handleVoiceGatewayTurn()` resolves that binding from `metadata.voiceSessionId`, checks the gateway's `session_id` and any supplied tenant/profile/persona/session/thread metadata against the server-side binding, persists the transcript through `ChatService.sendAgentUserMessage()`, runs `runPersonaConversationTurn()`, stamps voice/correlation metadata onto the persisted user/assistant/tool messages, records the gateway `turn_id`, and returns the gateway response contract. The Fetch-compatible `createVoiceGatewayTurnHandler()` adds the coarse gateway bearer-token check.

The gateway bearer token proves only "this request came from the gateway"; it never authorizes the end user. The short-lived `VoiceSession` binding is the user/session proof, and untrusted gateway metadata must be validated against that binding before any chat write or tool loop. Tool execution remains fail-closed through the persona allow-list mirrored onto `AgentSession` by `bindPersonaToSession()`.

## Token streaming

`chat-stream.ts` serves browser-safe SSE through `./client`. The host's
`authorize(request, body)` is the sole trust boundary: resolve identity, tenant,
capabilities, and generation limits server-side; never authorize from request
session metadata. Persona turns reuse the principal and fail-closed tool gates.
The engine and browser-safe `SmrtChatBackend` keep custom-tool resolution
server-side. See [agents/token-streaming.md](agents/token-streaming.md) for the
event contract, CORS policy, and streaming behavior.

## Streamed assistant turns with browser tools (#2908)

`runAssistantTurn()` (`assistant-turn.ts`) is the host-route engine for the
AssistantDock: one turn over `runToolLoop` with server tools (offer-gated by
`principal.allowedTools`), browser tools (validated by
`sanitizeClientToolDeclarations` + a server allow-list), `maxSteps`, `signal`,
and `onUsage`. A browser tool call SUSPENDS the turn (`stoppedReason:
'client_tools'`); the transcript waits in an `AssistantContinuationStore`
(single-use, 15-minute TTL; `createSessionContinuationStore` keeps it in the
AgentSession's `sessionContext`) and the browser resumes it with results,
which reach the model wrapped `untrusted`. `createAssistantTurnResponse`
serves the events as SSE; `assistant-turn-events.ts` is the browser-safe wire
contract (`./assistant-turn` subpath, also a vite library entry because the
Svelte dock imports it). The dock decides whether a browser call runs or waits
for the user from the page registry, never the server's echo; destructive
always waits. Details: [`docs/assistant-dock.md`](../../docs/assistant-dock.md).

## AssistantDock (#2904)

`AssistantDock` (`svelte/components/assistant/`, exported from `./svelte`)
uses a host `DataSurfaceRegistry`'s mounted descriptors (none: plain chat).
Actions: `normalizeDataSurfaceActionRequest` → `AssistantActionClient`
(preview/apply over a server `DataSurfaceActionAdapter`, not the
`data-surface-bridge.ts` channel). Generated `ChatThread`/`ChatMessage`
`list`/`get` are tenant- not member-scoped; the dock never calls them.

**Server routes (#3368).** `./sveltekit` `mountAssistantRoutes()` serves the
dock from one `[...path]` route; `createAssistantHttp{Transport,ActionClient}`
(`./svelte`) are its browser half. Principal from `event.locals` or
`resolvePrincipal`; threads only from the actor's keyed session room in that
tenant (else 404). `allowedTools` is fail-closed; without `tools` it offers
those manifest ops (an unprovided name is an error, #3414). `ai` defaults to
the config `ai` block. Pass `runtime`: a turn never keeps the RLS request tx
(own `runAsPrincipal` tx). `clientRequestId` makes the row id a UUIDv5
(`clientRequestMessageId`): the PK is the retry reservation. See
[docs](../../docs/assistant-dock.md).

## Recipes (#3719)

`src/recipes.ts` declares `chat.assistant` (the AssistantDock as a `header.end`
shell widget, an `llm` provider, runtime `both`; help in
`src/assistant.recipe.md`). Keep each recipe class self-contained. Details:
[agents/recipes.md](agents/recipes.md).

## Gotchas

- **sessionContext, not context**: `context` is reserved for slug scoping. Use `getSessionContext()`/`updateSessionContext()` for agent memory.
- **Agent rooms auto-created**: `roomType: 'agent'`, `maxParticipants` defaults to 2; the agent is enrolled as a member so its replies pass the membership check. `createAgentSession()` re-enrolls the participant AND the agent on the existing-session path, so legacy sessions created before the agent was enrolled self-heal.
- **The agent's author is a Profile, not `agentId` (#2995)**: `senderProfileId`/`profileId` are `crossPackageRef`s to `Profile` and therefore uuid columns on PostgreSQL, so the slug fails the cast (`22P02`) and no agent reply can persist. `createAgentSession()` resolves the agent's `bot` Profile through `resolveAgentProfile()` in `@happyvertical/smrt-profiles` (created on first use, tenant-bound) and records it as `AgentSession.agentProfileId`; both enrolment and `sendAgentReply` use that uuid. A consumer whose agent already has an acting identity passes `agentProfileId` to skip resolution — the voice path does this with the persona's `actsAsProfileId`, so persona replies stay attributed to the configured acting profile. Like `actorProfileId`, `agentProfileId` is SERVER-supplied, never request input: it selects the author of every later assistant message. It is validated (`#requireAgentProfile`) to exist and be visible in the tenant and to differ from the acting participant, and it can never re-point a session that already resolved one — only a pre-#2995 session with none is backfilled. **Migration**: `agent_profile_id` is an ordinary additive manifest field, so a consumer adopts it the same way as any other — `smrt db:migrate` generates and applies the column from the manifest, and `db:status --parity` verifies it; the framework never creates application schema at runtime. It is nullable and needs no offline DATA backfill — a session created before #2995 resolves and persists its `agentProfileId`, and re-enrols the agent, on its first agent turn after the upgrade. Two pre-#2995 cohorts: a session whose `agentId` is an ordinary slug never committed an author on PostgreSQL (the cast failed), so there is nothing to repair there, while SQLite/DuckDB may hold `chat_messages`/`chat_participants` rows whose id column holds the slug — readable, but not joinable to `profiles`. A session whose `agentId` is already a Profile uuid (the voice path used to collapse a persona's `actsAsProfileId` into it) DID commit on PostgreSQL; that profile is ADOPTED as the author, tenant-checked and never the participant, so the conversation's author does not change and the two-seat room gains no third identity. Known one-time effect: because `voice.ts` no longer derives `agentId` from `actsAsProfileId`, a keyless `createVoiceChatSession()` for such a persona opens a new session and room instead of reusing the legacy one; the old room and its messages stay intact and readable, and resuming with an explicit `agentSessionId` is unaffected.
- **Only SQLite-backed tests would miss this class of bug**: uuid columns accept any text on SQLite. `src/__tests__/agent-reply-postgres.test.ts` (`pnpm --filter @happyvertical/smrt-chat test:postgres`) pins the agent-reply path against real PostgreSQL. That suite runs in `postgres-tests.yml` on every same-repository PR and merge group (#2659); keep a cheap SQLite assertion alongside it anyway, since the default lane is SQLite-only (`chat-service.test.ts` asserts the author is the profile uuid, not the slug).
- **Per-subject sessions need `sessionKey`**: `createAgentSession()` reuses ANY active session for the same `(agentId, participantProfileId, tenantId)`. Callers that open separate conversations per subject (e.g. one content-editor session per content id) MUST pass a stable `sessionKey` (stored in `sessionContext.__sessionKey`, read via `AgentSession.getSessionKey()`); otherwise a session opened for one subject is reused and its context overwritten for another, surfacing the wrong room/threads (S5 #1392). A keyed create never reuses a keyless/legacy session.
- **Session expiry**: check `isActive()` before allowing messages (expiresAt or limit-based)
- **DM identity**: derived from the deterministic per-tenant `canonicalDmRoomId()` and the authoritative `chat_participants` join, not client metadata; concurrent creates upsert onto one row.
- **Tenant-bound lookups**: membership/session/DM lookups REQUIRE `tenantId` and always bind it into the WHERE clause (`findActiveMembership`/`isActiveMember`/`findActiveSession` take a required `tenantId`; AgentSession's `null` tenant is an explicit bound scope, not "any tenant") so they can never resolve a row from another tenant.
