import type { PrincipalTool } from '@happyvertical/smrt-agents';
import { resolveWorkProfile } from '@happyvertical/smrt-inference';
import { describe, expect, it, vi } from 'vitest';
import {
  type AssistantTurnOptions,
  runAssistantTurn,
} from './assistant-turn.js';
import {
  assertWorkProfileTool,
  WorkProfileEscalation,
} from './work-profile.js';

const tool: PrincipalTool = {
  slug: 'builder.restructure',
  aiTool: {
    type: 'function',
    function: {
      name: 'builder_restructure',
      description: 'Design',
      parameters: {},
    },
  },
  execute: vi.fn(async () => ({})),
};
const assist = resolveWorkProfile({
  engine: 'codex',
  settings: { model: 'codex-test' },
});
const design = resolveWorkProfile({
  engine: 'codex',
  profile: 'design',
  settings: { model: 'codex-test' },
});
async function collect(options: AssistantTurnOptions) {
  const events = [];
  const turn = runAssistantTurn(options);
  while (true) {
    const item = await turn.next();
    if (item.done) return { events, result: item.value };
    events.push(item.value);
  }
}
const base: AssistantTurnOptions = {
  principal: {
    runAsUserId: 'owner',
    tenantId: 'tenant',
    allowedTools: [tool.slug],
  },
  permissions: ['builder.restructure'],
  userMessage: 'Change the app',
  extraTools: [tool],
  workProfile: assist,
  designTools: [tool.slug],
  resolveWorkProfile: async () => design,
};

describe('host-selected work profiles', () => {
  it('intercepts the original assist call and restarts once with the same authority', async () => {
    const execute = vi.fn();
    const profiles: string[] = [];
    const metadata = vi.fn();
    const { events, result } = await collect({
      ...base,
      onWorkRun: metadata,
      turnDriver: {
        async run(context, callbacks) {
          profiles.push(context.workProfile!.name);
          expect(context.principal).toBe(base.principal);
          expect(context.permissions).toBe(base.permissions);
          context.beforeToolExecution(tool.slug);
          execute();
          callbacks.done({ text: 'Designed' });
        },
      },
    });
    expect(result.content).toBe('Designed');
    expect(profiles).toEqual(['assist', 'design']);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(
      events.some(
        (event) =>
          event.type === 'status' &&
          event.status.label === 'Thinking this through',
      ),
    ).toBe(true);
    expect(metadata).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: 'design',
        engine: 'codex',
        effort: design.effort,
      }),
    );
  });

  it('keeps owner approval after escalation and never runs a denied destructive call', async () => {
    const execute = vi.fn();
    const wait = vi.fn(async () => ({ approved: false }));
    await collect({
      ...base,
      waitForApproval: wait,
      turnDriver: {
        async run(context, callbacks) {
          context.beforeToolExecution(tool.slug);
          await callbacks.toolCall({ id: 'call', name: tool.slug, args: {} });
          const decision = await callbacks.approvalNeeded({
            id: 'hold',
            callId: 'call',
            tool: tool.slug,
            summary: 'Change app?',
          });
          if (decision.approved) execute();
          callbacks.done({ text: 'Stopped' });
        },
      },
    });
    expect(wait).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    0,
  ])('preserves external usage %s without inventing tokens', async (tokens) => {
    const metadata = vi.fn();
    await collect({
      ...base,
      onWorkRun: metadata,
      designTools: [],
      turnDriver: {
        async run(_context, callbacks) {
          callbacks.done({
            text: 'Done',
            workRun: {
              profile: assist.name,
              engine: assist.engine,
              effort: assist.effort,
              durationMs: 1,
              toolCalls: 0,
              ...(tokens !== undefined ? { tokens } : {}),
            },
          });
        },
      },
    });
    const workRun = metadata.mock.calls[0]?.[0];
    expect(workRun).not.toHaveProperty('model');
    if (tokens === undefined) expect(workRun).not.toHaveProperty('tokens');
    else expect(workRun).toHaveProperty('tokens', 0);
  });

  it('queues a known design turn before any model or driver call', async () => {
    const run = vi.fn();
    const enqueue = vi.fn(async () => ({ runId: 'known-design' }));
    const { result } = await collect({
      ...base,
      workProfile: design,
      deferDesignTurn: true,
      onDesignEscalation: enqueue,
      turnDriver: { run },
    });
    expect(run).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(result.runId).toBe('known-design');
  });

  it('hands escalation to a durable host without running an inline design pass', async () => {
    const execute = vi.fn();
    const metadata = vi.fn();
    const enqueue = vi.fn(async () => ({ runId: 'design-run' }));
    const { result, events } = await collect({
      ...base,
      onDesignEscalation: enqueue,
      onWorkRun: metadata,
      turnDriver: {
        async run(context, callbacks) {
          callbacks.execution?.({
            profile: assist.name,
            engine: assist.engine,
            effort: assist.effort,
            durationMs: 1,
            tokens: 12,
            toolCalls: 0,
          });
          context.beforeToolExecution(tool.slug);
          execute();
        },
      },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(result.runId).toBe('design-run');
    expect(metadata).toHaveBeenCalledWith(
      expect.objectContaining({ profile: 'assist', tokens: 12, toolCalls: 0 }),
    );
    expect(metadata.mock.calls[0]?.[0]).not.toHaveProperty('model');
    expect(
      events.some(
        (event) => event.type === 'done' && event.runId === 'design-run',
      ),
    ).toBe(true);
  });

  it('uses trusted annotations and supports explicit opt-out and background without escalation', () => {
    expect(() =>
      assertWorkProfileTool(
        { workProfile: assist },
        { slug: 'custom', annotations: { workProfile: 'design' } },
      ),
    ).toThrow(WorkProfileEscalation);
    expect(() =>
      assertWorkProfileTool(
        {
          workProfile: { ...assist, autoEscalate: false },
          designTools: ['custom'],
        },
        { slug: 'custom' },
      ),
    ).not.toThrow();
    expect(() =>
      assertWorkProfileTool(
        {
          workProfile: { ...assist, name: 'background' },
          designTools: ['custom'],
        },
        { slug: 'custom' },
      ),
    ).not.toThrow();
  });
});
