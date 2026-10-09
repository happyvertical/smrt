<script lang="ts">
/**
 * AssistantDock - shell-mounted, route-aware assistant surface (#2904).
 *
 * Consumers mount this inside a host shell's own focus-tool primitive, e.g.
 * smrt-svelte's `ShellDockTool` (see docs/assistant-dock.md "Shell mounting
 * recipe"). This component does not import smrt-svelte — it only needs a
 * `DataSurfaceRegistry` instance (already owned by the host shell) and an
 * `AssistantTransport`.
 */
import { MessageBubble } from '@happyvertical/smrt-ui/chat';
import type {
  DataSurfaceActionRequest,
  DataSurfaceActionResult,
  DataSurfaceIdentity,
  DataSurfaceRegistry,
} from '@happyvertical/smrt-ui/data-surface';
import type {
  DictationSourceProvider,
  DictationTranscribe,
  HandsFreeCaptureFactory,
  HandsFreeVadOptions,
} from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { type Snippet, tick, untrack } from 'svelte';
import type { AssistantStatus } from '../../../assistant-turn-events.js';
import { M } from '../../i18n.js';
import ToolCallDisplay from '../agent/ToolCallDisplay.svelte';
import ModelPicker from '../shared/ModelPicker.svelte';
import AssistantChoiceCards from './AssistantChoiceCards.svelte';
import AssistantComposer from './AssistantComposer.svelte';
import AssistantThreadList from './AssistantThreadList.svelte';
import { toolCallStatusForAction } from './action-status.js';
import type { AssistantChoiceSourceRegistry } from './assistant-choices.svelte.js';
import type {
  AssistantAttachmentRef,
  AssistantMessage,
  AssistantTransport,
} from './assistant-transport.js';
import { safeAttachmentHref } from './attachment-href.js';
import {
  type AssistantClientTool,
  type AssistantClientToolPolicy,
  type AssistantClientToolSource,
  defaultClientToolPolicy,
} from './client-tools.js';
import {
  type AssistantActionClient,
  type AssistantActionOutcome,
  type AssistantDockController,
  type AssistantRun,
  createAssistantDockController,
} from './create-assistant-dock-controller.svelte.js';

// AssistantMessage.role is 'user' | 'assistant' | 'system' | 'tool'.
// MessageBubble's canonical styling axes are `variant` ('default' | 'agent' |
// 'system') + `own` — used directly (rather than its legacy `role` prop,
// whose narrower type isn't exported from `@happyvertical/smrt-ui/chat`) so
// messages render with the package's own bubble styling instead of raw
// "role: content" text (#2904 review fix). Tool output renders with the
// agent's tone.
function bubbleVariant(
  role: AssistantMessage['role'],
): 'default' | 'agent' | 'system' {
  if (role === 'system') return 'system';
  if (role === 'user') return 'default';
  return 'agent';
}

