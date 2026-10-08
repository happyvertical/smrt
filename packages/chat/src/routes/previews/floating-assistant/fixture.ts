import {
  createDataSurfaceRegistry,
  type DataSurfaceActionRequest,
  type DataSurfaceActionResult,
  type DataSurfaceDescriptor,
} from '@happyvertical/smrt-ui/data-surface';
import { createAssistantChoiceSourceRegistry } from '../../../svelte/components/assistant/assistant-choices.svelte.js';
import type { AssistantTransport } from '../../../svelte/components/assistant/assistant-transport.js';
import type { AssistantClientToolSource } from '../../../svelte/components/assistant/client-tools.js';
import type { AssistantActionClient } from '../../../svelte/components/assistant/create-assistant-dock-controller.svelte.js';

/** Deterministic in-memory seams for the real floating dock's preview and tests. */
export function createFloatingFixture() {
  const identity = {
    surfaceId: 'preview-orders',
    kind: 'table' as const,
    subject: { type: 'tenant' as const, id: 'preview' },
  };
  const registry = createDataSurfaceRegistry();
  const descriptor: DataSurfaceDescriptor = {
    version: 1,
    identity,
    schemaVersion: 1,
    label: 'Preview orders',
    rowKey: 'id',
    columns: [
      { id: 'id', label: 'ID', capabilities: ['read'], role: 'row-key' },
    ],
    query: {
      modes: ['rows'],
      projectableColumnIds: ['id'],
      searchableColumnIds: [],
      filterableColumnIds: [],
      sortableColumnIds: [],
    },
    actions: [],
    controls: [],
    limits: { maxQueryRows: 10, maxQueryBytes: 10000, maxSelectionSize: 10 },
  };
  registry.register({
    descriptor,
    getSnapshot: () => ({ revision: 1, state: {} }),
  });
  const evidence = {
    executions: 0,
    loads: 0,
    decisions: [] as boolean[],
    keys: [] as string[],
    choices: [] as string[],
  };
  let sequence = 0;
  const choiceSources = createAssistantChoiceSourceRegistry();
  choiceSources.register({
    id: 'preview',
    description: 'Offer a preview choice',
    offer: () => ({
      title: 'Pick a layout',
      options: [{ id: 'compact', label: 'Compact layout' }],
    }),
    apply: (option) => {
      evidence.choices.push(option.id);
    },
  });
  const pageTools: AssistantClientToolSource = {
    list: () => [
      {
        name: 'preview_write',
        description: 'Update preview order',
        effect: 'write',
        owner: 'generated',
        inputSchema: { type: 'object' },
      },
    ],
    execute: async () => {
      evidence.executions += 1;
      return '{"ok":true}';
    },
  };
  const transport: AssistantTransport = {
    listThreads: async () => [
      {
        id: 'preview-thread',
        title: 'Preview conversation',
        isResolved: false,
        messageCount: 0,
      },
    ],
    loadMessages: async () => {
      evidence.loads += 1;
      return [];
    },
    sendMessage: async (input) => {
      sequence += 1;
      if (input.content === 'error')
        throw new Error('Preview transport unavailable');
      if (input.content === 'work') {
        input.onEvent?.({
          type: 'status',
          status: {
            state: 'working',
            label: 'Preview working',
            cancellable: true,
          },
        });
        await new Promise<void>((resolve) =>
          input.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
        return { inProgress: false };
      }
      return {
        inProgress: false,
        clientToolCalls: {
          continuationId: `continuation-${sequence}`,
          calls: [
            {
              id: `call-${sequence}`,
              name:
                input.content === 'choices'
                  ? 'assistant_offer_preview'
                  : 'preview_write',
              args: {},
              effect: 'write',
            },
          ],
        },
      };
    },
    resumeTurn: async (input) => {
      evidence.decisions.push(...input.results.map((result) => result.ok));
      return { inProgress: false };
    },
  };
  const result = (
    request: DataSurfaceActionRequest,
    phase: 'preview' | 'apply',
  ): DataSurfaceActionResult => ({
    version: 1,
    requestId: request.requestId,
    identity,
    actionId: request.actionId,
    phase,
    ok: true,
  });
  const actionClient: AssistantActionClient = {
    preview: async (request) => result(request, 'preview'),
    apply: async (request, key) => {
      evidence.keys.push(key);
      return result(request, 'apply');
    },
  };
  const proposal = (
    requestId = 'preview-action',
  ): DataSurfaceActionRequest => ({
    version: 1,
    requestId,
    identity,
    actionId: 'ship',
    phase: 'preview',
    selection: { scope: 'explicit-ids', rowIds: ['order-1'] },
  });
  return {
    registry,
    transport,
    pageTools,
    choiceSources,
    actionClient,
    proposal,
    evidence,
  };
}
