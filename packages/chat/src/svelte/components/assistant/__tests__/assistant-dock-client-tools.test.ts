// @vitest-environment jsdom
/**
 * #2908: streamed turns and browser-executed tools in the dock controller —
 * the client-tool round trip through a transport that suspends and resumes,
 * the effect rules (read runs, write waits for the user unless a consent-gated
 * registry owns it, destructive always waits), cancellation, the generic
 * status, and the dock's own proposal tool.
 */
import {
  createDataSurfaceRegistry,
  type DataSurfaceActionRequest,
  type DataSurfaceDescriptor,
} from '@happyvertical/smrt-ui/data-surface';
import { render, screen, userEvent } from '@happyvertical/smrt-vitest/svelte';
import { flushSync } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import type {
  AssistantClientToolCall,
  AssistantClientToolResult,
  AssistantStatus,
} from '../../../../assistant-turn-events.js';
import AssistantDock from '../AssistantDock.svelte';
import type {
  AssistantMessage,
  AssistantResumeTurnInput,
  AssistantSendMessageInput,
  AssistantSendMessageResult,
  AssistantTransport,
} from '../assistant-transport.js';
import {
  ASSISTANT_PROPOSE_ACTION_TOOL,
  type AssistantClientTool,
  type AssistantClientToolSource,
} from '../client-tools.js';
import { createAssistantDockController } from '../create-assistant-dock-controller.svelte.js';

function message(
  id: string,
  role: AssistantMessage['role'],
  content: string,
): AssistantMessage {
  return {
    id,
    threadId: 't1',
    role,
    content,
    createdAt: new Date(0).toISOString(),
  };
}

/**
 * A transport whose first send suspends on `calls`, and whose resume answers
 * with a reply. Records what the dock sent.
 */
