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
- `createAssistantDockController` (`create-assistant-dock-controller.svelte.ts`)
  — headless runes state: threads, active thread, messages, pending sends,
  discovered surfaces, action lifecycle.
- `AssistantThreadList.svelte`, `AssistantComposer.svelte` (reuses
  `shared/FileUpload.svelte` for attachment staging).
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

## Shell mounting recipe

`AssistantDock` takes a `DataSurfaceRegistry` and an `AssistantTransport` as
props; it discovers mounted surfaces by calling `registry.list()` and
subscribing to `registry.subscribe()` for `'registered'`/`'unregistered'`
events (`packages/types/src/data-surface.ts:336-349`) — routes register their
descriptors and unregister them on unmount, so the registry's current set IS
the active route's surfaces. An explicit `surfaces` prop can override live
discovery when a host wants to scope the dock manually.

Consumers place `AssistantDock` inside their own shell's focus-tool
primitive. In this repository, smrt-svelte's `ShellDockTool`
(`packages/smrt-svelte/src/components/workspace/admin-shell/ShellDockTool.svelte`)
is the intended host:

```svelte
<script lang="ts">
  import { ShellDockTool } from '@happyvertical/smrt-svelte/workspace';
  import { AssistantDock } from '@happyvertical/smrt-chat/svelte';
  import { createSmrtAssistantTransport } from '@happyvertical/smrt-chat/svelte';

  // `registry` is the same DataSurfaceRegistry instance the shell's mounted
  // routes register their descriptors on (see smrt-svelte/src/data-surface.ts).
  const transport = createSmrtAssistantTransport({ baseUrl, token, writeEndpoint });
</script>

<ShellDockTool id="assistant" label="Assistant" icon="bot">
  {#snippet render()}
    <AssistantDock {transport} {registry} />
  {/snippet}
</ShellDockTool>
```

This keeps the smrt-svelte→smrt-chat edge out of the package dependency graph
entirely — it exists only in application code, matching the "no new
smrt-svelte→smrt-chat runtime edge" binding decision. See also
`packages/smrt-svelte/src/components/workspace/README.md` for the general
`ShellDockTool` recipe pattern this follows.

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
ships the interface but not an HTTP implementation (see "Gaps").

## Transport

`AssistantTransport` (`assistant-transport.ts`) is intentionally narrower than
`ChatClientBackend` (`packages/chat/src/client.ts`): `listThreads`,
`createThread`, `loadMessages`, `sendMessage`, `uploadAttachment`.

- `ChatThread`/`ChatMessage` are configured with `api: { include: ['list', 'get'] }`
  only (`packages/chat/src/models/ChatThread.ts:16`,
  `packages/chat/src/models/ChatMessage.ts:26`), so `createSmrtAssistantTransport`
  can serve `listThreads`/`loadMessages` from the generated REST routes
  directly, but `createThread`/`sendMessage`/`uploadAttachment` have no
  generated `create` route to call. `createSmrtAssistantTransport` requires an
  explicit `writeEndpoint` (a `ChatService`-backed implementation the host
  supplies) for those three and throws a descriptive error if it is missing,
  rather than silently no-opping.
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
construction, not a runtime permission check layered on top.

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

| Behavior | Test | Kind |
|---|---|---|
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

## Gaps / follow-ups

1. **`AssistantActionClient` has no shipped HTTP implementation.** The
   package provides the interface (`preview`/`apply`) and the in-process test
   double; a host application must supply the authenticated call to its own
   server route wrapping `DataSurfaceActionAdapter`. This mirrors the same gap
   already documented for `AssistantTransport.sendMessage`/`createThread`
   (no generated REST `create` route on `ChatThread`/`ChatMessage`).
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
6. **Streaming remains out of scope**, tracked separately as #2908.