// Cycle-3 second final finding 1: message.attachments was populated by the
// transport (sendMessage/loadMessages) but never rendered anywhere — a
// staged, uploaded, and sent attachment became permanently invisible once
// the composer's chip row cleared on send. Same non-i18n unit formatting
// precedent as ../shared/FileUpload.svelte's own formatSize().
function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface Props {
  /** Thread/message I/O backend; see `./assistant-transport.js`. */
  transport: AssistantTransport;
  /** The host shell's `DataSurfaceRegistry` instance — the dock discovers
   * currently-mounted surfaces from this and fails closed when none are
   * registered. */
  registry: DataSurfaceRegistry;
  /** Where the assistant obtains its working context. `data-surfaces` keeps
   * the route-surface guidance; `server` is for transports whose authenticated
   * backend supplies context and tools without browser data surfaces. */
  contextMode?: 'data-surfaces' | 'server';
  /** Client-side seam to a server-hosted `DataSurfaceActionAdapter`; required
   * to preview/apply proposed actions, optional for plain chat. */
  actionClient?: AssistantActionClient;
  /** Explicit surface narrowing filter (#2904 review finding 1; narrowed
   * against the live registry per Copilot PR #2919 jAwr0): when set, the
   * dock scopes discovery AND the preview/apply mount gate to the
   * INTERSECTION of this list and `registry.list()` — an identity present
   * here but not genuinely registered is never mounted. `registry` is still
   * required (both for that intersection and for `syncRegistry`'s swap
   * handling). Documented in `docs/assistant-dock.md` "Tenant scoping";
   * previously only reachable by constructing `createAssistantDockController`
   * directly, which this component itself does not expose. */
  surfaces?: DataSurfaceIdentity[];
  /** Whether the dock is currently visible; polling pauses while false. */
  visible?: boolean;
  /** How the dock presents conversations. `multiple` (default) shows the
   * conversation list and lets the person start new ones. `single` is for
   * hosts where the person never needs to know about separate conversations:
   * no list, no toggle, no choose/empty screens. On mount the dock reuses the
   * transport's most recent thread, or creates one silently when there is
   * none, and opens straight into the composer (focused while `visible`). A
   * failure shows inline with a retry; a small icon-only "Clear
   * conversation" action starts fresh when the transport can create
   * threads. */
  conversations?: 'multiple' | 'single';
  /** Whether the dock shows its "Conversations" toggle and thread list
   * (#3405). Default `true`. With `false` the dock is a single running
   * conversation: the message thread and the composer fill the full width, in
   * wide and narrow containers alike. Nothing else changes — the dock does
   * not open or create a conversation for you, so a host that hides the list
   * opens one itself through `oncontroller`: load threads, then call
   * `openThread(id)`. For a new conversation, await `createThread(title)` and then
   * `openThread(thread.id)` with its result; creation alone does not activate
   * the conversation. Until a conversation is active the
   * composer stays disabled and the empty state offers "Create
   * conversation" (when the transport supports `createThread`); it never
   * points at the omitted list. */
  threadList?: boolean;
  /** Renders a message's own `toolCallData` (#2988), inside that message's
   * bubble below its text. Called only for messages whose `toolCallData` is
   * set. Without it the dock renders no tool-call region at all: the payload
   * is host-defined, so the dock never stringifies it or injects it as HTML.
   * Render it with ordinary Svelte markup in the host's own snippet. */
  toolCall?: Snippet<[AssistantMessage]>;
  /** Hands the host this dock's own controller once, on mount (#2989), so it
   * can propose an action with `controller.previewAction(request)`. The
   * proposal renders with Confirm/Reject like any other; everything else
   * (apply, the idempotency key, mount checks) stays with the dock. */
  oncontroller?: (controller: AssistantDockController) => void;
  /** Called after the server accepts an apply (#2989). See
   * `AssistantDockControllerOptions.onActionApplied`. */
  onactionapplied?: (
    request: DataSurfaceActionRequest,
    result: DataSurfaceActionResult,
  ) => void;
  /** Called each time a proposed action reaches an outcome (#2991): applied,
   * rejected (by the server or the user), or unknown. See
   * `AssistantDockControllerOptions.onActionSettled`. */
  onactionsettled?: (
    request: DataSurfaceActionRequest,
    outcome: AssistantActionOutcome,
  ) => void;
  /** Initial composer draft (#2991), for example a prompt computed for the
   * item being edited. Read once, on mount; the user edits and sends it.
   * It is never sent on their behalf. To replace it later, call
   * `controller.setDraft(text)` from `oncontroller`. */
  initialDraft?: string;
  /** Placeholder for the composer's empty textarea (#2991). Defaults to the
   * composer's own placeholder. */
  composerPlaceholder?: string;
  /** The page's browser tools (#2908) — typically
   * `installWebMcpPageToolRegistry()` from
   * `@happyvertical/smrt-web/webmcp-page-tools`. Offered to the model each
   * turn; see `./client-tools.ts` for when a call waits for the user. */
  pageTools?: AssistantClientToolSource;
  /** Narrows when a browser tool call waits for the user (#2908).
   * Destructive calls always wait. */
  clientToolPolicy?: (tool: AssistantClientTool) => AssistantClientToolPolicy;
  /** Called whenever the assistant's generic status changes (#2908), for a
   * host's own "working" line. Also readable as `controller.status`. */
  onstatus?: (status: AssistantStatus) => void;
  /** Waits for the page to settle after a step's browser tools ran, before
   * the turn resumes. See `AssistantDockControllerOptions.settle`. */
  settle?: () => Promise<void> | void;
  /** Narrows the page tools the dock declares and runs (e.g. a person's
   * setting). See `AssistantDockControllerOptions.clientToolFilter`. */
  clientToolFilter?: (tool: AssistantClientTool) => boolean;
  /** How long a paused run may wait before it stops. Default 15 min. */
  maxPauseMs?: number;
  /** Called whenever the supervised run changes (#assistant-watch). Also
   * readable as `controller.run`. */
  onrun?: (run: AssistantRun | null) => void;
  /** Page features that can offer a few options for the person to pick
   * (see `./assistant-choices.svelte.ts`). The options show as cards here;
   * the person's click applies one. */
  choiceSources?: AssistantChoiceSourceRegistry;
  /** Speak instead of typing in the composer (a speech source, e.g.
   * smrt-svelte's `createSttDictationSource()`); see `AssistantComposer`. */
  dictation?: DictationSourceProvider | null;
  /** Writes a recorded message down when the browser cannot recognise
   * speech (Firefox, Brave), e.g. smrt-ui's `createHttpTranscriber()`;
   * see `AssistantComposer`. */
  transcribe?: DictationTranscribe | null;
  /** `'hands-free'` keeps the microphone on and writes each sentence down
   * when the speaker pauses; see `AssistantComposer`. */
  dictationMode?: 'push' | 'hands-free';
  /** The hands-free microphone (`createHandsFreeCapture` from
   * `@happyvertical/smrt-ui/forms/hands-free`); see `AssistantComposer`. */
  handsFreeCapture?: HandsFreeCaptureFactory | null;
  /** Pause length and sensitivity for hands-free; see `AssistantComposer`. */
  handsFreeVad?: HandsFreeVadOptions;
  /** Hands-free: send once the speaker stops talking; see `AssistantComposer`. */
  sendOnPause?: boolean;
  /** Quiet time before `sendOnPause` sends, in ms (default 1200). */
  sendOnPauseMs?: number;
  /** The reply is being read aloud: hands-free listening pauses meanwhile;
   * see `AssistantComposer`. */
  speaking?: boolean;
}

const {
  transport,
  registry,
  contextMode = 'data-surfaces',
  actionClient,
  surfaces,
  visible = true,
  conversations = 'multiple',
  threadList = true,
  toolCall,
  oncontroller,
  onactionapplied,
  onactionsettled,
  initialDraft,
  composerPlaceholder,
  pageTools,
  clientToolPolicy,
  onstatus,
  settle,
  clientToolFilter,
  maxPauseMs,
  onrun,
  choiceSources,
  dictation,
  transcribe,
  dictationMode,
  handsFreeCapture,
  handsFreeVad,
  sendOnPause = false,
  sendOnPauseMs,
  speaking = false,
}: Props = $props();
const { t } = useI18n();

