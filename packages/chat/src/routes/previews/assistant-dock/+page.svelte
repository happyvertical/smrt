<script lang="ts">
/**
 * AssistantDock demo (#2904).
 *
 * Composes the same primitives `AssistantDock.svelte` composes internally
 * (`createAssistantDockController`, `AssistantThreadList`, `AssistantComposer`,
 * `ToolCallDisplay`), plus a tiny demo "orders" data surface and a canned
 * reply script, so the full send -> propose action -> preview -> confirm ->
 * apply -> row-mutation loop is visible without a real backend. This is a
 * demo composition, not a claim that AssistantDock itself parses assistant
 * replies into action proposals (it doesn't — see docs/assistant-dock.md
 * "Gaps"); the trigger phrase below is matched in this page's own
 * `handleSend`, the same way a real host application's message-rendering
 * logic would recognize a proposed tool call and call
 * `controller.previewAction(...)`.
 */

import { MessageBubble } from '@happyvertical/smrt-ui/chat';
import {
  createDataSurfaceRegistry,
  type DataSurfaceIdentity,
  type DataSurfaceJsonValue,
  type DataSurfaceRegistryEvent,
  type DataSurfaceVisibleCommand,
} from '@happyvertical/smrt-ui/data-surface';
import { ThemeProvider } from '@happyvertical/smrt-ui/themes';
import ToolCallDisplay from '../../../svelte/components/agent/ToolCallDisplay.svelte';
import AssistantComposer from '../../../svelte/components/assistant/AssistantComposer.svelte';
import AssistantThreadList from '../../../svelte/components/assistant/AssistantThreadList.svelte';
import {
  type AssistantAttachmentRef,
  createInMemoryAssistantTransport,
} from '../../../svelte/components/assistant/assistant-transport.js';
import { createAssistantDockController } from '../../../svelte/components/assistant/create-assistant-dock-controller.svelte.js';

interface DemoOrderRow {
  id: string;
  customer: string;
  status: 'pending' | 'shipped';
}

// --- Demo data surface: three orders, one "set-status" command -------------

let rows = $state<DemoOrderRow[]>([
  { id: 'order-1', customer: 'Ari Patel', status: 'pending' },
  { id: 'order-2', customer: 'Jun Kwon', status: 'pending' },
  { id: 'order-3', customer: 'Lee Novak', status: 'pending' },
]);
let revision = $state(1);

const identity: DataSurfaceIdentity = {
  surfaceId: 'demo-orders',
  kind: 'table',
  subject: { type: 'tenant', id: 'demo-tenant' },
};

const registry = createDataSurfaceRegistry();

function applySetStatus(command: DataSurfaceVisibleCommand) {
  const payload = command.payload as
    | { rowId?: string; status?: string }
    | undefined;
  const row = rows.find((r) => r.id === payload?.rowId);
  if (
    !row ||
    (payload?.status !== 'shipped' && payload?.status !== 'pending')
  ) {
    return { ok: false as const, reason: 'not_found' as const };
  }
  row.status = payload.status;
  revision += 1;
  return { ok: true as const };
}

registry.register({
  descriptor: {
    version: 1,
    identity,
    schemaVersion: 1,
    label: 'Orders',
    rowKey: 'id',
    columns: [
      {
        id: 'id',
        label: 'Order',
        capabilities: ['read', 'project'],
        role: 'row-key',
      },
      { id: 'customer', label: 'Customer', capabilities: ['read', 'project'] },
      { id: 'status', label: 'Status', capabilities: ['read', 'project'] },
    ],
    query: {
      modes: ['rows'],
      projectableColumnIds: ['id', 'customer', 'status'],
      searchableColumnIds: ['customer'],
      filterableColumnIds: ['status'],
      sortableColumnIds: ['id'],
    },
    actions: [
      {
        id: 'set-status',
        label: 'Set status',
        selectionScopes: ['explicit-ids'],
        requiresConfirmation: true,
      },
    ],
    controls: [{ id: 'data-surface.action.set-status', label: 'Set status' }],
    limits: { maxQueryRows: 50, maxQueryBytes: 100_000, maxSelectionSize: 10 },
  },
  getSnapshot: () => ({
    revision,
    state: { rows: rows.map((r) => ({ ...r })) },
  }),
  execute: async (command) => {
    // DataSurfaceCommandExecution is `{ ok: false } | undefined`: `undefined`
    // means success (the registry re-reads getSnapshot()'s bumped revision
    // itself); only a failure needs an explicit return.
    const outcome = applySetStatus(command);
    if (!outcome.ok) {
      return { ok: false as const, reason: outcome.reason };
    }
    return undefined;
  },
});

