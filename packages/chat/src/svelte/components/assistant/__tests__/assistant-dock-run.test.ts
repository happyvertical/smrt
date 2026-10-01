// @vitest-environment jsdom
/**
 * The supervised run (#assistant-watch): goal and current step, pause and
 * continue, waiting for the person (a confirm, a staged proposal, a host
 * hold, a limit), done / failed / cancelled, and the tool filter that keeps
 * a turned-off capability from ever being offered.
 */
import { createDataSurfaceRegistry } from '@happyvertical/smrt-ui/data-surface';
import { describe, expect, it } from 'vitest';
import type { AssistantClientToolCall } from '../../../../assistant-turn-events.js';
import type {
  AssistantMessage,
  AssistantResumeTurnInput,
  AssistantSendMessageInput,
  AssistantTransport,
} from '../assistant-transport.js';
import type {
  AssistantClientTool,
  AssistantClientToolSource,
} from '../client-tools.js';
import {
  type AssistantRun,
  createAssistantDockController,
} from '../create-assistant-dock-controller.svelte.js';

function message(id: string, role: AssistantMessage['role'], content: string) {
  return {
    id,
    threadId: 't1',
    role,
    content,
    createdAt: new Date(0).toISOString(),
  } satisfies AssistantMessage;
}

/** Suspends on `legs[0]`, then each resume on the next leg; ends with a reply. */
function scriptedTransport(
  legs: AssistantClientToolCall[][],
  finish: {
    stoppedReason?: 'stop' | 'max_steps' | 'budget';
    fail?: boolean;
  } = {},
) {
  const sent: AssistantSendMessageInput[] = [];
  const resumed: AssistantResumeTurnInput[] = [];
  let leg = 0;
  const suspendOrFinish = (
    input: AssistantSendMessageInput | AssistantResumeTurnInput,
  ) => {
    const calls = legs[leg];
    leg += 1;
    if (calls) {
      for (const call of calls) {
        input.onEvent?.({
          type: 'step',
          step: {
            kind: 'tool_call',
            callId: call.id,
            tool: call.name,
            label: `Step ${call.id}`,
            location: 'client',
          },
        });
      }
      return { continuationId: `cont-${leg}`, calls };
    }
    return null;
  };
  const transport: AssistantTransport & {
    sent: typeof sent;
    resumed: typeof resumed;
  } = {
    sent,
    resumed,
    listThreads: async () => [
      { id: 't1', title: 'T', isResolved: false, messageCount: 0 },
    ],
    createThread: async () => ({
      id: 't1',
      title: 'T',
      isResolved: false,
      messageCount: 0,
    }),
    loadMessages: async () => [],
    uploadAttachment: async () => {
      throw new Error('no');
    },
    async sendMessage(input) {
      sent.push(input);
      const suspension = suspendOrFinish(input);
      return {
        inProgress: false,
        userMessage: message('u1', 'user', input.content),
        ...(suspension ? { clientToolCalls: suspension } : {}),
      };
    },
    async resumeTurn(input) {
      resumed.push(input);
      const suspension = suspendOrFinish(input);
      if (suspension) return { inProgress: false, clientToolCalls: suspension };
      if (finish.fail) throw new Error('The assistant ran into a problem.');
      input.onEvent?.({
        type: 'done',
        stoppedReason: finish.stoppedReason ?? 'stop',
      });
      return {
        inProgress: false,
        assistantMessage: message('a1', 'assistant', 'Done.'),
      };
    },
  };
  return transport;
}

const NAV: AssistantClientTool = {
  name: 'nav_site_section',
  description: 'Open a section',
  inputSchema: { type: 'object' },
  effect: 'read',
  proposal: true,
};
const STAGE: AssistantClientTool = {
  name: 'smrt_ui_execute_form_control',
  description: 'Fill in a field',
  inputSchema: { type: 'object' },
  effect: 'write',
  proposal: true,
};
const WRITE: AssistantClientTool = {
  name: 'articles_update',
  description: 'Update an article',
  inputSchema: { type: 'object' },
  effect: 'write',
};

function tools(list: AssistantClientTool[]) {
  const executed: string[] = [];
  const source: AssistantClientToolSource & { executed: string[] } = {
    executed,
    list: () => list,
    async execute(name) {
      executed.push(name);
      return '{"ok":true}';
    },
  };
  return source;
}

async function open(
  transport: AssistantTransport,
  pageTools: AssistantClientToolSource,
  extra: Partial<Parameters<typeof createAssistantDockController>[0]> = {},
) {
  const controller = createAssistantDockController({
    transport,
    registry: createDataSurfaceRegistry(),
    pageTools,
    settleTimeoutMs: 0,
    ...extra,
  });
  await controller.loadThreads();
  await controller.openThread('t1');
  return controller;
}

async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const call = (id: string, name: string): AssistantClientToolCall => ({
  id,
  name,
  args: {},
  effect: 'read',
});