// Passed to the controller as getters (not direct values) so a later
// reassignment of these bound props (e.g. a host swapping the transport or
// registry instance) is actually observed, rather than only the value
// captured at the first run of this script — this also silences Svelte's
// `state_referenced_locally` warning for props read once outside a closure.
const controller: AssistantDockController = createAssistantDockController({
  get transport() {
    return transport;
  },
  get registry() {
    return registry;
  },
  get actionClient() {
    return actionClient;
  },
  get surfaces() {
    return surfaces;
  },
  visible: () => visible,
  onActionApplied: (request, result) => onactionapplied?.(request, result),
  onActionSettled: (request, outcome) => onactionsettled?.(request, outcome),
  // Read once, on mount, like the controller itself.
  initialDraft: untrack(() => initialDraft),
  get pageTools() {
    return pageTools;
  },
  // Read per call so a reassigned prop is observed; the controller still
  // forces `confirm` for a destructive tool whatever this returns.
  clientToolPolicy: (tool) =>
    (clientToolPolicy ?? defaultClientToolPolicy)(tool),
  onStatus: (status) => onstatus?.(status),
  settle: () => settle?.(),
  // Read per call so a changed setting applies to the next step.
  clientToolFilter: (tool) => clientToolFilter?.(tool) ?? true,
  get maxPauseMs() {
    return maxPauseMs;
  },
  onRun: (run) => onrun?.(run),
  get choiceSources() {
    return choiceSources;
  },
});

function formatToolArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return '';
  }
}

// F1 (#2904 review): the whole body runs under `untrack` so the effect takes
// NO dependency on any $state read transitively by loadThreads/loadModels/
// startPolling (e.g. controller.pendingSends inside startPolling). Without
// this, every send() (which reassigns pendingSends before its first await)
// re-ran this effect, and the cleanup below permanently unsubscribed the
// registry listener on the very first message — freezing `surfaces` and
// silently breaking the route-scoping fail-closed guarantee. This effect
// must run exactly once per mount (loadThreads/loadModels fire once), with
// its cleanup firing exactly once, on unmount.
$effect(() => {
  untrack(() => {
    // Finding 4 (#2904 review, fresh cycle): loadThreads/loadModels already
    // catch internally and record the failure on controller.error (see
    // create-assistant-dock-controller.svelte.ts) — void-firing them here
    // was never the source of an unhandled rejection, but nothing rendered
    // the failure before this fix. No .catch() needed here now.
    void controller.loadThreads();
    void controller.loadModels();
    controller.startPolling();
    oncontroller?.(controller);
  });
  return () => controller.dispose();
});

// Finding B (#2904 review, third final pass): a SEPARATE effect, scoped to
// only the `registry` prop, so reassigning it (a host swapping
// tenant/workspace context) is actually observed — the getter passed to
// createAssistantDockController above makes `options.registry` return the
// new value, but nothing previously re-subscribed to it. `registry` is read
// directly here (a tracked dependency) so this effect reruns on a prop
// swap; everything inside stays `untrack`-ed so it does NOT also rerun on
// unrelated $state changes elsewhere (preserving the F1 guarantee that the
// mount effect above runs exactly once per mount).
let uploadContextEpoch = $state(0);

$effect(() => {
  void registry;
  untrack(() => {
    uploadContextEpoch++;
    controller.syncRegistry();
  });
});

// Cycle-2 second final finding 1: a SEPARATE effect, scoped to only the
// `surfaces` prop, mirroring the `registry` effect above — reassigning
// `surfaces` (a host recomputing the override per route) is now observed:
// the controller re-reads the getter and invalidates any outstanding preview
// for a surface that fell out of scope. `surfaces` is read directly here (a
// tracked dependency) so this effect reruns on a prop swap; the body stays
// `untrack`-ed so it does not also rerun on unrelated $state changes
// elsewhere (preserving the F1 guarantee that the mount effect runs exactly
// once per mount).
$effect(() => {
  void surfaces;
  untrack(() => controller.syncSurfaces());
});

// Copilot PR #2919 jAwsd: a SEPARATE effect, scoped to only the `transport`
// prop, mirroring the `registry` effect above — a host swapping the
// transport instance (e.g. alongside a registry swap, for a full
// tenant/workspace context change) previously left threads, messages, and
// pending sends from the OLD context in place. `transport` is read directly
// here (a tracked dependency) so this effect reruns on a prop swap; the body
// stays `untrack`-ed so it does not also rerun on unrelated $state changes
// elsewhere (preserving the F1 guarantee that the mount effect runs exactly
// once per mount).
$effect(() => {
  void transport;
  untrack(() => {
    uploadContextEpoch++;
    controller.syncTransport();
  });
});

// #3000: in a narrow container (below the `@container` breakpoint in the
// styles) the thread list collapses behind a "Conversations" toggle so the
// conversation keeps the full dock width. Wide layouts ignore this state —
// the toggle is hidden there and the list always sits beside the
// conversation. Picking or creating a thread closes the narrow list again.
let threadsOpen = $state(false);
const uid = $props.id();
const threadsId = `assistant-dock-threads-${uid}`;
let threadsEl: HTMLDivElement | undefined = $state();
// The shared Button primitive exposes no element ref, so the toggle is
// found by id when focus has to move back to it.
const threadsToggleId = `${threadsId}-toggle`;

// Closing the narrow list hides the element that holds focus (the thread row
// or "New conversation" button just activated). Hand focus back to the
// toggle so keyboard and screen-reader users keep their place. In wide
// layouts the list stays visible, so focus is left alone.
function closeThreads() {
  if (!threadsOpen) return;
  const focusWasInside =
    typeof document !== 'undefined' &&
    !!threadsEl?.contains(document.activeElement);
  threadsOpen = false;
  if (!focusWasInside) return;
  void tick().then(() => {
    if (threadsEl && threadsEl.offsetParent === null) {
      document.getElementById(threadsToggleId)?.focus();
    }
  });
}