function suspendingTransport(calls: AssistantClientToolCall[]) {
  const sent: AssistantSendMessageInput[] = [];
  const resumed: AssistantResumeTurnInput[] = [];
  const transport: AssistantTransport & {
    sent: typeof sent;
    resumed: typeof resumed;
  } = {
    sent,
    resumed,
    async listThreads() {
      return [{ id: 't1', title: 'T', isResolved: false, messageCount: 0 }];
    },
    async createThread() {
      return { id: 't1', title: 'T', isResolved: false, messageCount: 0 };
    },
    async loadMessages() {
      return [];
    },
    async uploadAttachment() {
      throw new Error('no');
    },
    async sendMessage(input) {
      sent.push(input);
      input.onEvent?.({
        type: 'status',
        status: { state: 'working', label: 'Thinking…' },
      });
      input.onEvent?.({
        type: 'step',
        step: {
          kind: 'tool_call',
          callId: calls[0]?.id ?? 'x',
          tool: calls[0]?.name ?? 'x',
          label: 'Looking',
          location: 'client',
        },
      });
      return {
        inProgress: false,
        userMessage: message('u1', 'user', input.content),
        clientToolCalls: { continuationId: 'cont-1', calls },
      } satisfies AssistantSendMessageResult;
    },
    async resumeTurn(input) {
      resumed.push(input);
      if (input.signal?.aborted) {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
      input.onEvent?.({ type: 'token', text: 'All ' });
      const reply = message('a1', 'assistant', 'All done.');
      input.onEvent?.({ type: 'message', message: reply });
      return { inProgress: false, assistantMessage: reply };
    },
  };
  return transport;
}

function pageTools(
  tools: AssistantClientTool[],
  outputs: Record<string, string> = {},
) {
  const executed: Array<{ name: string; args: Record<string, unknown> }> = [];
  const source: AssistantClientToolSource & { executed: typeof executed } = {
    executed,
    list: () => tools,
    async execute(name, args) {
      executed.push({ name, args });
      return outputs[name] ?? '{"ok":true}';
    },
  };
  return source;
}

const READ_TOOL: AssistantClientTool = {
  name: 'smrt_ui_list_form_controls',
  description: 'List the form fields.',
  inputSchema: { type: 'object' },
  effect: 'read',
  owner: 'ui',
};
const STAGE_TOOL: AssistantClientTool = {
  name: 'smrt_ui_execute_form_control',
  description: 'Fill in a form field.',
  inputSchema: { type: 'object' },
  effect: 'write',
  owner: 'ui',
};
const WRITE_TOOL: AssistantClientTool = {
  name: 'articles_update',
  description: 'Update an article.',
  inputSchema: { type: 'object' },
  effect: 'write',
  owner: 'generated',
};
const DELETE_TOOL: AssistantClientTool = {
  name: 'articles_delete',
  description: 'Delete an article.',
  inputSchema: { type: 'object' },
  effect: 'destructive',
  owner: 'generated',
};

async function openController(
  transport: AssistantTransport,
  tools: AssistantClientToolSource,
  extra: Partial<Parameters<typeof createAssistantDockController>[0]> = {},
) {
  const controller = createAssistantDockController({
    transport,
    registry: createDataSurfaceRegistry(),
    pageTools: tools,
    ...extra,
  });
  await controller.loadThreads();
  await controller.openThread('t1');
  return controller;
}

async function until(check: () => boolean) {
  for (let i = 0; i < 50 && !check(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('dock browser tools (#2908)', () => {
  it('offers the page tools and runs a read call without asking', async () => {
    const transport = suspendingTransport([
      { id: 'c1', name: READ_TOOL.name, args: {}, effect: 'read' },
    ]);
    const tools = pageTools([READ_TOOL], {
      [READ_TOOL.name]: '{"fields":["title"]}',
    });
    const controller = await openController(transport, tools);
    await controller.send('what fields are there?');

    expect(transport.sent[0].clientTools?.map((t) => t.name)).toEqual([
      READ_TOOL.name,
    ]);
    expect(tools.executed).toEqual([{ name: READ_TOOL.name, args: {} }]);
    expect(transport.resumed[0]).toMatchObject({
      continuationId: 'cont-1',
      clientRequestId: transport.sent[0].clientRequestId,
      results: [{ id: 'c1', ok: true, result: '{"fields":["title"]}' }],
    });
    expect(controller.messages.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(controller.pendingSends).toEqual([]);
    expect(controller.status).toMatchObject({
      state: 'done',
      label: 'Done',
      changes: 0,
    });
  });

  it('runs a consent-gated registry write (form staging) without asking', async () => {
    const transport = suspendingTransport([
      {
        id: 'c1',
        name: STAGE_TOOL.name,
        args: { action: 'stage' },
        effect: 'write',
      },
    ]);
    const tools = pageTools([STAGE_TOOL]);
    const controller = await openController(transport, tools);
    await controller.send('fill in the title');
    expect(tools.executed).toHaveLength(1);
    expect(controller.toolRequests).toEqual([]);
  });

  it('waits for the user before an acting write, and reports a decline', async () => {
    const transport = suspendingTransport([
      { id: 'c1', name: WRITE_TOOL.name, args: { id: 'a' }, effect: 'write' },
    ]);
    const tools = pageTools([WRITE_TOOL]);
    const controller = await openController(transport, tools);
    const sending = controller.send('rename it');
    await until(() => controller.toolRequests.length > 0);
    expect(controller.toolRequests[0]).toMatchObject({
      status: 'waiting',
      description: 'Update an article.',
    });
    expect(controller.status).toMatchObject({
      state: 'working',
      label: 'Waiting for your OK…',
    });
    expect(tools.executed).toEqual([]);
    controller.declineToolRequest('c1');
    await sending;
    expect(tools.executed).toEqual([]);
    expect(transport.resumed[0].results).toEqual([
      { id: 'c1', ok: false, error: 'declined' },
    ]);
  });

  it('runs an acting write once the user allows it and counts the change', async () => {
    const transport = suspendingTransport([
      { id: 'c1', name: WRITE_TOOL.name, args: { id: 'a' }, effect: 'write' },
    ]);
    const tools = pageTools([WRITE_TOOL]);
    const controller = await openController(transport, tools);
    const sending = controller.send('rename it');
    await until(() => controller.toolRequests.length > 0);
    controller.approveToolRequest('c1');
    await sending;
    expect(tools.executed).toHaveLength(1);
    expect(controller.status).toMatchObject({ state: 'done', changes: 1 });
  });

  it('never auto-runs a destructive tool, even when the host policy says run', async () => {
    const transport = suspendingTransport([
      { id: 'c1', name: DELETE_TOOL.name, args: { id: 'a' }, effect: 'read' },
    ]);
    const tools = pageTools([DELETE_TOOL]);
    const controller = await openController(transport, tools, {
      clientToolPolicy: () => 'run',
    });
    const sending = controller.send('delete it');
    await until(() => controller.toolRequests.length > 0);
    // The server echoed `read`, but the page registry says destructive.
    expect(controller.toolRequests[0]).toMatchObject({
      effect: 'destructive',
      status: 'waiting',
    });
    expect(tools.executed).toEqual([]);
    controller.declineToolRequest('c1');
    await sending;
  });

  it('answers a call to a tool the page no longer has with not_available', async () => {
    const transport = suspendingTransport([
      { id: 'c1', name: 'gone_tool', args: {}, effect: 'read' },
    ]);
    const controller = await openController(transport, pageTools([READ_TOOL]));
    await controller.send('go');
    expect(transport.resumed[0].results).toEqual([
      { id: 'c1', ok: false, error: 'not_available' },
    ]);
  });

  it('cancel() declines waiting calls, stops the turn, and reports Stopped', async () => {
    const transport = suspendingTransport([
      { id: 'c1', name: WRITE_TOOL.name, args: {}, effect: 'write' },
    ]);
    const tools = pageTools([WRITE_TOOL]);
    const controller = await openController(transport, tools);
    const sending = controller.send('rename it');
    await until(() => controller.toolRequests.length > 0);
    expect(controller.status.cancellable).toBe(true);
    controller.cancel();
    await sending;
    expect(tools.executed).toEqual([]);
    expect(transport.resumed).toEqual([]);
    expect(controller.pendingSends).toEqual([]);
    expect(controller.status).toMatchObject({
      state: 'idle',
      label: 'Stopped',
    });
  });

  it('reports status changes to onStatus', async () => {
    const seen: AssistantStatus[] = [];
    const transport = suspendingTransport([
      { id: 'c1', name: READ_TOOL.name, args: {}, effect: 'read' },
    ]);
    const controller = await openController(transport, pageTools([READ_TOOL]), {
      onStatus: (status) => seen.push(status),
    });
    await controller.send('hi');
    flushSync();
    expect(seen.some((s) => s.state === 'working')).toBe(true);
    expect(seen.at(-1)).toMatchObject({ state: 'done' });
    controller.dispose();
  });

  it('proposes a data-surface action through the dock’s own tool, never applying it', async () => {
    const registry = createDataSurfaceRegistry();
    const identity = { surfaceId: 'articles', kind: 'table' as const };
    const descriptor: DataSurfaceDescriptor = {
      version: 1,
      identity,
      schemaVersion: 1,
      label: 'Articles',
      rowKey: 'id',
      columns: [
        { id: 'id', label: 'ID', capabilities: ['read'], role: 'row-key' },
      ],
      query: { modes: ['rows'], projectableColumnIds: ['id'] },
      actions: [
        { id: 'publish', label: 'Publish', selectionScopes: ['explicit-ids'] },
      ],
      controls: [],
      limits: { maxQueryRows: 10, maxQueryBytes: 10_000, maxSelectionSize: 10 },
    };
    registry.register({
      descriptor,
      getSnapshot: () => ({ revision: 1, state: {} }),
    });
    const previewed: DataSurfaceActionRequest[] = [];
    const apply = vi.fn();
    const transport = suspendingTransport([
      {
        id: 'p1',
        name: ASSISTANT_PROPOSE_ACTION_TOOL,
        args: { surfaceId: 'articles', actionId: 'publish', rowIds: ['a1'] },
        effect: 'read',
      },
    ]);
    const controller = createAssistantDockController({
      transport,
      registry,
      actionClient: {
        async preview(request) {
          previewed.push(request);
          return {
            version: 1,
            requestId: request.requestId,
            identity: request.identity,
            actionId: request.actionId,
            phase: 'preview',
            ok: true,
            details: { rows: 1 },
          };
        },
        apply,
      },
    });
    await controller.loadThreads();
    await controller.openThread('t1');
    await controller.send('publish a1');

    expect(transport.sent[0].clientTools?.map((t) => t.name)).toEqual([
      ASSISTANT_PROPOSE_ACTION_TOOL,
    ]);
    expect(previewed[0]).toMatchObject({
      actionId: 'publish',
      selection: { scope: 'explicit-ids', rowIds: ['a1'] },
    });
    expect(controller.actions.get('assistant-p1')?.status).toBe('previewed');
    expect(apply).not.toHaveBeenCalled();
    const result = transport.resumed[0].results[0] as AssistantClientToolResult;
    expect(result.ok).toBe(true);
    expect(JSON.parse(String(result.result))).toMatchObject({
      proposed: true,
      waitingForUser: true,
    });
  });

  it('renders a waiting call with Allow / Don’t allow in the dock', async () => {
    const transport = suspendingTransport([
      {
        id: 'c1',
        name: DELETE_TOOL.name,
        args: { id: 'a' },
        effect: 'destructive',
      },
    ]);
    const tools = pageTools([DELETE_TOOL]);
    let controller:
      | ReturnType<typeof createAssistantDockController>
      | undefined;
    render(AssistantDock, {
      props: {
        transport,
        registry: createDataSurfaceRegistry(),
        pageTools: tools,
        oncontroller: (c: ReturnType<typeof createAssistantDockController>) => {
          controller = c;
        },
      },
    });
    await until(() => Boolean(controller));
    await controller?.openThread('t1');
    const sending = controller?.send('delete it');
    expect(await screen.findByText('Delete an article.')).toBeTruthy();
    expect(screen.getByText("This can't be undone.")).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await sending;
    expect(tools.executed).toHaveLength(1);
  });
});

describe('readAssistantTurnResult (#2908)', () => {
  it('maps a streamed suspension and persisted messages into a send result', async () => {
    const { encodeAssistantTurnEvent } = await import(
      '../../../../assistant-turn-events.js'
    );
    const { readAssistantTurnResult } = await import(
      '../assistant-transport.js'
    );
    const frames = [
      encodeAssistantTurnEvent({
        type: 'status',
        status: { state: 'working', label: 'Thinking…' },
      }),
      ': heartbeat\n\n',
      encodeAssistantTurnEvent({
        type: 'message',
        message: { id: 'm1', role: 'tool', content: 'x' },
      }),
      encodeAssistantTurnEvent({
        type: 'client_tool_calls',
        continuationId: 'k',
        calls: [{ id: 'c', name: 'n', args: {}, effect: 'read' }],
      }),
    ].join('');
    const response = new Response(frames, {
      headers: { 'content-type': 'text/event-stream' },
    });
    const seen: string[] = [];
    const result = await readAssistantTurnResult<{
      id: string;
      role: string;
      content: string;
    }>(response, {
      mapMessage: (wire) =>
        message(wire.id, wire.role as AssistantMessage['role'], wire.content),
      onEvent: (event) => seen.push(event.type),
    });
    expect(seen).toEqual(['status', 'message', 'client_tool_calls']);
    expect(result.messages?.map((m) => m.id)).toEqual(['m1']);
    expect(result.clientToolCalls).toEqual({
      continuationId: 'k',
      calls: [{ id: 'c', name: 'n', args: {}, effect: 'read' }],
    });
  });
});
