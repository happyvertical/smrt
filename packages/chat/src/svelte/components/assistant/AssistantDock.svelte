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
  DataSurfaceIdentity,
  DataSurfaceRegistry,
} from '@happyvertical/smrt-ui/data-surface';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { tick, untrack } from 'svelte';
import { M } from '../../i18n.js';
import ToolCallDisplay from '../agent/ToolCallDisplay.svelte';
import ModelPicker from '../shared/ModelPicker.svelte';
import AssistantComposer from './AssistantComposer.svelte';
import AssistantThreadList from './AssistantThreadList.svelte';
import { toolCallStatusForAction } from './action-status.js';
import type {
  AssistantAttachmentRef,
  AssistantMessage,
  AssistantTransport,
} from './assistant-transport.js';
import { safeAttachmentHref } from './attachment-href.js';
import {
  type AssistantActionClient,
  type AssistantDockController,
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
}

const {
  transport,
  registry,
  actionClient,
  surfaces,
  visible = true,
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
});

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
$effect(() => {
  void registry;
  untrack(() => controller.syncRegistry());
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
  untrack(() => controller.syncTransport());
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
let threadsToggleEl: HTMLButtonElement | undefined = $state();

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
      threadsToggleEl?.focus();
    }
  });
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
  try {
    const uploaded: AssistantAttachmentRef[] = [];
    for (const file of Array.from(files)) {
      uploaded.push(await transport.uploadAttachment(file));
    }
    controller.setError(null);
    return uploaded;
  } catch (error) {
    controller.setError(error instanceof Error ? error.message : String(error));
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
    <button
      type="button"
      class="assistant-dock-threads-toggle"
      bind:this={threadsToggleEl}
      aria-expanded={threadsOpen}
      aria-controls={threadsId}
      onclick={() => (threadsOpen = !threadsOpen)}
    >
      {t(M['chat.assistant_dock.conversations_toggle'])}
    </button>

    <div
      class="assistant-dock-threads"
      id={threadsId}
      bind:this={threadsEl}
    >
      <AssistantThreadList
        threads={controller.threads}
        activeThreadId={controller.activeThreadId}
        onselect={handleSelectThread}
        oncreate={handleCreateThread}
      />
    </div>

    <div class="assistant-dock-main">
      {#if controller.error}
        <p class="assistant-dock-error" role="alert">
          {t(M['chat.assistant_dock.error'], { message: controller.error })}
        </p>
      {/if}

      {#if controller.surfaces.length === 0}
        <p class="assistant-dock-empty">
          {t(M['chat.assistant_dock.no_surfaces'])}
        </p>
      {/if}

      <div class="assistant-dock-scroll">
        <ul class="assistant-dock-messages">
          {#each controller.messages as message (message.id)}
            <li>
              <MessageBubble
                variant={bubbleVariant(message.role)}
                own={message.role === 'user'}
              >
                {#snippet children()}
                  <p class="assistant-dock-message-content">{message.content}</p>
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
        <AssistantComposer
          onsend={handleSend}
          onupload={handleUpload}
          disabled={!controller.activeThreadId}
        />
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

  .assistant-dock-threads {
    display: flex;
    flex-shrink: 0;
    min-height: 0;
  }

  .assistant-dock-threads-toggle {
    display: none;
  }

  @container (max-width: 479px) {
    .assistant-dock-layout {
      flex-direction: column;
    }

    .assistant-dock-threads-toggle {
      display: flex;
      align-items: center;
      gap: var(--smrt-spacing-2, 8px);
      flex-shrink: 0;
      width: 100%;
      padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-3, 12px);
      border: none;
      border-bottom: 1px solid var(--smrt-color-outline-variant, #c4c6cf);
      background: var(--smrt-color-surface-container-low, #f7f7fb);
      color: var(--smrt-color-on-surface, #1a1c1e);
      font: var(--smrt-typography-label-large-font, 500 0.875rem/1.25 sans-serif);
      font-family: inherit;
      text-align: left;
      cursor: pointer;
    }

    .assistant-dock-threads-toggle::before {
      content: '▸' / '';
      color: var(--smrt-color-on-surface-variant, #43474e);
    }

    .assistant-dock-layout[data-threads-open] .assistant-dock-threads-toggle::before {
      content: '▾' / '';
    }

    .assistant-dock-threads-toggle:focus-visible {
      outline: 2px solid var(--smrt-color-primary, #005ac1);
      outline-offset: -2px;
    }

    .assistant-dock-threads {
      display: none;
    }

    .assistant-dock-layout[data-threads-open] .assistant-dock-threads {
      display: flex;
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

  .assistant-dock-composer-header {
    padding: 0 var(--smrt-spacing-2, 8px);
    padding-top: var(--smrt-spacing-2, 8px);
  }
</style>
