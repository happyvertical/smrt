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
import type { DataSurfaceRegistry } from '@happyvertical/smrt-ui/data-surface';
import ToolCallDisplay from '../agent/ToolCallDisplay.svelte';
import ModelPicker from '../shared/ModelPicker.svelte';
import AssistantComposer from './AssistantComposer.svelte';
import AssistantThreadList from './AssistantThreadList.svelte';
import type {
  AssistantAttachmentRef,
  AssistantTransport,
} from './assistant-transport.js';
import {
  type AssistantActionClient,
  type AssistantDockController,
  createAssistantDockController,
} from './create-assistant-dock-controller.svelte.js';

export interface Props {
  transport: AssistantTransport;
  registry: DataSurfaceRegistry;
  actionClient?: AssistantActionClient;
  visible?: boolean;
}

const { transport, registry, actionClient, visible = true }: Props = $props();

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

$effect(() => {
  void controller.loadThreads();
  void controller.loadModels();
  controller.startPolling();
  return () => controller.dispose();
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
        No data surfaces are mounted on this route — the assistant can chat
        but has no actions available here.
      </p>
    {/if}

    <ul class="assistant-dock-messages">
      {#each controller.messages as message (message.id)}
        <li class={`role-${message.role}`}>{message.content}</li>
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
        <p>The assistant is taking longer than expected.</p>
        {#each controller.pendingSends.filter((p) => p.status === 'stale') as pending (pending.clientRequestId)}
          <button type="button" onclick={() => controller.retry(pending.clientRequestId)}>
            Retry "{pending.content}"
          </button>
        {/each}
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
  }
  .assistant-dock-main {
    flex: 1;
    display: flex;
    flex-direction: column;
  }
  .assistant-dock-messages {
    flex: 1;
    overflow-y: auto;
    list-style: none;
    margin: 0;
    padding: 0.5rem;
  }
</style>