let registryEvents = $state<DataSurfaceRegistryEvent[]>([]);
registry.subscribe((event) => {
  registryEvents = [...registryEvents, event].slice(-10);
});

// --- Demo transport: canned reply for "mark order N shipped" ---------------

const transport = createInMemoryAssistantTransport({
  respond: (threadId, userMessage) => {
    const match = userMessage.content.match(/mark order (\d+) shipped/i);
    if (match) {
      return {
        id: `assistant-${Date.now()}`,
        threadId,
        content: `I can mark order ${match[1]} as shipped — review the proposed change below.`,
        role: 'assistant',
        createdAt: new Date(),
      };
    }
    return null;
  },
});

// --- Demo action client: preview never mutates, apply calls the surface ----

const actionClient = {
  async preview(request: {
    requestId: string;
    identity: DataSurfaceIdentity;
    actionId: string;
    payload?: DataSurfaceJsonValue;
  }) {
    return {
      version: 1 as const,
      requestId: request.requestId,
      identity: request.identity,
      actionId: request.actionId,
      phase: 'preview' as const,
      ok: true,
      confirmationToken: 'demo-token',
      details:
        request.payload &&
        typeof request.payload === 'object' &&
        !Array.isArray(request.payload)
          ? request.payload
          : undefined,
    };
  },
  async apply(request: {
    requestId: string;
    identity: DataSurfaceIdentity;
    actionId: string;
    payload?: DataSurfaceJsonValue;
  }) {
    const result = await registry.execute({
      version: 1,
      commandId: request.requestId,
      identity: request.identity,
      expectedRevision: revision,
      controlId: `data-surface.action.${request.actionId}`,
      payload: request.payload,
    });
    return {
      version: 1 as const,
      requestId: request.requestId,
      identity: request.identity,
      actionId: request.actionId,
      phase: 'apply' as const,
      ok: result.ok,
      reason: result.ok ? undefined : result.reason,
      details: result.ok
        ? { revision: result.revision ?? revision }
        : undefined,
    };
  },
};

const controller = createAssistantDockController({
  transport,
  registry,
  actionClient,
});

let ready = $state(false);
$effect(() => {
  // Cycle-2 third final sweep: this IIFE is not awaited by the effect body,
  // so a rejecting createThread/openThread previously escaped as an
  // unhandled rejection (the same shape fixed everywhere else in this demo
  // and in AssistantDock.svelte itself). loadThreads()/openThread() already
  // catch internally; only createThread can still reject.
  (async () => {
    try {
      await controller.loadThreads();
      const thread =
        controller.threads[0] ??
        (await controller.createThread('Order support'));
      await controller.openThread(thread.id);
    } catch {
      // Already recorded on controller.error.
    } finally {
      ready = true;
    }
  })();
  controller.startPolling();
  return () => controller.dispose();
});

async function handleSend(
  content: string,
  attachments: AssistantAttachmentRef[],
) {
  await controller.send(content, attachments);
  const match = content.match(/mark order (\d+) shipped/i);
  if (match) {
    const rowId = `order-${match[1]}`;
    await controller.previewAction({
      version: 1,
      requestId: `demo-${Date.now()}`,
      identity,
      actionId: 'set-status',
      phase: 'preview',
      selection: { scope: 'explicit-ids', rowIds: [rowId] },
      payload: { rowId, status: 'shipped' },
    });
  }
}

