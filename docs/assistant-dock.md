# AssistantDock

`AssistantDock` (`@happyvertical/smrt-chat/svelte`) is a shell-mounted,
route-aware assistant surface (issue #2904, phase 1 of parent epic #2433).
One tenant-scoped assistant is usable in any host shell; the
`DataSurfaceDescriptor`s currently mounted on the active route decide what it
can see and act on.

## Placement

Everything ships from `packages/chat`, under
`src/svelte/components/assistant/`, exported from the existing
`@happyvertical/smrt-chat/svelte` entry point (`packages/chat/src/svelte/index.ts`).
No new `./assistant` subpath was needed — `./svelte` carries it cleanly.

- `AssistantDock.svelte` — the composed surface (thread list, messages, action
  panel, composer).
- `FloatingAssistant.svelte` — a launcher and responsive floating panel around
  one permanently mounted dock. It is presentation only: a collapse never
  recreates the controller, so drafts, threads, streaming turns and pending
  confirmation identity remain intact.
- `createAssistantDockController` (`create-assistant-dock-controller.svelte.ts`)
  — headless runes state: threads, active thread, messages, pending sends,
  discovered surfaces, action lifecycle.
- `AssistantThreadList.svelte`, `AssistantComposer.svelte` — the composer
  implements its own compact attach control for attachment staging (a small
  icon-only attach `Button` plus a visually-hidden native
  `<input type="file">`) rather than reusing `shared/FileUpload.svelte`'s
  full dropzone/preview UI, which is sized for a dedicated upload panel, not
  a one-line composer (Copilot PR #2919 jAwxM — this recipe previously
  claimed the FileUpload reuse the shipped composer doesn't actually do).
- `assistant-transport.ts` — the `AssistantTransport` contract plus
  `createInMemoryAssistantTransport` and `createSmrtAssistantTransport`.
- `shared/ModelPicker.svelte` — extracted from
  `@happyvertical/smrt-content`'s `ContentAgentChat.svelte` (its `AI_MODELS` +
  `availableAIModels` filtering, `packages/content/src/svelte/components/ContentAgentChat.svelte:28-121`),
  and adopted by `AssistantDock` itself: the composer header renders
  `ModelPicker` whenever `AssistantTransport.listModels()` is defined
  (`controller.models.length > 0`), and the selected model id is threaded
  through `AssistantSendMessageInput.model` on every send.
  `ContentAgentChat` itself is **not** migrated to this component in this
  change (see "Gaps" below).

No new package dependency edge was needed: `@happyvertical/smrt-chat` already
depends on `@happyvertical/smrt-ui` (`packages/chat/package.json:89`), which
owns the canonical `DataSurfaceRegistry`/`DataSurfaceDescriptor` contracts
(re-exported from `@happyvertical/smrt-types`,
`packages/smrt-ui/src/components/data/data-surface.ts:11-76`). `AssistantDock`
does not import `smrt-svelte`.

## Floating presentation

Use `FloatingAssistant` when a host needs a compact launcher. It forwards the
entire `AssistantDock` public contract, including its transport, registry,
action client, browser tools and confirmation callbacks. Its `expanded` prop
is bindable; Escape collapses an expanded panel and returns focus to the
launcher. The collapsed panel remains mounted and inert.

```svelte
<script lang="ts">
  import {
    FloatingAssistant,
    createAssistantHttpTransport,
  } from '@happyvertical/smrt-chat/svelte';

  const transport = createAssistantHttpTransport({ endpoint: '/api/assistant' });
</script>

<FloatingAssistant {transport} {registry} contextMode="server" />
```

An optional `character` snippet receives `{ expanded, status, run }` through
the exported `FloatingAssistantPresentationState`. It has no animation, image,
audio, microphone or provider dependency. A host owns any character renderer
and maps these existing assistant events to its visual states.

For listening or subtitle-first pages, set `presentation="controls"`. The
dock omits its thread list, transcript and composer but keeps the supervised
run status, pending browser-tool confirmations, choice cards, data-action
review controls and retry controls. `onattentionchange` reports when a pending
tool or previewed action needs the person; `FloatingAssistant` automatically
reveals the same dock controls without making a decision itself. While a tool
request, previewed action, or unresolved action outcome requires attention,
Escape, the collapse button, and a host writing `expanded=false` cannot hide
those controls. The character snippet and launcher report the effective visible
state. After the decision, the host's requested collapsed state can take effect.

Host `visible=false` is separate from collapse: it hides the whole wrapper,
including the launcher, and pauses the dock's polling without unmounting its
controller or deciding pending actions. Setting `visible=true` restores it;
any pending attention still overrides `expanded=false` while the host is visible.

The `/previews/floating-assistant` workbench uses in-memory transport, tool,
choice, and action adapters. Its controls exercise Allow/Don't allow,
Confirm/Reject, choices, Stop, and failures against the dock's own controller;
no provider or microphone is contacted.

## Shell mounting recipe

`AssistantDock` takes a `DataSurfaceRegistry` and an `AssistantTransport` as
props; it discovers mounted surfaces by calling `registry.list()` and
subscribing to `registry.subscribe()` for `'registered'`/`'unregistered'`
events (`packages/types/src/data-surface.ts:336-349`) — routes register their
descriptors and unregister them on unmount, so the registry's current set IS
the active route's surfaces. An explicit `surfaces` prop can narrow live
discovery when a host wants to scope the dock manually — it is intersected
against `registry.list()`, so an identity named in `surfaces` that is not
genuinely registered is never treated as mounted (Copilot PR #2919 jAwr0).

The default `contextMode="data-surfaces"` keeps the empty-surface guidance for
route-aware assistants. Use `contextMode="server"` when the authenticated
transport supplies context and tools without browser data surfaces. Server
mode omits only that guidance: transport failures still render, the registry
remains the action mount gate, and no client tool is declared or run merely by
selecting the mode.

### Mounting the server side (#3368)

`@happyvertical/smrt-chat/sveltekit` serves everything the dock calls from one
SvelteKit rest route:

```ts
// src/routes/api/assistant/[...path]/+server.ts
import { mountAssistantRoutes } from '@happyvertical/smrt-chat/sveltekit';
import { runtime } from '$lib/server/smrt';

export const { GET, POST } = mountAssistantRoutes({
  // The only tools the model is offered: these manifest operations.
  allowedTools: ['notes.read', 'notes.create'],
  // Per-request database, and a turn lifetime of its own under database-rls.
  runtime,
});
```

With no `ai`, each turn builds its client from the `smrt.config` `ai` block
(`resolveConfiguredAIProvider` → `toAIClientOptions` → `getAI`; the key comes
from the variable `apiKeyEnv` names). Pass `ai` (a client or a per-turn
factory) to choose the client yourself.

```svelte
<script lang="ts">
  import {
    AssistantDock,
    createAssistantHttpActionClient,
    createAssistantHttpTransport,
  } from '@happyvertical/smrt-chat/svelte';

  const transport = createAssistantHttpTransport({ endpoint: '/api/assistant' });
  // Only when the host passes `actions: { adapter }` to mountAssistantRoutes:
  const actionClient = createAssistantHttpActionClient({ endpoint: '/api/assistant', registry });
</script>

<AssistantDock {transport} {registry} {actionClient} />
```

### Hiding the thread list (`threadList`)

By default the dock shows a "Conversations" list (a toggle in narrow
containers) beside the message thread. Pass `threadList={false}` for a
single-conversation surface: the toggle and list are not rendered and the
messages and composer take the full width at every container size.

```svelte
<AssistantDock {transport} {registry} threadList={false} oncontroller={open} />
```

Only the list goes. The dock still does not open or create a conversation for
you, and the composer stays disabled until one is active, so a host that hides
the list opens one itself from `oncontroller`. After `await controller.loadThreads()`,
open an existing thread with `await controller.openThread(id)`. For the first
conversation, create **and then open** the returned thread:

```ts
const thread = await controller.createThread('New conversation');
await controller.openThread(thread.id);
```

`createThread()` alone does not activate the conversation. Until a thread is
open, the empty state offers "Create conversation" when the transport
supports `createThread`, and never points at the omitted list.

| Route | Body | Answer |
|---|---|---|
| `GET threads` | — | `{ items: ThreadSummary[] }` |
| `POST threads` | `{ title }` | 201 `{ thread }` |
| `GET threads/:id/messages` | — | `{ items: Message[] }`, chronological |
| `POST threads/:id/messages` | `{ content, clientRequestId, attachments?, model?, clientTools? }` | SSE turn (a leading `message` event carries the stored user message), JSON `{ duplicate, inProgress, outcome, userMessage, assistantMessage?, messages }` for a `clientRequestId` already stored in this thread, or 409 `turn_failed` |
| `POST threads/:id/resume` | `{ continuationId, results, clientTools?, model? }` | SSE turn |
| `POST attachments` | multipart `file` | 201 `{ attachment }` |
| `POST actions/preview`, `actions/apply` | `DataSurfaceActionWireRequest` | `{ result }` |

Refusals are JSON `{ error, code }` with a user-safe `error`.

- **Principal.** Read from `event.locals` as `createSessionHandler`
  (`@happyvertical/smrt-users/sveltekit`) fills it: `user.id` runs tools,
  `user.profileId` is the chat actor, `tenantId` the active tenant. No user is
  401; no profile or tenant is 403. `resolvePrincipal` replaces this; nothing
  is read from headers or the body.
- **Scope.** Each actor has one assistant `AgentSession` per tenant
  (`agentId`, default `smrt-assistant`, session key `assistant-dock`). A
  thread is served only when it lives in that session's room, so another
  member's thread, another tenant's thread, or another room the actor belongs
  to answers 404. Reads never create a session.
- **Turns.** A send stores the user message (`ChatService.sendMessage`, with
  `clientRequestId` in `metadata`) and runs `runAssistantTurn`, whose reply is
  authored through the agent bridge. `ai` is a client or a per-turn factory;
  omitted, it is the `smrt.config` `ai` block through the shared resolver.
  A failing factory, or no configured provider
  (`AIProviderNotConfiguredError`, which names variables, never values, and
  goes only to `onError`), answers 503 before anything is written. Tools are
  fail-closed: `allowedTools` (absent = none) gates `extraTools`, `tools` and
  the action adapter, and every tool runs under `executeAsPrincipal`. Without
  `tools`, the route offers the manifest operations `allowedTools` names
  (`buildManifestToolCatalog`), minus names an `extraTools` entry serves; a
  name nothing provides is an error, at mount when its collection is already
  registered, otherwise a 503 turn (not checked when `actions` is set). `db`
  is a fixed value or a resolver called once per request (default with
  `runtime`: `() => runtime.databaseConfig()`). Browser tools need
  `clientToolAllowList`. Suspended turns wait in the session context
  (`createSessionContinuationStore`), keyed by thread; `continuations`
  replaces the store.
- **Turn lifetime under `database-rls`.** The request's RLS transaction
  commits when the handler returns its streaming response, before the model
  has answered, so a turn never keeps it. With `runtime`, the turn waits for
  that transaction to end, checks that the user message committed, and then
  runs its tools, stores its reply and records its outcome (including
  `cancelled`) in a transaction of its own for the same principal
  (`runtime.runAsPrincipal`). Its authority is the request's permission set,
  frozen before the response returns (an empty set stays empty), intersected
  with the permissions live when it binds: a grant made after the send is
  never acquired and a revoked one never regained. `client_tool_calls`, `done` and `error` reach
  the browser only after that transaction commits, so a resume or retry
  always finds what the turn stored. If that transaction fails, the send is
  recorded as `failed`. A request transaction still open after
  `turnStartTimeoutMs` (default 60 s) answers an error without running the
  turn; the route keeps watching it (up to `abandonedTurnMs`) and records a
  send that commits late as `failed`. Without `runtime`, the turn runs to completion inside
  the request before the response returns (its events then arrive at once).
  Outside an RLS transaction (SQLite, the local profile) turns stream as
  before.
- **Retries.** The user message's primary key is a UUIDv5 of tenant, room,
  thread, actor and `clientRequestId` (`clientRequestMessageId`), inserted
  (never upserted), so the database itself is the reservation: of any number
  of identical sends, on any replica and at any later time, one stores the
  message and runs the turn, and the rest get the JSON duplicate answer,
  looked up by that id (not by scanning recent messages).
  - **Replies belong to their send.** Every reply and tool message a turn
    writes carries `replyToMessageId` = the send's id, set server-side
    (`runAssistantTurn`'s `originMessageId`), and the duplicate answer reads
    replies by that link (`ChatService.getThreadMessageReplies`), never by
    position, so overlapping sends in one thread keep their own replies.
    Replies written before this link existed are not attributed to any
    send; sends without a `clientRequestId` are never looked up.
  - **Outcome, recorded by the turn.** The turn's state is kept on the user
    message (`metadata.turnOutcome`) and written by the runner itself
    (`runAssistantTurn`'s `onState`) when each fact becomes true, not from
    what the HTTP reader consumed: `running` when a leg starts (a resume:
    once it consumed its continuation), `suspended` with the continuation id
    once the continuation is stored and before the browser sees
    `client_tool_calls`, and `completed` (after the reply is stored),
    `cancelled` or `failed` when the leg ends. The route pumps every turn to
    its end whether or not a reader is still attached. Writes are
    compare-and-set on the row's revision and only move forward per leg
    (`unset → running → suspended(c) → running(from c) → … → terminal`); a
    late write from an earlier leg, a `running` that does not consume the
    waiting continuation, or anything after a terminal outcome is refused.
  - **Disconnects cancel.** A client that disconnects cancels the turn at
    its next model or tool boundary (a pending server tool call is skipped),
    the same as the dock's Stop, whether the adapter aborts the request's
    signal or only cancels the response body (`createAssistantTurnResponse`'s
    `onCancel`). The turn records `cancelled`, or `completed` when its reply
    was already stored. A stale-send retry is then answered from that
    record.
  - **Answers.** A linked `assistant` reply → `completed`, whatever the
    marker says: the runner stores exactly one per turn, at its end (tool
    results are role `tool`, intermediate model text and suspensions store
    none), so a crash between storing it and recording the outcome still
    answers `completed`. Otherwise: `cancelled` → `cancelled`; `failed` →
    409 `turn_failed`; `suspended` → `in_progress` for exactly as long as
    its continuation is waiting (`AssistantContinuationStore.has`; a custom
    store without `has` gets the default 15-minute continuation TTL), then
    409; not settled yet, or a leg `running` → `in_progress` until
    `abandonedTurnMs` (default 15 minutes) has passed since it started, then
    409. A retry never re-runs a turn: the person sends again, under a new
    id.
  - **Resumes.** A resume settles only the send recorded in the continuation
    it consumes (`originMessageId`, stored server-side when the turn
    suspended). The request's `clientRequestId` is ignored on resume, and a
    missing, foreign or expired continuation changes no send. The built-in
    stores' `take` claims the continuation instead of deleting it (no second
    `take` returns it, and `has` stays true) until the runner has recorded
    `running` and calls `release`, so a retry never sees a resuming send as
    failed. A claim lives 60 seconds from the claim, whatever the
    continuation's own lifetime. If `running` cannot be recorded, the leg
    never runs (error `resume_not_recorded`), the claim is kept, and the
    continuation can be resumed again once the claim lapses.
  - On a PostgreSQL transaction handle the insert runs under a savepoint so
    a conflict does not abort the transaction.
- **Limits.** JSON bodies are capped at 1 MiB (`maxBodyBytes`), messages at
  12,000 characters (`maxContentLength`), titles at 200, attachments at 10 per
  message. A requested model must be in `models` when a list is set and is
  ignored otherwise (`defaultModel` applies).
- **Attachments.** The package stores no files. Without `attachments:
  { upload, verify }` uploads answer 404 and sends with attachments 400.
  `verify` must check that every reference belongs to the principal; the
  stored record is what `verify` returns, never the request's copy.
- **Actions.** With `actions: { adapter }` the routes call
  `DataSurfaceActionAdapter.preview`/`apply` with
  `{ principal: { principal: { runAsUserId, tenantId, allowedTools }, onBehalfOfUserId } }`
  built from the principal. An adapter that throws on apply answers 500
  `outcome_unknown`. The HTTP action client sends the registry's current
  revision as `expectedRevision`, returns the server's result, maps an apply
  4xx to a refusal and lets an apply 5xx or network failure reject (an
  unknown outcome, retried with the same key).
- **Origin.** Mutations must be same-origin (`Origin`, else
  `Sec-Fetch-Site`, else `Referer`); `trustedOrigins` adds origins and
  `checkOrigin: false` turns it off for non-browser clients.

Tests: `packages/chat/src/sveltekit.test.ts` (routes and the browser transport
against the real handlers) and
`packages/chat/src/svelte/components/assistant/__tests__/assistant-http-client.test.ts`.

Consumers place `AssistantDock` inside their own shell's focus-tool
primitive. In this repository, smrt-svelte's `ShellDockTool`
(`packages/smrt-svelte/src/components/workspace/admin-shell/ShellDockTool.svelte`)
is the intended host:

```svelte
<script lang="ts">
  import { AppShell } from '@happyvertical/smrt-svelte/app';
  import { ShellDockTool } from '@happyvertical/smrt-svelte/workspace';
  import { AssistantDock, createSmrtAssistantTransport } from '@happyvertical/smrt-chat/svelte';
  import BotIcon from '$lib/BotIcon.svelte'; // optional: `icon` takes a component

  // `readEndpoint` must be a host-supplied, MEMBER-scoped endpoint — see
  // "Transport" below; it is never the generated ChatThread/ChatMessage
  // list REST routes directly.
  const transport = createSmrtAssistantTransport({ readEndpoint, token, writeEndpoint });
</script>

<AppShell webmcp={true} {...shellProps}>
  {#snippet dock(registry)}
    <ShellDockTool id="assistant" label="Assistant" icon={BotIcon}>
      {#snippet render()}
        <AssistantDock {transport} {registry} />
      {/snippet}
    </ShellDockTool>
  {/snippet}
  {@render children()}
</AppShell>
```

`AppShell` passes its `dock` snippet the `DataSurfaceRegistry` of the
`Provider` it mounts, the same instance the shell's routes register their
descriptors on (`useListSurface`, `useLinkSurface`, ... register there when
the Provider's WebMCP UI is on, i.e. `webmcp` is set). The host needs no
second registry and no direct `smrt-ui` dependency. Outside `AppShell`, read
the same registry in a Provider descendant with `useWebMcpUi().dataSurfaceRegistry`.

This keeps the smrt-svelte→smrt-chat edge out of the package dependency graph
entirely — it exists only in application code, matching the "no new
smrt-svelte→smrt-chat runtime edge" binding decision. See also
`packages/smrt-svelte/src/components/workspace/README.md` for the general
`ShellDockTool` recipe pattern this follows.

### Narrow docks (#3000)

The dock is a size container (`container-type: inline-size`), so its layout
follows the width it is given, not the viewport. At 480px and wider the
thread list sits beside the conversation. Below that, for example the
default ~250px `AdminShell` right edge or a portrait-tablet overlay, the
list collapses behind a "Conversations" disclosure button (`aria-expanded`,
`aria-controls`). When opened, the list stacks above the conversation, and
picking or starting a thread closes it again, so the conversation always
keeps the full dock width. Hosts don't need to widen the edge for the dock
to be usable. The composer textarea uses `--smrt-font-family`, the same
font as the rest of the dock.

When no conversation is active, the conversation area explains what is
needed instead of leaving a disabled composer above a blank body. Once the
thread list loads, an existing-conversation state opens the list and moves
focus to its first conversation without selecting it. An empty list offers
conversation creation only when the transport implements `createThread`;
otherwise it explains that no conversation is available. Initial loads and
context swaps show a loading status, and transport failures keep the existing
error banner without also showing stale or misleading first-use guidance.

jsdom ignores `@container`, so the widths are checked in Chromium by
`packages/chat/e2e/assistant-dock-narrow.spec.ts` against the
`/previews/assistant-dock-narrow` fixture. Run it with
`pnpm --filter @happyvertical/smrt-chat test:e2e`. It is not wired into CI
yet.

## Architecture

Sequence: `send → poll → render → action preview → confirm → apply`.

1. **Discovery.** `AssistantDock` reads `registry.list()` for the currently
   mounted `DataSurfaceDescriptor`s and stays current via
   `registry.subscribe()`.
2. **Tools.** (Not wired by this component directly — a host's chat backend
   is expected to call `createDataSurfaceTools`,
   `packages/agents/src/data-surface.ts:837`, scoped to the same descriptors,
   the same way the existing conformance test composes it,
   `packages/smrt-svelte/src/web/__tests__/data-surface-conformance.integration.svelte.test.ts:11-20`.)
3. **Action lifecycle.** A model's action proposal becomes a
   `DataSurfaceActionRequest` (`packages/types/src/data-surface.ts:256-266`,
   `phase: 'preview' | 'apply'`). The controller normalizes it
   (`normalizeDataSurfaceActionRequest`) and calls
   `AssistantActionClient.preview(request)`. The result renders through
   `ToolCallDisplay`'s new `actionResult` prop (preview/applied/failed). The
   apply `idempotencyKey` is minted exactly once, at preview time, and stored
   on the action's state (`AssistantActionState.idempotencyKey`) — not
   regenerated per apply attempt. On confirm, `applyAction(requestId)` reads
   that stored key and calls `AssistantActionClient.apply(request,
   idempotencyKey)`. This matters for retries: if a Confirm click times out
   client-side after the server actually applied the action, a second Confirm
   click reuses the same key so the server-side dedup
   (`DataSurfaceActionWireRequest.idempotencyKey`,
   `packages/types/src/data-surface.ts:274`) recognizes the replay instead of
   re-executing. Minting a fresh key per click (an earlier version of this
   component did) would defeat that dedup entirely.

### Correction from the phase-1 design note

The phase-1 design assumed action preview/apply would route through
`DataSurfaceCommandBridge.send()` (`packages/chat/src/data-surface-bridge.ts`).
That assumption was wrong and was corrected during build: the bridge is the
live-collaboration query/select command channel (see its own
`ackBridge`/`browser` tests in `data-surface-conformance.integration.svelte.test.ts`),
a different concern. The actual action pathway is
`DataSurfaceActionAdapter.preview()`/`.apply()`
(`@happyvertical/smrt-agents/server`, `createDataSurfaceActionAdapter`,
exercised directly at
`packages/smrt-svelte/src/web/__tests__/data-surface-conformance.integration.svelte.test.ts:1221-1441`).
That adapter is server-only — it needs a `DataSurfaceExecutionContext` with a
principal/tenant the browser cannot self-assert. `AssistantActionClient` is
therefore the client-side seam a host application implements (typically an
authenticated HTTP call to a server route wrapping the adapter); the package
ships the interface and, since #3368, an HTTP implementation
(`createAssistantHttpActionClient`, served by `mountAssistantRoutes`).

## Transport

`AssistantTransport` (`assistant-transport.ts`) is intentionally narrower than
`ChatClientBackend` (`packages/chat/src/client.ts`): `listThreads`,
`loadMessages` and `sendMessage`, plus optional `createThread` and
`uploadAttachment` capabilities.

- **Reads are host-endpoint scoped, never the raw generated list routes**
  (Copilot PR #2919 review, threads jAwqo/jAwrQ/jAwvV). `ChatThread`/
  `ChatMessage` are configured with `api: { include: ['list', 'get'] }` only
  (`packages/chat/src/models/ChatThread.ts:16`,
  `packages/chat/src/models/ChatMessage.ts:26`), and an earlier version of
  `createSmrtAssistantTransport` called those generated list routes directly.
  That was a real cross-tenant/cross-thread read: the generated handler
  enforces authentication and tenant scope only — the per-room MEMBERSHIP
  check lives in `ChatService.listRoomThreads`
  (`packages/chat/src/services/ChatService.ts:1042`) — and `threadId` isn't
  even a filter the generated list handler parses (only `limit`/`offset`),
  so every `loadMessages(threadId)` call returned the same latest
  tenant-wide page regardless of which thread was asked for.
  `createSmrtAssistantTransport` now **requires** a host-supplied,
  member-scoped `readEndpoint` and calls:
  - `GET {readEndpoint}/threads` for `listThreads()`
  - `GET {readEndpoint}/threads/{id}/messages` for `loadMessages(threadId)`

  Both must bind the endpoint's own authenticated actor/tenant/membership
  context server-side before returning rows — `ChatService.listRoomThreads`
  is the server-side building block a host's endpoint implementation should
  call to get that scoping for free.

  **Wire shape.** The documented contract is camelCase JSON, field names
  matching `AssistantThreadSummary`/`AssistantMessage` directly:
  `ThreadSummary: { id, title, isResolved, messageCount, lastMessageAt? }`;
  `Message: { id, threadId, content, role, createdAt, attachments?: { name,
  url?, size? }[] }`, returned in **chronological** (oldest-first) order.
  `normalizeAssistantThreadSummary`/`normalizeAssistantMessage`
  (`assistant-transport.ts`, exported for tests) are a defensive fallback,
  not a second contract: a host that wraps the raw generated-model JSON
  rather than writing a shape-converting endpoint commonly hands back
  snake_case (`created_at`, `thread_id`), a `ChatMessage.attachments` value
  that is still the stored JSON-encoded STRING with `filename` fields rather
  than a parsed `{ name }` array, and newest-first pagination order — all
  three are tolerated so `loadMessages` still resolves in-progress replies
  (the resolution check searches for an assistant/tool message AFTER the
  triggering user message, which fails silently against a newest-first list)
  and renders attachments/messages correctly either way.
- `createThread`/`sendMessage`/`uploadAttachment` have no generated `create`
  route to call (same `api: { include: ['list', 'get'] }` constraint).
  `createSmrtAssistantTransport` requires an explicit `writeEndpoint` (a
  `ChatService`-backed implementation the host supplies) for sending.
  `writeEndpoint.createThread` and `writeEndpoint.uploadAttachment` are
  optional: their presence advertises the capability, and the dock omits the
  corresponding New conversation or attachment control when absent. A direct
  controller `createThread()` call still rejects clearly when unsupported.
- `mountAssistantRoutes` (`@happyvertical/smrt-chat/sveltekit`) is the shipped
  server for both reads and writes, and `createAssistantHttpTransport` is
  `createSmrtAssistantTransport` pointed at it with the `writeEndpoint`
  filled in (see "Mounting the server side" above).
- `createInMemoryAssistantTransport` is a full, deterministic implementation
  for tests and demos.

`clientRequestId` (send-transport idempotency) and the data-surface
`idempotencyKey` (action-apply dedup,
`DataSurfaceActionWireRequest.idempotencyKey`,
`packages/types/src/data-surface.ts:274`) are distinct end-to-end and never
conflated, per the binding decision.

### Polling and stale-send recovery (anytown reconnaissance)

Read in full for this phase:
`packages/site-portal/src/lib/components/PortalChatTool.svelte` (anytown, read-only
checkout) and `apps/dashboard/src/lib/server/site-assistant.ts`.

- `clientRequestIdForDraft`/`clearPendingRequest`
  (`PortalChatTool.svelte:304-322`): a `clientRequestId` is generated once per
  distinct `(threadId, content, contextKey)` draft and reused on every retry
  of that exact draft until the send resolves (success or error), at which
  point it is cleared. `createAssistantDockController`'s `draftIds` map
  mirrors this exactly, keyed on `(threadId, content)` — including that an
  `inProgress` (still-unresolved) response must NOT clear the id. An earlier
  build cleared it on the `inProgress` branch too (#2904 review finding F5:
  a same-draft resend during that window minted a fresh id, defeating the
  transport's dedup); the id is now cleared only on terminal resolution
  (success, error, or the poll-detected reply-arrived transition).
- `payload.inProgress` (`PortalChatTool.svelte:391`) and `scheduleThreadPoll`
  (`PortalChatTool.svelte:339-353`): a still-processing send schedules a poll
  of the thread (there: a fixed 8 attempts at a 1500ms interval, stopping once
  an assistant/tool message appears after the triggering user message) rather
  than blocking. `site-assistant.ts` (server side) was read in full and does
  not itself expose a named "stale" or "reservation" concept under that
  vocabulary — anytown's recovery is purely the client-side fixed-attempt poll
  above, not a server-tracked reservation with an expiry.
- `createAssistantDockController` generalizes the fixed 8×1500ms poll into a
  configurable `activePollIntervalMs` (default 3000ms) /
  `idlePollIntervalMs` (default 15000ms), plus an **added** absolute
  `staleAfterMs` (default 90000ms) after which a still-processing pending send
  is marked `'stale'` in `pendingSends`; `AssistantDock` then offers a "Retry"
  button that calls `controller.retry(clientRequestId)`, reusing the identical
  id so the transport dedups it instead of creating a duplicate message —
  this absolute-timeout behavior is a generalization beyond what
  `PortalChatTool.svelte` does (it has no absolute timeout, only a bounded
  attempt count), disclosed here rather than claimed as observed anytown
  behavior.
- Polling pauses when `visible: false` is passed to the controller (dock
  hidden), and stops entirely via `controller.dispose()`/`AssistantDock`'s
  `$effect` cleanup.

## Tenant scoping

The dock only ever sees `DataSurfaceDescriptor`s that are (a) registered in
the `DataSurfaceRegistry` instance passed to it and (b) currently mounted
(entries are removed on unmount). With zero mounted surfaces, `surfaces` is
empty, the "no data surfaces mounted" notice renders, and
`previewAction`/`applyAction` reject client-side before ever reaching an
`AssistantActionClient` — see `isSurfaceMounted` in
`create-assistant-dock-controller.svelte.ts`. This is a fail-closed
construction, not a runtime permission check layered on top. The mount gate's
`surfaceKey()` keys on `kind`, `surfaceId`, **and** `subject` (mirroring the
registry's own `identityKey` tuple), so a same-kind/same-`surfaceId` identity
for a different subject — another tenant, site, or project instance — is
treated as a distinct, unmounted surface, not the same one (#2904 review F6).

## Reuse from ContentAgentChat

`ModelPicker.svelte` extracts `ContentAgentChat`'s model-selector logic
(`packages/content/src/svelte/components/ContentAgentChat.svelte:28-121`).
The field-update allow-list sanitizer
(`sanitizeContentEditorAssistantFieldUpdates`,
`packages/content/src/content-editor-assistant.ts`) is **not** adopted —
`AssistantDock`'s generic action path goes through
`normalizeDataSurfaceActionRequest` instead, which is the generic analog for
data-surface actions; the content-specific sanitizer stays specific to
`ContentAgentChat`'s field-update flow.

## Behavior-to-test matrix

Issue #3567 adds the following risk-based contract:

| Behavior/invariant | Reachable trigger | Positive case | Negative/failure case | Actor/context | Data executor/transaction | Supported runtime/dialect | External contract edge | Test level | Validation command |
|---|---|---|---|---|---|---|---|---|---|
| A loaded dock with existing threads and no active thread explains that a choice is required and opens/focuses the thread list | `listThreads()` resolves non-empty before the user selects a thread | “View conversations” opens the disclosure, focuses the first thread, and selecting it enables the composer | No thread is auto-selected; the composer remains disabled until `openThread()` succeeds | Dock user in the current host-authenticated server context | N/A — presentation reads the already-scoped transport; no mutation or transaction | Svelte DOM in the browser; SQL dialect N/A | Thread titles are opaque transport output; creation may be absent | Component DOM + accessibility | `pnpm --filter @happyvertical/smrt-chat exec vitest run src/svelte/components/assistant/__tests__/AssistantDock.test.ts` |
| Conversation creation is offered only as an advertised transport capability | `listThreads()` resolves empty with or without `createThread` | A full transport shows “Create conversation” and opens the created thread | A reduced transport renders no creation action; a rejected create remains covered by the existing error contract | Dock user in the current host-authenticated context | Host transport owns creation; controller preserves its existing retry/isolation behavior | Svelte DOM in the browser; SQL dialect N/A | Missing optional `createThread` is supported; upstream create failures use the existing alert | Component DOM + controller regression | Same focused component command plus `create-assistant-dock-controller.test.ts` in the package suite |
| Loading, failure, and context replacement cannot expose stale first-use guidance | Initial `listThreads()` or a live transport/context replacement | Loading is announced; the new context receives neutral guidance after its own list resolves | Errors suppress the empty state; old-context threads disappear and never become active in the replacement | Dock user switching host-provided tenant/workspace context | N/A — context epoch guards transport reads; no persistence change | Svelte DOM in the browser; SQL dialect N/A | Pending and rejecting `listThreads()` calls | Component DOM | `pnpm --filter @happyvertical/smrt-chat exec vitest run src/svelte/components/assistant/__tests__/AssistantDock.test.ts` |

Earlier contracts remain in force:

| Behavior | Test | Kind |
|---|---|---|
| `threadList={false}` renders neither the Conversations toggle nor the thread list, in wide and narrow containers; the empty state offers only "Create conversation" (no `aria-controls` to the omitted list); a host-opened conversation enables the composer; the default and `true` keep the list (#3405) | `packages/chat/src/svelte/components/assistant/__tests__/AssistantDock.test.ts`; `packages/chat/e2e/assistant-dock-narrow.spec.ts` (250px, 285px, 800px) | component + browser (#3405) |
| A transport may omit `createThread`; the dock then omits New conversation, while a direct controller call rejects without changing conversation state | `packages/chat/src/svelte/components/assistant/__tests__/AssistantDock.test.ts`; `create-assistant-dock-controller.test.ts` | component + unit (#3546) |
| A transport may omit `uploadAttachment`; the composer then has no attach/file/drop behavior, while full transports retain upload and its visible errors | `packages/chat/src/svelte/components/assistant/__tests__/AssistantComposer.test.ts`; `AssistantDock.test.ts` | component (#3546) |
| `contextMode="server"` omits only the irrelevant empty-data-surface guidance; transport errors remain visible and data-surface actions stay fail-closed | `packages/chat/src/svelte/components/assistant/__tests__/AssistantDock.test.ts`; `create-assistant-dock-controller.test.ts` | component + unit (#3546) |
| Replacing a full transport with a reduced transport removes unsupported controls and clears staged attachments; late list/open/send results from the old context cannot land | `packages/chat/src/svelte/components/assistant/__tests__/AssistantDock.test.ts`; `create-assistant-dock-controller.test.ts` | component + unit (#3546) |
| Fail-closed with an empty registry | `packages/chat/src/svelte/components/assistant/__tests__/create-assistant-dock-controller.test.ts` | unit |
| Mounted-surface discovery | same file | unit |
| Client-side rejection of an action on an unmounted surface | same file | unit |
| `clientRequestId` reuse across two `send()` calls for the same draft while it is still unresolved (`inProgress`) | same file | unit — asserts the transport observes the identical id both times, not merely that a post-resolution resend produces one call (#2904 review F5) |
| Stale-send marking + retry reusing the same `clientRequestId` | same file | unit (fake timers) |
| Selected model reaches the transport's `sendMessage` | same file | unit |
| `applyAction` reuses the `idempotencyKey` minted at preview across a retried apply | same file | unit |
| `applyAction` re-checks mount status and fails closed if the surface was unmounted after preview | same file | unit (#2904 review F2) |
| An outstanding previewed action is invalidated when its surface unregisters | same file | unit (#2904 review F2) |
| `startPolling`/`stopPolling` idempotency; `startPolling()` after `dispose()` is a no-op | same file | unit (#2904 review F3) |
| `dispose()` racing an in-flight `pollTick` does not re-arm the poll interval | same file | unit (#2904 review F3) |
| `AssistantDock`'s mount effect runs once (not per send); registry subscription survives a send through the mounted component | `packages/chat/src/svelte/components/assistant/__tests__/AssistantDock.test.ts` | svelte component (#2904 review F1) |
| `ToolCallDisplay` preview/applied/failed rendering | `packages/chat/src/svelte/components/agent/__tests__/ToolCallDisplay.test.ts` | svelte component |
| End-to-end: fail-closed DOM, live discovery + send/receive, preview→confirm→apply→registry `'command'` event | `packages/smrt-svelte/src/web/__tests__/assistant-dock.integration.svelte.test.ts` | svelte integration, conformance-style (mirrors `data-surface-conformance.integration.svelte.test.ts`) |
| `message.attachments` render as a chip/link list on the bubble, after both `send()` and `loadMessages()` | `packages/chat/src/svelte/components/assistant/__tests__/AssistantDock.test.ts`; also asserted end-to-end in `packages/smrt-svelte/src/web/__tests__/assistant-dock.integration.svelte.test.ts` | svelte component + integration (#2904 review, cycle-3 second final F1) |
| `ModelPicker`, `AssistantComposer`'s file input, and every AssistantDock-family component have an accessible name / pass `expectNoA11yViolations` | `packages/chat/src/svelte/components/shared/__tests__/ModelPicker.test.ts`, `AssistantComposer.test.ts`, `AssistantDock.test.ts`, `AssistantThreadList.test.ts` | svelte component (#2904 review, cycle-3 second final F2) |
| `createSmrtAssistantTransport` calls `GET {readEndpoint}/threads`/`.../threads/{id}/messages`, never a raw generated list route; `normalizeAssistantThreadSummary`/`normalizeAssistantMessage` tolerate snake_case fields, a JSON-string `attachments` column, and newest-first pagination | `packages/chat/src/svelte/components/assistant/__tests__/assistant-transport.test.ts` | unit (Copilot PR #2919 review, threads jAwqo/jAwrQ/jAwvV) |
| Composer draft seeding (`initialDraft`, `controller.setDraft`, bindable `AssistantComposer` `value`) never sends; `composerPlaceholder` is forwarded; `onActionSettled`/`onactionsettled` report applied, server- and user-rejected, and unknown outcomes | `packages/chat/src/svelte/components/assistant/__tests__/assistant-dock-draft-settled.test.ts` | unit + svelte component (#2991) |
| A registry (or transport) swap clears threads/activeThreadId/messages/pendingSends/actions and reloads from the new transport, discarding an old in-flight load; `surfaces` narrows against the live registry (an unregistered override entry is not mounted); `applyAction` permits only `previewed` or an apply-phase `failed` retry | `packages/chat/src/svelte/components/assistant/__tests__/create-assistant-dock-controller.test.ts` | unit (Copilot PR #2919 review, threads jAwsd/jAwr0/jAwwg) |

The integration test's harness follows the exemplar's stated scope: a real
`DataSurfaceRegistry` and a real `createAssistantDockController`/`AssistantDock`
are composed together; only the chat transport
(`createInMemoryAssistantTransport`) and the action client (a thin adapter
over the registry's own `execute()`) are in-process test doubles.

**Disclosed scope reduction:** the action preview/apply path in that test is
driven directly through `createAssistantDockController` rather than by having
a fake model reply trigger it through the rendered DOM — `AssistantDock` has
no built-in "parse this assistant message as an action proposal" parser (no
such parsing is specified by any binding decision for #2904); a host
application's own message-rendering logic is expected to call
`controller.previewAction(...)` when it recognizes an action proposal in a
reply. The test still exercises dock rendering, live registry discovery, and
send/poll through the DOM, and separately proves the full action pathway
against the real registry.

## Docs

This file, plus the shell-mounting recipe in
`packages/smrt-svelte/src/components/workspace/README.md` and a short note in
`packages/chat/AGENTS.md`. Linked from the root `README.md` documentation
index, next to `ui-surfaces.md`.

## Host extension points

### One conversation: `conversations="single"`

By default the dock shows a conversation list and lets the person start new
ones (`conversations="multiple"`). For an app where people should not have to
know about separate conversations, pass `conversations="single"`:

```svelte
<AssistantDock {transport} {registry} conversations="single" />
```

There is no list, no Conversations toggle, and no choose or start screens. Once
the thread list loads, the dock opens the transport's most recent thread
(newest `lastMessageAt`; a thread nobody has written to counts as newest), or
creates one silently when there is none, and opens the composer, focusing it
while `visible`. A failure to list, create, or open shows inline with a "Try
again" button. Once the conversation has messages, an icon-only "Clear
conversation" button starts a fresh thread (transports with `createThread`
only). A transport swap re-runs the same open-or-create step for the new
context.

### Rendering a message's `toolCallData` (#2988)

`AssistantMessage.toolCallData` is host-defined, so the dock doesn't render
it by default. There is no tool-call region, and the payload is never
stringified or injected as HTML. To render it, pass a `toolCall` snippet.
The dock calls it only for messages whose `toolCallData` is set, and puts
the output inside that message's own `MessageBubble`, below its text:

```svelte
<AssistantDock {transport} {registry}>
  {#snippet toolCall(message)}
    <CandidateCard data={message.toolCallData} />
  {/snippet}
</AssistantDock>
```

Validate the payload's shape in the snippet, and render it with ordinary
Svelte markup, never `{@html}`.

### Proposing an action and observing the result (#2989)

The dock creates its own controller. `oncontroller` hands that controller
to the host once, on mount. The host proposes an action with
`controller.previewAction(request)`. The proposal renders with
Confirm/Reject, and the dock still owns apply, the idempotency key, and the
mount checks. `onactionapplied(request, result)` fires once for each apply
the server accepts. Read ids and details from `result`, the server's own
apply result, never from the request you sent:

```svelte
<AssistantDock
  {transport}
  {registry}
  {actionClient}
  oncontroller={(c) => (dock = c)}
  onactionapplied={(_request, result) => refreshPanel(result.details)}
/>
```

`onactionapplied` doesn't fire for a refusal, a failed or unknown outcome,
or an apply whose registry or transport was swapped while it was in flight.
A throw from it is caught. Hosts that build the controller themselves pass
the same callback as `onActionApplied` to `createAssistantDockController`.
The dock doesn't derive proposals from `toolCallData` on its own. The host
decides which assistant turns become proposals.

### Refused vs. unknown apply outcomes (#2990)

An apply can end in two ways:

- **Refused.** The server decided and said no. `status: 'failed'` and
  `outcomeUnknown: false`. Examples: `denied`, `not_found`,
  `stale_revision`, `idempotency_conflict`, or any `confirmation_*` reason.
  A decision was reached, so `rejectAction` may discard it. `retryable`
  keeps its existing meaning ("an apply attempt failed"). A same-key
  retry of a refusal can't mutate; it only gets the refusal again or
  `idempotency_conflict`. The dock doesn't offer that retry.
- **Unknown.** No decision was reached, so the mutation may have committed.
  `status: 'failed'`, `outcomeUnknown: true`, `retryable: true`. This
  happens when `actionClient.apply` rejects (transport failure, 5xx,
  timeout), or when it resolves `{ ok: false, reason }` with a reason in
  `ASSISTANT_ACTION_UNKNOWN_OUTCOME_REASONS` (`idempotency_in_progress`,
  `outcome_unknown`). An action client reports "no decision" in either of
  those two ways. For example, it can map an HTTP 5xx to
  `'outcome_unknown'`.

Until an apply gets a decision, the entry keeps its idempotency key.
`applyAction` retries it with that same key, so the server replays the
earlier attempt and can't mutate twice. Duplicate retries in flight at once
collapse into one call. `rejectAction` is refused while an apply is in
flight or its outcome is unknown, and so is a new `previewAction` for the
same request id. Either one would drop the only key that keeps a retry
safe. In this state the dock shows a notice and a **Check again** button,
and no Reject. A decision on a later attempt clears `outcomeUnknown`.

A registry or transport swap, such as a tenant change, still clears every
action, including unknown ones. A key taken under the old context is never
valid against the new one. Reconciling it after switching back is not
handled (see Gaps).

### Observing every action outcome (#2991)

`onactionsettled(request, outcome)` (controller option `onActionSettled`)
fires each time a proposed action reaches an outcome, so a host can update
its own UI without watching `controller.actions` in an `$effect`.
`outcome` is an `AssistantActionOutcome`:

| `outcome` | When |
|---|---|
| `{ status: 'applied', result }` | The server accepted the apply. Fires after `onactionapplied`. |
| `{ status: 'rejected', by: 'server', result }` | The server decided and refused; `result.reason` says why. |
| `{ status: 'rejected', by: 'user' }` | The user discarded the proposal (a `rejectAction` that was not refused). |
| `{ status: 'unknown', result?, error? }` | No decision (see above). The retry reports its own outcome later. |

It covers apply outcomes and user rejects only. It doesn't fire for a
preview that fails, is refused, or is invalidated because its surface
unmounted (the host that called `previewAction` reads
`controller.actions.get(requestId)` once it resolves), for a refused
`rejectAction`, for an apply that never reached the server (surface not
mounted), or for an outcome whose registry or transport was swapped while
it was in flight. A throw from it is caught.
Only `applied` is positive evidence of a change; treat `unknown` as "may
have landed" and never as success or failure. `onactionapplied` is
unchanged.

### Seeding the composer draft and placeholder (#2991)

`initialDraft` seeds the composer on mount, for example with a prompt the
host computed for the item being edited. `controller.setDraft(text)`
replaces the draft later, and `controller.draft` reads it back, including
what the user typed. Neither ever sends: the user edits and sends it. The
draft clears after a send the transport accepted, and it survives a
registry or transport swap because it is the user's unsent text.
`composerPlaceholder` is forwarded to the composer's textarea. Standalone
`AssistantComposer` takes the same draft as a bindable `value` prop.

```svelte
<AssistantDock
  {transport}
  {registry}
  initialDraft={initialPrompt}
  composerPlaceholder="Describe the image edit to generate…"
  oncontroller={(c) => (dock = c)}
  onactionsettled={(_request, outcome) => updatePanel(outcome)}
/>
```

## Streamed turns and browser tools (#2908)

The dock can run a real model tool loop and show it live. Three pieces:

**Server engine.** `runAssistantTurn(options)` (`packages/chat/src/assistant-turn.ts`,
package index) runs one turn over `runToolLoop` and yields
`AssistantTurnEvent`s; `createAssistantTurnResponse(events)` wraps them as
`text/event-stream`. The host route authenticates, persists the user message,
and passes an already-authorized `principal`:

- `extraTools` / `tools` are server tools, narrowed to
  `principal.allowedTools` (offer gate) and re-asserted by each tool
  (execution gate). `maxSteps` bounds the turn, `signal` cancels it
  (pass the request's own abort signal), and `onUsage` reports each model
  round's tokens for the host's usage attribution.
- `clientTools` are the page's browser tools, declared by the request body.
  They are untrusted: pass them through
  `sanitizeClientToolDeclarations(body.clientTools, allowList)` first
  (name/schema/size checks, an unknown effect becomes `destructive`, and
  `allowList` entries match exactly or as `prefix*`). A server tool wins a
  name clash.
- When the model calls a browser tool the turn **suspends**: the transcript
  goes into the host's `AssistantContinuationStore` (for example
  `createSessionContinuationStore(agentSession)`, which keeps it in the
  session's `sessionContext`, keyed by thread) and the stream ends with a
  `client_tool_calls` event. The browser answers with
  `resume: { continuationId, results }`. Continuations are single-use and
  expire after 15 minutes; `maxSteps` spans every leg. Results reach the model
  wrapped `{ untrusted: true, … }`, and the system prompt says so
  (`CLIENT_TOOL_RESULT_GUIDANCE`).
- `author` persists through the trusted `sendAgentReply` bridge: the reply,
  plus any server tool invocation `authorInvocation` maps to a message (its
  tool name must be on the session's `allowedTools`).

Events (`@happyvertical/smrt-chat/assistant-turn`, browser-safe):
`status` (`AssistantStatus`), `token` (a live preview only), `step`
(`thinking`, `tool_call`, `tool_result`, each with a plain label), `message`
(a persisted message), and exactly one terminal `done`, `error`, or
`client_tool_calls`.

An `error` event carries a message safe to show the user and a stable
`code`. Only an `AssistantTurnUserError` (an expired step, an empty message,
an ended session) reaches the browser verbatim; any other failure is sent as
`ASSISTANT_TURN_GENERIC_ERROR` with `code: 'internal_error'`, and its detail
goes to `onError` (on `runAssistantTurn` and `createAssistantTurnResponse`,
default `console.error`) on the server.

**Transport.** `AssistantSendMessageInput` gains `clientTools`, `onEvent`, and
`signal`; `AssistantSendMessageResult` gains `messages` and
`clientToolCalls`; a streaming transport adds `resumeTurn`. A host transport
whose route answers `text/event-stream` turns the response into a result with
`readAssistantTurnResult(response, { mapMessage, onEvent })`.
`createSmrtAssistantTransport` passes `writeEndpoint.resumeTurn` through.

**Dock.** Pass `pageTools` — the page's WebMCP registry from
`installWebMcpPageToolRegistry()` (`@happyvertical/smrt-web/webmcp-page-tools`,
see `docs/content/webmcp-integration.md`), so the in-page assistant offers the
model exactly the tools an outside agent sees. The dock runs each call
through that registry, deciding from the registry's own description of the
tool, never the server's echo:

| Effect | Behaviour |
|---|---|
| `read` | runs |
| `write` the registry marks `proposal: true` | runs — only compiled view intents and the fixed `smrt_ui_*` tools carry that module-private brand (`markWebMcpProposalTool`); they only stage a value or dispatch a registry command as `source: 'agent'`, so the change stays a proposal the user applies. The `owner` label (`ui`/`intent`) is diagnostic and never grants this |
| any other `write` | waits for **Allow** / **Don't allow** in the dock |
| `destructive` | always waits, whatever `clientToolPolicy` says |

A declined call reaches the model as `{ ok: false, error: 'declined' }`.
With an `actionClient` and a mounted surface that has actions, the dock also
offers its own `assistant_propose_action` tool: the model proposes a
data-surface action, the dock previews it, and it renders with the usual
Confirm/Reject — nothing changes until the user confirms. Add that name to the
server's browser-tool allow-list to offer it.

`controller.status` is the generic `AssistantStatus`
(`{ state: 'idle' | 'working' | 'done' | 'error', label, changes?, cancellable? }`)
covering turns, waiting tool calls, and action preview/apply; `onstatus`
reports every change, for a host's own "working" line.
`controller.cancel()` (the dock's **Stop**) aborts the stream and declines
waiting calls. `controller.steps` and `controller.streamingText` expose the
live progress; the dock renders the status line, the reply preview, and the
waiting calls itself.

Tests: `src/assistant-turn.test.ts` (loop suspension/resume, bounds,
allow-lists, cancel, continuations, SSE round trip) and
`src/svelte/components/assistant/__tests__/assistant-dock-client-tools.test.ts`
(effect rules, decline/allow, cancel, status, the proposal tool).

## Supervised runs: "watch it work"

The dock keeps one **run** per send, for hosts that hide the chat while the
assistant works and show a status instead (Anytown's watch mode).

- **Budgets (server).** `runAssistantTurn` takes `maxTurnTokens` and
  `maxTurnMs` besides `maxSteps`; all three span every browser round trip
  (the continuation carries `tokens` and `startedAt`). When one runs out the
  model gets a last round without tools and the turn ends with
  `stoppedReason: 'budget'` (or `'max_steps'`). `describeTool(name, args)`
  also gets a call's arguments, so a step can say "Opening Events".
- **Settle (browser).** After a step's browser tools ran, the dock waits before
  resuming: the host `settle` hook (e.g. "SvelteKit is no longer
  navigating"), navigations tracked on the registry (`registerLinkSurface`
  tracks its `navigate` promise; bespoke surfaces call
  `trackSurfaceNavigation`), and a quiet period in the registry and
  `pageTools` (`whenSurfaceNavigationSettled`, `@happyvertical/smrt-ui/data`),
  bounded by `settleTimeoutMs` (5 s). The next step is offered the new page's
  tools.
- **Run state.** `controller.run` / `onrun`: `{ id, goal, state, step,
  stepCount, pageTools, waitingFor, stoppedReason, error, startedAt, endedAt }`.
  `state` is `running`, `paused`, `waiting`, `done`, `failed` or `cancelled`.
  `waitingFor.kind` says what the person is needed for: `confirm` (a call
  waits for Allow), `choice` / `review` (a host hold, a previewed action, or
  a staged proposal-only write), or `continue` (a step or budget limit).
  `acknowledgeRun()` clears the staged/limit waits once the person has seen
  them; `dismissRun()` forgets a finished run.
- **Pause.** `pauseRun()` holds the next step (before the page tools run and
  before the resume); `continueRun()` releases it. A pause longer than
  `maxPauseMs` (default 15 min; match the continuation TTL) stops the run with
  `stoppedReason: 'paused_too_long'`.
- **Holds: choices the person makes.** `holdForUser({ id, kind: 'choice' |
  'review' | 'confirm', label })` registers a decision the host waits on; the
  run is `waiting` until the returned release function runs. This is the seam
  for "the assistant presents choices, the person picks".
- **Tool filter.** `clientToolFilter` (option and prop) removes page tools
  from what the dock declares and runs — for a person's own setting such as
  "don't move around the site". The server should narrow too.
- **Focus.** An agent never moves keyboard focus: a control `focus` command
  from `source: 'agent'` reveals and highlights instead (smrt-ui control
  registry).

Show the run with smrt-ui `WorkingStrip` (`variant="floating"` or `"strip"`,
phases `working | paused | waiting | done | failed | cancelled`, `goal`,
`onpause` / `onresume` / `onreview` / `onstop` / `onopen` / `ondismiss`).
Propose/apply is unchanged: a run that stages a value ends `waiting` for
review, never applied.

Tests: `assistant-dock-run.test.ts`, `assistant-dock-settle.test.ts`,
`src/assistant-turn.test.ts` (budgets, labels).

## Choices: offer a few options, the person picks one

For work with several good answers ("crop this tighter", "find me a picture of
the arena") a page registers an `AssistantChoiceSource` on a registry from
`createAssistantChoiceSourceRegistry()` and passes it to the dock as
`choiceSources`. Each source is offered to the model as a `read` browser tool,
`assistant_offer_<source id>` (add `assistant_offer_*` to the server's
browser-tool allow-list):

- the model calls it with the source's own `inputSchema` arguments;
- the dock asks the **source** for 1–4 options (`offer`) — the model never
  supplies them — and shows them as cards in the chat (label, optional
  description, optional same-origin preview image: anything but a `/…` path
  is dropped);
- the model gets back only `{ offered, waitingForUser, options: [{ id, label }] }`;
- nothing changes until the person clicks a card: the dock then calls the
  source's `apply(option)` in the page, as the person. "None of these"
  dismisses, a failed apply can be picked again, and a new message replaces an
  offer still waiting.

`controller.choices`, `controller.chooseOption(setId, optionId)` and
`controller.dismissChoices(setId)` expose the same state headlessly. While an
offer waits, `status` is `{ state: 'done', label: 'Pick one of the options' }`.
Each open offer is also a `choice` hold (`holdForUser`, see "Supervised runs"),
so a supervised run is `waiting` for the person until they pick or dismiss it.

**Options that take a while** (generated pictures, a slow search): `offer`
returns `pending: { message, expected, fill(update, signal) }` with the ready
options (possibly none). The cards show the plain `message` and `expected`
"Making…" placeholders; `fill` calls `update.add(options)` as each finishes
(normalized, at most 4 in the offer) and `update.status(message)` to change the
line, and resolves when there are no more. The model gets
`{ offered, waitingForUser, stillMaking: true, progress, options }` right away,
so it can tell the person how long it takes. The person can pick any option
that has arrived; picking, "None of these" or clearing the conversation aborts
`signal` (stop polling). If `fill` throws, its plain message shows under the
cards (`note`), or, when nothing arrived, the offer becomes `unavailable` with
that message. While nothing is ready, `status` is `working` with the progress
line. Such an offer is not replaced by the person's next message (the work
cost something); only they dismiss it.

## Gaps / follow-ups

1. **Closed by #3368.** `createAssistantHttpActionClient` is the HTTP
   `AssistantActionClient`, served by `mountAssistantRoutes`' `actions/*`
   over a host-supplied `DataSurfaceActionAdapter` (the adapter's surfaces
   and state store stay host-owned).
2. **`ChatClientBackend` (`packages/chat/src/client.ts`) was not extended.**
   `AssistantTransport` is a separate, narrower contract by design (see
   "Transport" above) rather than widening the existing streaming-oriented
   interface — flagged in phase 1 as an open interface-design question and
   resolved by not touching `ChatClientBackend` at all in this change.
3. **`ContentAgentChat` is not migrated to the shared `ModelPicker`.**
   Behavior-preserving refactor of a different package's shipped component;
   left as a follow-up so this change stays additive-only.
4. **No `ModuleUIRegistry` registration for `AssistantDock`/`AssistantThreadList`/
   `AssistantComposer`.** Every other `@happyvertical/smrt-chat` svelte
   component self-registers with `ModuleUIRegistry`
   (`packages/chat/src/svelte/index.ts`); the new assistant components were
   left out of that registration in this change and are direct-import-only.
   Low-risk addition for a follow-up.
5. **Consumer adoption note (anytown#1214).** anytown's phase 7 composes
   `AssistantDock`/`createAssistantDockController` with its own shell and its
   own route-discovered `DataSurfaceDescriptor`s, the same pattern
   `PortalChatTool.svelte`'s `assistantStore` already uses for a global dock
   mount. No anytown-specific API was added to this package.
6. **Streaming shipped with #2908** — see "Streamed turns and browser
   tools" below.
7. **Closed by #3368.** `mountAssistantRoutes` implements
   `GET {readEndpoint}/threads` and `GET {readEndpoint}/threads/{id}/messages`
   with `ChatService.listRoomThreads`/`getThreadMessages`, scoped to the
   actor's own assistant session room in the active tenant.
8. **Unknown apply outcomes don't survive a context swap (#2990).** A
   registry or transport swap clears `actions`, including entries with
   `outcomeUnknown`, because old-context state must never render in the
   new context. If the host switches back and proposes the same action
   again, it gets a fresh idempotency key. Retaining unknown outcomes per
   context without leaking them across the swap boundary needs its own
   design.
