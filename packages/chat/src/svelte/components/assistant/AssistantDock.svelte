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
import type { DataSurfaceRegistry } from '@happyvertical/smrt-ui/data-surface';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { untrack } from 'svelte';
import { M } from '../../i18n.js';
import ToolCallDisplay from '../agent/ToolCallDisplay.svelte';
import ModelPicker from '../shared/ModelPicker.svelte';
import AssistantComposer from './AssistantComposer.svelte';
import AssistantThreadList from './AssistantThreadList.svelte';
import type {
  AssistantAttachmentRef,
  AssistantMessage,
  AssistantTransport,
} from './assistant-transport.js';
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
  /** Whether the dock is currently visible; polling pauses while false. */
  visible?: boolean;
}

const { transport, registry, actionClient, visible = true }: Props = $props();
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

async function handleSelectThread(threadId: string) {
  await controller.openThread(threadId);
}

async function handleCreateThread() {
  const thread = await controller.createThread('New conversation');
  await controller.openThread(thread.id);
}

async function handleSend(
  content: string,
  attachments: AssistantAttachmentRef[],
) {
  await controller.send(content, attachments);
}

async function handleUpload(
  files: FileList,
): Promise<AssistantAttachmentRef[]> {
  const uploaded: AssistantAttachmentRef[] = [];
  for (const file of Array.from(files)) {
    uploaded.push(await transport.uploadAttachment(file));
  }
  return uploaded;
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
  <AssistantThreadList
    threads={controller.threads}
    activeThreadId={controller.activeThreadId}
    onselect={handleSelectThread}
    oncreate={handleCreateThread}
  />

  <div class="assistant-dock-main">
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
              content={message.content}
            />
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
                  status: action.status === 'failed' ? 'error' : 'success',
                  error: action.error,
                }}
                actionResult={action.applyResult ?? action.previewResult}
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

<style>
  .assistant-dock {
    display: flex;
    height: 100%;
    min-height: 0;
    font-family: var(--smrt-font-family, system-ui, sans-serif);
    background: var(--smrt-color-surface, #ffffff);
    color: var(--smrt-color-on-surface, #1a1c1e);
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

  .assistant-dock-composer-header {
    padding: 0 var(--smrt-spacing-2, 8px);
    padding-top: var(--smrt-spacing-2, 8px);
  }
</style>