async function handleUpload(
  files: FileList,
): Promise<AssistantAttachmentRef[]> {
  // Cycle-2 third final: mirrors AssistantDock.svelte's handleUpload — the
  // composer's own catch needs the rejection, so this rethrows (never
  // returns [] on failure) after recording it on controller.error.
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
  await controller.applyAction(requestId);
}
</script>

<svelte:head>
  <title>AssistantDock Demo</title>
</svelte:head>

<ThemeProvider colorScheme="system" persist={true}>
  <div class="assistant-dock-demo">
    <header class="topbar">
      <div class="title-block">
        <h1>AssistantDock demo</h1>
        <p>
          Type <code>mark order 2 shipped</code> and confirm the proposed
          action to see the orders table below update.
        </p>
      </div>
    </header>

    <main class="workspace">
      <section class="orders-panel">
        <h2>Demo orders surface (revision {revision})</h2>
        <table>
          <thead>
            <tr>
              <th>Order</th>
              <th>Customer</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {#each rows as row (row.id)}
              <tr>
                <td>{row.id}</td>
                <td>{row.customer}</td>
                <td class={`status status-${row.status}`}>{row.status}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </section>

      <section class="dock-panel">
        {#if ready}
          <AssistantThreadList
            threads={controller.threads}
            activeThreadId={controller.activeThreadId}
            onselect={(threadId) => controller.openThread(threadId)}
            oncreate={async () => {
              // Cycle-2 third final sweep: AssistantThreadList calls
              // `oncreate` from an un-awaited onclick, so a rejecting
              // createThread previously escaped as an unhandled rejection
              // here too (mirrors AssistantDock.svelte's handleCreateThread
              // fix).
              try {
                const thread =
                  await controller.createThread('New conversation');
                await controller.openThread(thread.id);
              } catch {
                // Already recorded on controller.error.
              }
            }}
          />

          {#if controller.surfaces.length === 0}
            <p>No data surfaces mounted.</p>
          {/if}

          <div class="dock-scroll">
            <ul class="messages">
              {#each controller.messages as message (message.id)}
                <li>
                  <MessageBubble
                    variant={message.role === 'system'
                      ? 'system'
                      : message.role === 'user'
                        ? 'default'
                        : 'agent'}
                    own={message.role === 'user'}
                    content={message.content}
                  />
                </li>
              {/each}
            </ul>

            {#if controller.actions.size > 0}
              <ul class="actions">
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
          </div>

          <AssistantComposer
            onsend={handleSend}
            onupload={handleUpload}
            disabled={!controller.activeThreadId}
          />
        {:else}
          <p>Loading…</p>
        {/if}
      </section>
    </main>
  </div>
</ThemeProvider>

<style>
  .assistant-dock-demo {
    display: flex;
    flex-direction: column;
    height: 100vh;
    padding: var(--smrt-spacing-4, 1rem);
    box-sizing: border-box;
    font-family: var(--smrt-font-family, system-ui, sans-serif);
    background: var(--smrt-color-surface, #ffffff);
    color: var(--smrt-color-on-surface, #1a1c1e);
  }
  .workspace {
    display: flex;
    gap: var(--smrt-spacing-5, 1.5rem);
    flex: 1;
    min-height: 0;
  }
  .orders-panel {
    flex: 1;
    min-width: 280px;
  }
  .dock-panel {
    flex: 1;
    min-width: 320px;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
    border-radius: var(--smrt-radius-medium, 8px);
  }
  .dock-panel > :global(*:first-child) {
    flex-shrink: 0;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font: var(--smrt-typography-body-medium-font, 0.875rem/1.4 sans-serif);
  }
  th,
  td {
    text-align: left;
    padding: var(--smrt-spacing-2, 0.35rem) var(--smrt-spacing-3, 0.5rem);
    border-bottom: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
  }
  .status-shipped {
    color: var(--smrt-color-success, #1a7a3a);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .dock-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--smrt-spacing-3, 0.75rem);
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-3, 0.75rem);
  }
  .messages,
  .actions {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2, 0.5rem);
  }
</style>