async function openThreads() {
  threadsOpen = true;
  await tick();
  threadsEl?.querySelector<HTMLElement>('.assistant-thread-list-item')?.focus();
}

// Single-conversation mode: open straight into one conversation. Runs once
// per context (transport) after its thread list settles: reuse the most
// recent thread, else create one silently. Any failure is recorded on
// `controller.error`, shown inline in the conversation area with a retry.
let composerRef: { focus(): void } | undefined = $state();
let bootstrapTransport: AssistantTransport | null = null;
const SINGLE_THREAD_TITLE = 'Conversation';

function threadRecency(thread: {
  lastMessageAt?: string | Date | null;
  messageCount: number;
}) {
  // A thread nobody has written to yet (just created, e.g. by "Clear
  // conversation") is the newest; an undated thread with messages is oldest.
  if (!thread.lastMessageAt) {
    return thread.messageCount === 0
      ? Number.POSITIVE_INFINITY
      : Number.NEGATIVE_INFINITY;
  }
  const time = new Date(thread.lastMessageAt).getTime();
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

function mostRecentThreadId(): string | undefined {
  let best: { id: string; at: number } | undefined;
  for (const thread of controller.threads) {
    const at = threadRecency(thread);
    // `>=` so that, among equals, the later-listed thread wins (transports
    // list oldest first).
    if (!best || at >= best.at) best = { id: thread.id, at };
  }
  return best?.id;
}

async function startConversation(fresh = false) {
  const current = transport;
  bootstrapTransport = current;
  try {
    let threadId = fresh ? undefined : mostRecentThreadId();
    if (!threadId) {
      if (!current.createThread) {
        controller.setError(t(M['chat.assistant_dock.no_conversations']));
        return;
      }
      threadId = (await controller.createThread(SINGLE_THREAD_TITLE)).id;
    }
    if (transport !== current) return;
    await controller.openThread(threadId);
  } catch {
    // createThread already recorded the failure on controller.error.
  } finally {
    if (bootstrapTransport === current) bootstrapTransport = null;
  }
}

async function retryConversation() {
  controller.setError(null);
  // Reload first: a failed list must not be mistaken for "no thread yet".
  await controller.loadThreads();
  // A successful load re-arms the effect below.
}

$effect(() => {
  if (conversations !== 'single') return;
  if (
    controller.threadsLoading ||
    controller.activeThreadId ||
    controller.error
  ) {
    return;
  }
  if (bootstrapTransport === transport) return;
  void untrack(() => startConversation());
});

// Focus the composer once the conversation is open and the dock is shown.
$effect(() => {
  if (conversations !== 'single' || !visible || !controller.activeThreadId) {
    return;
  }
  void tick().then(() => composerRef?.focus());
});

async function handleClearConversation() {
  closeThreads();
  controller.setError(null);
  await startConversation(true);
}

async function handleSelectThread(threadId: string) {
  closeThreads();
  // openThread() catches internally and records any failure on
  // controller.error (cycle-2 second final finding 2) — never rejects.
  await controller.openThread(threadId);
}

async function handleCreateThread() {
  // createThread() can still reject (its return value is the thing callers
  // need); catch here so the un-awaited onclick in AssistantThreadList never
  // produces an unhandled rejection. The failure is already recorded on
  // controller.error by createThread itself (cycle-2 second final finding 2).
  closeThreads();
  try {
    const thread = await controller.createThread('New conversation');
    await controller.openThread(thread.id);
  } catch {
    // Already surfaced via controller.error.
  }
}

async function handleSend(
  content: string,
  attachments: AssistantAttachmentRef[],
) {
  // Finding 4 (#2904 review, fresh cycle): controller.send()/doSend()
  // already marks the pendingSend 'failed' and rethrows on a transport
  // error. Catch here to ALSO record it on controller.error (rendered as a
  // dock-level banner), then rethrow so AssistantComposer's own `await
  // onsend(...)` still sees the rejection and restores the user's draft
  // instead of discarding it.
  try {
    await controller.send(content, attachments);
    controller.setError(null);
  } catch (error) {
    controller.setError(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function handleUpload(
  files: FileList,
): Promise<AssistantAttachmentRef[]> {
  // Cycle-2 third final: rethrows on failure (mirrors handleSend's pattern)
  // rather than returning [] — the composer's own catch (added alongside
  // this fix) needs the rejection to show its inline per-attempt error;
  // returning [] here would make a failed upload look like a successful
  // empty batch. This handler ALSO records the failure on controller.error
  // so the dock-level banner matches the send path.
  const uploadTransport = transport;
  const uploadEpoch = uploadContextEpoch;
  const isCurrentUpload = () =>
    transport === uploadTransport && uploadContextEpoch === uploadEpoch;
  try {
    const upload = uploadTransport.uploadAttachment;
    if (!upload) {
      throw new Error('AssistantDock: attachment upload is not supported');
    }
    const uploaded: AssistantAttachmentRef[] = [];
    for (const file of Array.from(files)) {
      uploaded.push(await upload.call(uploadTransport, file));
      if (!isCurrentUpload()) return [];
    }
    controller.setError(null);
    return uploaded;
  } catch (error) {
    if (isCurrentUpload()) {
      controller.setError(
        error instanceof Error ? error.message : String(error),
      );
    }
    throw error;
  }
}

async function handleConfirmAction(requestId: string) {
  // No idempotencyKey minted here: `applyAction` reuses the key generated
  // once in `previewAction` and stored on the action state, so a retried
  // Confirm click (e.g. after a client-side timeout on a call the server
  // actually completed) dedups against that same attempt instead of
  // re-executing. See `AssistantActionState.idempotencyKey`.
  await controller.applyAction(requestId);
}
</script>

<div class="assistant-dock">
  <div
    class="assistant-dock-layout"
    data-threads-open={threadsOpen || undefined}
  >
    {#if conversations !== 'single' && threadList}
      <Button
        type="button"
        variant="ghost"
        id={threadsToggleId}
        class="assistant-dock-threads-toggle"
        aria-expanded={threadsOpen}
        aria-controls={threadsId}
        onclick={() => (threadsOpen = !threadsOpen)}
      >
        {t(M['chat.assistant_dock.conversations_toggle'])}
      </Button>

      <div
        class="assistant-dock-threads"
        id={threadsId}
        bind:this={threadsEl}
      >
        <AssistantThreadList
          threads={controller.threads}
          activeThreadId={controller.activeThreadId}
          onselect={handleSelectThread}
          oncreate={transport.createThread ? handleCreateThread : undefined}
        />
      </div>
    {/if}

    <div class="assistant-dock-main">
      {#if controller.error}
        <p class="assistant-dock-error" role="alert">
          {t(M['chat.assistant_dock.error'], { message: controller.error })}
          {#if conversations === 'single' && !controller.activeThreadId}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onclick={retryConversation}
            >
              {t(M['chat.assistant_dock.retry_conversation'])}
            </Button>
          {/if}
        </p>
      {/if}

      {#if conversations === 'single' && controller.activeThreadId && transport.createThread && controller.messages.length > 0}
        <div class="assistant-dock-single-actions">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            class="assistant-dock-clear"
            onclick={handleClearConversation}
            aria-label={t(M['chat.assistant_dock.clear_conversation'])}
            title={t(M['chat.assistant_dock.clear_conversation'])}
          >
            <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
              <path
                d="M4 6h12M8 6V4.5h4V6m-6.5 0l.7 9.5h7.6L15 6M8.5 9v4m3-4v4"
                fill="none"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </Button>
        </div>
      {/if}

      {#if contextMode === 'data-surfaces' && controller.surfaces.length === 0 && !pageTools}
        <p class="assistant-dock-empty">
          {t(M['chat.assistant_dock.no_surfaces'])}
        </p>
      {/if}

      <div class="assistant-dock-scroll">
        {#if conversations === 'single'}
          {#if !controller.activeThreadId && !controller.error}
            <div
              class="assistant-dock-thread-state assistant-dock-thread-loading"
              role="status"
              aria-label={t(M['chat.assistant_dock.opening_conversation'])}
            >
              <p>{t(M['chat.assistant_dock.opening_conversation'])}</p>
            </div>
          {/if}
        {:else if !controller.activeThreadId && controller.threadsLoading}
          <div
            class="assistant-dock-thread-state assistant-dock-thread-loading"
            role="status"
            aria-label={t(M['chat.assistant_dock.loading_conversations'])}
          >
            <p>{t(M['chat.assistant_dock.loading_conversations'])}</p>
          </div>
        {:else if !controller.activeThreadId && !controller.error}
          <section
            class="assistant-dock-thread-state"
            aria-labelledby={`${threadsId}-empty-title`}
          >
            {#if threadList && controller.threads.length > 0}
              <h2 id={`${threadsId}-empty-title`}>
                {t(M['chat.assistant_dock.choose_conversation'])}
              </h2>
              <p>{t(M['chat.assistant_dock.choose_conversation_hint'])}</p>
              <div class="assistant-dock-thread-state-actions">
                <Button
                  type="button"
                  aria-controls={threadsId}
                  onclick={openThreads}
                >
                  {t(M['chat.assistant_dock.view_conversations'])}
                </Button>
                {#if transport.createThread}
                  <Button type="button" variant="ghost" onclick={handleCreateThread}>
                    {t(M['chat.assistant_dock.start_new_conversation'])}
                  </Button>
                {/if}
              </div>
            {:else if transport.createThread}
              <h2 id={`${threadsId}-empty-title`}>
                {t(M['chat.assistant_dock.start_conversation'])}
              </h2>
              <p>{t(M['chat.assistant_dock.start_conversation_hint'])}</p>
              <Button type="button" onclick={handleCreateThread}>
                {t(M['chat.assistant_dock.start_new_conversation'])}
              </Button>
            {:else}
              <h2 id={`${threadsId}-empty-title`}>
                {t(M['chat.assistant_dock.no_conversations'])}
              </h2>
              <p>{t(M['chat.assistant_dock.no_conversations_hint'])}</p>
            {/if}
          </section>
        {/if}

        <ul class="assistant-dock-messages">
          {#each controller.messages as message (message.id)}
            <li data-role={message.role}>
              <MessageBubble
                variant={bubbleVariant(message.role)}
                own={message.role === 'user'}
              >
                {#snippet children()}
                  <p class="assistant-dock-message-content">{message.content}</p>
                {#if toolCall && message.toolCallData != null}
                  <div class="assistant-dock-tool-call">
                    {@render toolCall(message)}
                  </div>
                {/if}
                  {#if message.attachments && message.attachments.length > 0}
                    <ul
                      class="assistant-dock-attachments"
                      aria-label={t(M['chat.assistant_dock.attachments'])}
                    >
                      {#each message.attachments as attachment (attachment.id)}
                        {@const href = safeAttachmentHref(attachment.url)}
                        <li class="assistant-dock-attachment">
                          {#if href}
                            <a
                              {href}
                              target="_blank"
                              rel="noopener noreferrer"
                              class="assistant-dock-attachment-link"
                            >
                              {attachment.name}
                            </a>
                          {:else}
                            <span class="assistant-dock-attachment-name">
                              {attachment.name}
                            </span>
                          {/if}
                          {#if attachment.size !== undefined}
                            <span class="assistant-dock-attachment-size">
                              {formatAttachmentSize(attachment.size)}
                            </span>
                          {/if}
                        </li>
                      {/each}
                    </ul>
                  {/if}
                {/snippet}
              </MessageBubble>
            </li>
          {/each}
        </ul>

        {#if controller.streamingText}
          <div
            class="assistant-dock-streaming"
            aria-label={t(M['chat.assistant_dock.reply_in_progress'])}
          >
            <MessageBubble variant="agent" own={false}>
              {#snippet children()}
                <p class="assistant-dock-message-content">{controller.streamingText}</p>
              {/snippet}
            </MessageBubble>
          </div>
        {/if}

        {#each controller.toolRequests.filter((r) => r.status === 'waiting') as request (request.id)}
          <div class="assistant-dock-tool-request" role="group" aria-label={t(M['chat.assistant_dock.tool_request_title'])}>
            <p class="assistant-dock-tool-request-title">
              {t(M['chat.assistant_dock.tool_request_title'])}
            </p>
            <p class="assistant-dock-tool-request-description">{request.description || request.name}</p>
            {#if request.effect === 'destructive'}
              <p class="assistant-dock-tool-request-warning">
                {t(M['chat.assistant_dock.tool_request_destructive'])}
              </p>
            {/if}
            <details class="assistant-dock-tool-request-details">
              <summary>{t(M['chat.assistant_dock.tool_request_details'])}</summary>
              <pre>{formatToolArgs(request.args)}</pre>
            </details>
            <div class="assistant-dock-tool-request-actions">
              <Button type="button" size="sm" onclick={() => controller.approveToolRequest(request.id)}>
                {t(M['chat.assistant_dock.tool_request_allow'])}
              </Button>
              <Button type="button" size="sm" variant="ghost" onclick={() => controller.declineToolRequest(request.id)}>
                {t(M['chat.assistant_dock.tool_request_decline'])}
              </Button>
            </div>
          </div>
        {/each}

        <AssistantChoiceCards
          choices={controller.choices}
          onchoose={(setId, optionId) => void controller.chooseOption(setId, optionId)}
          ondismiss={(setId) => controller.dismissChoices(setId)}
          onpreview={(setId, optionId) => void controller.previewOption(setId, optionId)}
          oncommit={(setId) => void controller.commitOption(setId)}
          oncancel={(setId) => controller.cancelChoices(setId)}
        />

        {#if controller.actions.size > 0}
          <ul class="assistant-dock-actions">
            {#each [...controller.actions.entries()] as [requestId, action] (requestId)}
              <li>
                <ToolCallDisplay
                  toolCall={{
                    toolName: action.request.actionId,
                    toolCallId: requestId,
                    status: toolCallStatusForAction(action.status),
                    error: action.error,
                  }}
                  actionResult={action.applyResult ??
                    // Finding 3 (#2904 review, fresh cycle): only surface the
                    // preview result — and its live Confirm/Reject — while the
                    // action is actually AWAITING confirmation. Once Confirm
                    // has been clicked ('applying'), the preview's phase:
                    // 'preview' result must stop rendering those buttons; the
                    // toolCall.status 'running' mapping above shows the
                    // existing spinner/"Executing..." state instead.
                    (action.status === 'previewed'
                      ? action.previewResult
                      : undefined)}
                  onconfirmaction={() => handleConfirmAction(requestId)}
                  onrejectaction={() => controller.rejectAction(requestId)}
                />
                {#if action.outcomeUnknown}
                  <!-- #2990: no decision was reached, so the change may have
                       landed. Reject is withdrawn (ToolCallDisplay only
                       offers it for a live preview); the only affordance is a
                       same-key retry. -->
                  <div class="assistant-dock-action-unknown" role="status">
                    <p>{t(M['chat.assistant_dock.action_outcome_unknown'])}</p>
                    <Button
                      type="button"
                      size="sm"
                      disabled={action.status === 'applying'}
                      onclick={() => handleConfirmAction(requestId)}
                    >
                      {t(M['chat.assistant_dock.action_check_again'])}
                    </Button>
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}

        {#if controller.pendingSends.some((p) => p.status === 'stale')}
          <div class="assistant-dock-stale">
            <p>{t(M['chat.assistant_dock.taking_longer'])}</p>
            {#each controller.pendingSends.filter((p) => p.status === 'stale') as pending (pending.clientRequestId)}
              <Button
                type="button"
                size="sm"
                onclick={() => controller.retry(pending.clientRequestId)}
              >
                {t(M['chat.assistant_dock.retry'], { content: pending.content })}
              </Button>
            {/each}
          </div>
        {/if}

        {#if controller.pendingSends.some((p) => p.status === 'failed')}
          <!-- Finding 4 (#2904 review, fresh cycle): a send that failed
               transport-side previously had no visible representation at
               all — only 'stale' rendered above. retry(clientRequestId)
               already exists and reuses the same id, so it's the same
               affordance as the stale case. -->
          <div class="assistant-dock-failed">
            <p>{t(M['chat.assistant_dock.send_failed'])}</p>
            {#each controller.pendingSends.filter((p) => p.status === 'failed') as pending (pending.clientRequestId)}
              <Button
                type="button"
                size="sm"
                onclick={() => controller.retry(pending.clientRequestId)}
              >
                {t(M['chat.assistant_dock.retry'], { content: pending.content })}
              </Button>
            {/each}
          </div>
        {/if}
      </div>

      {#if controller.status.state === 'working'}
        <div class="assistant-dock-status" role="status" aria-live="polite">
          <span class="assistant-dock-status-label">{controller.status.label}</span>
          {#if controller.status.cancellable}
            <Button type="button" size="sm" variant="ghost" onclick={() => controller.cancel()}>
              {t(M['chat.assistant_dock.stop'])}
            </Button>
          {/if}
        </div>
      {/if}

      <div class="assistant-dock-composer">
        {#if controller.models.length > 0}
          <div class="assistant-dock-composer-header">
            <ModelPicker
              models={controller.models}
              value={controller.selectedModel ?? controller.models[0].id}
              onchange={(modelId) => controller.setSelectedModel(modelId)}
            />
          </div>
        {/if}
        {#key uploadContextEpoch}
          <AssistantComposer
            bind:this={composerRef}
            bind:value={
              () => controller.draft, (text) => controller.setDraft(text)
            }
            onsend={handleSend}
            onupload={transport.uploadAttachment ? handleUpload : undefined}
            disabled={!controller.activeThreadId}
            placeholder={composerPlaceholder}
            {dictation}
            {transcribe}
            {dictationMode}
            {handsFreeCapture}
            {handsFreeVad}
            {sendOnPause}
            {sendOnPauseMs}
            {speaking}
          />
        {/key}
      </div>
    </div>
  </div>
</div>

<style>
  /* #3000: the dock sizes itself against its own container (a shell dock
   * edge can be ~250px wide) rather than the viewport. A container cannot
   * query itself, so the flex layout lives on an inner wrapper. */
  .assistant-dock {
    container-type: inline-size;
    height: 100%;
    min-height: 0;
    font-family: var(--smrt-font-family, system-ui, sans-serif);
    background: var(--smrt-color-surface, #ffffff);
    color: var(--smrt-color-on-surface, #1a1c1e);
  }

  .assistant-dock-layout {
    display: flex;
    height: 100%;
    min-height: 0;
  }

  .assistant-dock-status {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.35rem 0.75rem;
    border-top: 1px solid var(--smrt-color-outline-variant, #c4c7c5);
    font-size: var(--smrt-typography-body-medium-size, 0.85rem);
    color: var(--smrt-color-on-surface-variant, #44474e);
  }

  .assistant-dock-tool-request {
    margin: 0.5rem 0;
    padding: 0.75rem;
    border: 1px solid var(--smrt-color-outline-variant, #c4c7c5);
    border-radius: var(--smrt-radius-md, 8px);
    background: var(--smrt-color-surface-container, #f3f3f3);
  }

  .assistant-dock-tool-request p {
    margin: 0 0 0.4rem;
  }

  .assistant-dock-tool-request-title {
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }

  .assistant-dock-tool-request-warning {
    color: var(--smrt-color-error, #b3261e);
  }

  .assistant-dock-tool-request-details pre {
    max-height: 10rem;
    overflow: auto;
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .assistant-dock-tool-request-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }

  .assistant-dock-threads {
    display: flex;
    flex-shrink: 0;
    min-height: 0;
    /* A long thread title must not squeeze the conversation (titles clip). */
    max-width: min(16rem, 40%);
    min-width: 0;
  }

  .assistant-dock .assistant-dock-layout > :global(.assistant-dock-threads-toggle) {
    display: none;
  }

  @container (max-width: 479px) {
    .assistant-dock-layout {
      flex-direction: column;
    }

    .assistant-dock .assistant-dock-layout > :global(.assistant-dock-threads-toggle) {
      display: flex;
      justify-content: flex-start;
      align-items: center;
      gap: var(--smrt-spacing-2, 8px);
      flex-shrink: 0;
      width: 100%;
      min-height: 44px;
      padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-3, 12px);
      border: none;
      border-bottom: 1px solid var(--smrt-color-outline-variant, #c4c6cf);
      background: var(--smrt-color-surface-container-low, #f7f7fb);
      color: var(--smrt-color-on-surface, #1a1c1e);
      font: var(--smrt-typography-label-large-font, 500 0.875rem/1.25 sans-serif);
      font-family: inherit;
      border-radius: 0;
      text-align: left;
      cursor: pointer;
    }

    .assistant-dock .assistant-dock-layout > :global(.assistant-dock-threads-toggle::before) {
      content: '▸' / '';
      color: var(--smrt-color-on-surface-variant, #43474e);
    }

    .assistant-dock .assistant-dock-layout[data-threads-open]
      > :global(.assistant-dock-threads-toggle::before) {
      content: '▾' / '';
    }

    .assistant-dock .assistant-dock-layout > :global(.assistant-dock-threads-toggle:focus-visible) {
      outline: 2px solid var(--smrt-color-primary, #005ac1);
      outline-offset: -2px;
    }

    .assistant-dock-threads {
      display: none;
    }

    .assistant-dock-layout[data-threads-open] .assistant-dock-threads {
      display: flex;
      max-width: none;
      max-height: 40%;
      border-bottom: 1px solid var(--smrt-color-outline-variant, #c4c6cf);
    }

    .assistant-dock-threads > :global(.assistant-thread-list) {
      flex: 1;
      min-width: 0;
      border-right: none;
    }
  }

  .assistant-dock-main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
  }

  .assistant-dock-empty {
    margin: 0;
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-3, 12px);
    font: var(--smrt-typography-body-small-font, 0.8125rem/1.4 sans-serif);
    color: var(--smrt-color-on-surface-variant, #43474e);
    background: var(--smrt-color-surface-container-low, #f7f7fb);
    border-bottom: 1px solid var(--smrt-color-outline-variant, #c4c6cf);
  }

  .assistant-dock-scroll {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-3, 12px);
    padding: var(--smrt-spacing-3, 12px);
    min-height: 0;
  }

  .assistant-dock-messages {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2, 8px);
  }

  /* Narrow-dock friendly bubbles: the user's message sits right, the
   * assistant's left, each at most ~85% of the thread width in calm tokens. */
  .assistant-dock-messages > li {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .assistant-dock-messages > li :global(.bubble),
  .assistant-dock-streaming :global(.bubble) {
    max-width: 85%;
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-3, 12px);
    border-radius: var(--smrt-radius-large, 12px);
    overflow-wrap: anywhere;
  }

  .assistant-dock-messages > li[data-role='user'] :global(.bubble),
  .assistant-dock-messages > li[data-role='user'] :global(.bubble--own) {
    align-self: flex-end;
    background: var(--smrt-color-primary-container, #d8e2ff);
    color: var(--smrt-color-on-primary-container, #001a41);
    border-radius: var(--smrt-radius-large, 12px);
  }

  .assistant-dock-messages > li:not([data-role='user']) :global(.bubble--agent),
  .assistant-dock-streaming :global(.bubble--agent) {
    align-self: flex-start;
    background: var(--smrt-color-surface-container, #f0f0f4);
    color: var(--smrt-color-on-surface, #1a1c1e);
    border-left: none;
    border-radius: var(--smrt-radius-large, 12px);
  }

  .assistant-dock-streaming {
    display: flex;
    flex-direction: column;
  }

  .assistant-dock-thread-state {
    flex: 1;
    min-height: 10rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--smrt-spacing-2, 8px);
    padding: var(--smrt-spacing-5, 20px);
    color: var(--smrt-color-on-surface-variant, #43474e);
    text-align: center;
  }

  .assistant-dock-thread-state h2,
  .assistant-dock-thread-state p {
    margin: 0;
  }

  .assistant-dock-thread-state h2 {
    color: var(--smrt-color-on-surface, #1a1c1e);
    font: var(--smrt-typography-title-medium-font, 600 1rem/1.4 sans-serif);
  }

  .assistant-dock-thread-state p {
    max-width: 28rem;
    font: var(--smrt-typography-body-medium-font, 0.875rem/1.5 sans-serif);
  }

  .assistant-dock-thread-state-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--smrt-spacing-2, 8px);
  }

  .assistant-dock-thread-loading {
    min-height: 4rem;
  }

  .assistant-dock-tool-call {
    margin-top: var(--smrt-spacing-2, 8px);
    min-width: 0;
  }

  .assistant-dock-message-content {
    margin: 0;
    white-space: pre-wrap;
  }

  .assistant-dock-attachments {
    list-style: none;
    margin: var(--smrt-spacing-2, 8px) 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1, 4px);
  }

  .assistant-dock-attachment {
    display: flex;
    align-items: baseline;
    gap: var(--smrt-spacing-1, 4px);
    font: var(--smrt-typography-body-small-font, 0.8125rem/1.4 sans-serif);
  }

  .assistant-dock-attachment-link {
    color: inherit;
    text-decoration: underline;
  }

  .assistant-dock-attachment-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .assistant-dock-attachment-size {
    opacity: 0.75;
    font-size: var(--smrt-typography-label-small-size, 0.6875rem);
  }

  .assistant-dock-actions {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2, 8px);
  }

  .assistant-dock-action-unknown {
    margin-top: var(--smrt-spacing-2, 8px);
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-3, 12px);
    border-radius: var(--smrt-radius-medium, 8px);
    background: var(--smrt-color-tertiary-container, #ffd8e4);
    color: var(--smrt-color-on-tertiary-container, #31111d);
    font: var(--smrt-typography-body-small-font, 0.8125rem/1.4 sans-serif);
  }

  .assistant-dock-action-unknown p {
    margin: 0 0 var(--smrt-spacing-2, 8px);
  }

  .assistant-dock-stale {
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-3, 12px);
    border-radius: var(--smrt-radius-medium, 8px);
    background: var(--smrt-color-tertiary-container, #ffd8e4);
    color: var(--smrt-color-on-tertiary-container, #31111d);
    font: var(--smrt-typography-body-small-font, 0.8125rem/1.4 sans-serif);
  }

  .assistant-dock-stale p {
    margin: 0 0 var(--smrt-spacing-2, 8px);
  }

  .assistant-dock-failed {
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-3, 12px);
    border-radius: var(--smrt-radius-medium, 8px);
    background: var(--smrt-color-error-container, #ffdad6);
    color: var(--smrt-color-on-error-container, #410002);
    font: var(--smrt-typography-body-small-font, 0.8125rem/1.4 sans-serif);
  }

  .assistant-dock-failed p {
    margin: 0 0 var(--smrt-spacing-2, 8px);
  }

  .assistant-dock-error {
    margin: 0;
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-3, 12px);
    font: var(--smrt-typography-body-small-font, 0.8125rem/1.4 sans-serif);
    color: var(--smrt-color-on-error-container, #410002);
    background: var(--smrt-color-error-container, #ffdad6);
    border-bottom: 1px solid var(--smrt-color-outline-variant, #c4c6cf);
  }

  .assistant-dock-single-actions {
    display: flex;
    justify-content: flex-end;
    padding: var(--smrt-spacing-1, 4px) var(--smrt-spacing-2, 8px) 0;
  }

  .assistant-dock-composer-header {
    padding: 0 var(--smrt-spacing-2, 8px);
    padding-top: var(--smrt-spacing-2, 8px);
  }
</style>