describe('assistant run', () => {
  it('tracks the goal and steps across page changes and ends done', async () => {
    const transport = scriptedTransport([
      [call('1', NAV.name)],
      [call('2', NAV.name)],
    ]);
    const page = tools([NAV]);
    const seen: Array<AssistantRun | null> = [];
    const controller = await open(transport, page, {
      onRun: (run) => seen.push(run),
    });
    const sending = controller.send(
      'Show me upcoming meetings,   then the council page',
    );
    await until(() => (controller.run?.stepCount ?? 0) > 0);
    expect(controller.run).toMatchObject({
      goal: 'Show me upcoming meetings, then the council page',
      state: 'running',
      step: 'Step 1',
    });
    await sending;
    expect(controller.run).toMatchObject({
      state: 'done',
      stepCount: 2,
      pageTools: [NAV.name, NAV.name],
      waitingFor: null,
      stoppedReason: null,
    });
    expect(controller.run?.endedAt).not.toBeNull();
    expect(seen.some((run) => run?.state === 'running')).toBe(true);
    controller.dismissRun();
    expect(controller.run).toBeNull();
    controller.dispose();
  });

  it('pauses before the next step and continues', async () => {
    const transport = scriptedTransport([[call('1', NAV.name)]]);
    const page = tools([NAV]);
    const controller = await open(transport, page);
    // Pause as soon as the run starts: the first page step must wait.
    const sending = controller.send('go');
    controller.pauseRun();
    expect(controller.run?.state).toBe('paused');
    expect(controller.status.label).toBe('Paused');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(page.executed).toEqual([]);
    controller.continueRun();
    await sending;
    expect(page.executed).toEqual([NAV.name]);
    expect(controller.run?.state).toBe('done');
    controller.dispose();
  });

  it('stops a run paused for too long', async () => {
    const transport = scriptedTransport([[call('1', NAV.name)]]);
    const page = tools([NAV]);
    const controller = await open(transport, page, { maxPauseMs: 10 });
    const sending = controller.send('go');
    controller.pauseRun();
    await sending;
    expect(page.executed).toEqual([]);
    expect(controller.run).toMatchObject({
      state: 'cancelled',
      stoppedReason: 'paused_too_long',
    });
    controller.dispose();
  });

  it('waits for the person on a confirm, and after staging a proposal', async () => {
    const confirmTransport = scriptedTransport([
      [{ ...call('1', WRITE.name), effect: 'write' }],
    ]);
    const controller = await open(confirmTransport, tools([WRITE]));
    const sending = controller.send('rename it');
    await until(() => controller.toolRequests.length > 0);
    expect(controller.run?.state).toBe('waiting');
    expect(controller.run?.waitingFor).toEqual({ kind: 'confirm', count: 1 });
    controller.declineToolRequest('1');
    await sending;
    expect(controller.run?.state).toBe('done');
    controller.dispose();

    const stageTransport = scriptedTransport([
      [{ ...call('1', STAGE.name), effect: 'write' }],
    ]);
    const staged = await open(stageTransport, tools([STAGE]));
    await staged.send('fill the event form');
    // Nothing was saved: the value is staged and waits for review.
    expect(staged.run?.state).toBe('waiting');
    expect(staged.run?.waitingFor).toEqual({ kind: 'review', count: 1 });
    staged.acknowledgeRun();
    expect(staged.run?.state).toBe('done');
    staged.dispose();
  });

  it('holds for a host choice until it is released', async () => {
    const transport = scriptedTransport([]);
    const controller = await open(transport, tools([]));
    await controller.send('make three pictures');
    expect(controller.run?.state).toBe('done');
    const release = controller.holdForUser({
      id: 'pictures',
      kind: 'choice',
      label: 'Pick a picture',
    });
    expect(controller.run?.waitingFor).toEqual({
      kind: 'choice',
      count: 1,
      label: 'Pick a picture',
    });
    expect(controller.run?.state).toBe('waiting');
    release();
    expect(controller.run?.state).toBe('done');
    controller.dispose();
  });

  it('asks to continue after the step or budget limit', async () => {
    const transport = scriptedTransport([[call('1', NAV.name)]], {
      stoppedReason: 'max_steps',
    });
    const controller = await open(transport, tools([NAV]));
    await controller.send('look everywhere');
    expect(controller.run).toMatchObject({
      state: 'waiting',
      waitingFor: { kind: 'continue', count: 1 },
      stoppedReason: 'max_steps',
    });
    controller.dispose();
  });

  it('fails red on an error and ends cancelled on Stop', async () => {
    const failing = scriptedTransport([[call('1', NAV.name)]], { fail: true });
    const controller = await open(failing, tools([NAV]));
    await expect(controller.send('go')).rejects.toThrow();
    expect(controller.run).toMatchObject({
      state: 'failed',
      stoppedReason: 'error',
      error: 'The assistant ran into a problem.',
    });
    controller.dispose();

    const transport = scriptedTransport([[call('1', NAV.name)]]);
    const stopped = await open(transport, tools([NAV]));
    const sending = stopped.send('go');
    stopped.pauseRun();
    stopped.cancel();
    await sending;
    expect(stopped.run).toMatchObject({
      state: 'cancelled',
      stoppedReason: 'user',
    });
    stopped.dispose();
  });

  it('never offers or runs a tool the host filter turns off', async () => {
    const transport = scriptedTransport([[call('1', NAV.name)]]);
    const page = tools([NAV, STAGE]);
    const controller = await open(transport, page, {
      clientToolFilter: (tool) => !tool.name.startsWith('nav_'),
    });
    await controller.send('open events');
    expect(transport.sent[0].clientTools?.map((t) => t.name)).toEqual([
      STAGE.name,
    ]);
    expect(page.executed).toEqual([]);
    expect(transport.resumed[0].results).toEqual([
      { id: '1', ok: false, error: 'not_available' },
    ]);
    controller.dispose();
  });
});
