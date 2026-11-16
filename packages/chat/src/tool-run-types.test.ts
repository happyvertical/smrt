import type { PrincipalTool } from '@happyvertical/smrt-agents';
import { describe, expect, it, vi } from 'vitest';
import {
  type AssistantTurnOptions,
  runAssistantTurn,
} from './assistant-turn.js';
import {
  assertToolRunType,
  mayEscalateToWorkflow,
  ToolRunTypeRefusal,
} from './tool-run-types.js';

const tool: PrincipalTool = {
  slug: 'builder.restructure',
  aiTool: {
    type: 'function',
    function: {
      name: 'builder_restructure',
      description: 'Restructure the app',
      parameters: {},
    },
  },
  execute: vi.fn(async () => ({})),
};
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
  selection: {
    engine: 'codex',
    tier: 'best',
    model: 'gpt-6-astra',
    effort: 'high',
  },
  designTools: [tool.slug],
};

describe('tools limited to workflow runs', () => {
  it('refuses by trusted annotation or host list, and allows any run type without one', () => {
    expect(() =>
      assertToolRunType(
        {},
        { slug: 'custom', annotations: { runTypes: ['workflow'] } },
      ),
    ).toThrow(ToolRunTypeRefusal);
    expect(() =>
      assertToolRunType({ designTools: ['custom'] }, { slug: 'custom' }),
    ).toThrow(ToolRunTypeRefusal);
    expect(() =>
      assertToolRunType(
        {},
        { slug: 'both', annotations: { runTypes: ['workflow', 'turn'] } },
      ),
    ).not.toThrow();
    expect(() => assertToolRunType({}, { slug: 'plain' })).not.toThrow();
  });

  it('escalates only with the setting on and a host that starts workflow runs', () => {
    const onDesignEscalation = async () => ({ runId: 'r' });
    expect(mayEscalateToWorkflow({ onDesignEscalation })).toBe(true);
    expect(
      mayEscalateToWorkflow({
        onDesignEscalation,
        assistantSettings: { escalateToWorkflow: false },
      }),
    ).toBe(false);
    expect(mayEscalateToWorkflow({})).toBe(false);
  });

  it('hands an external turn to a workflow run without running the tool, and reports what the turn used', async () => {
    const execute = vi.fn();
    const executions = vi.fn();
    const enqueue = vi.fn(async () => ({ runId: 'workflow-run' }));
    const { result, events } = await collect({
      ...base,
      onDesignEscalation: enqueue,
      onExecution: executions,
      turnDriver: {
        async run(context, callbacks) {
          expect(context.selection).toEqual(base.selection);
          callbacks.execution?.({
            engine: 'codex',
            requestedModel: 'gpt-6-astra',
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
    expect(result.runId).toBe('workflow-run');
    expect(executions).toHaveBeenCalledWith(
      expect.objectContaining({
        engine: 'codex',
        requestedModel: 'gpt-6-astra',
        effort: 'high',
        tokens: 12,
        toolCalls: 0,
      }),
    );
    expect(
      events.some(
        (event) => event.type === 'done' && event.runId === 'workflow-run',
      ),
    ).toBe(true);
  });

  it('ends an external turn with a typed refusal when no workflow run can take it', async () => {
    const execute = vi.fn();
    const { events } = await collect({
      ...base,
      turnDriver: {
        async run(context) {
          context.beforeToolExecution(tool.slug);
          execute();
        },
      },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'error', code: 'tool_run_type' }),
    );
  });

  it('queues a known workflow request before any model or driver call', async () => {
    const run = vi.fn();
    const enqueue = vi.fn(async () => ({ runId: 'known-workflow' }));
    const { result } = await collect({
      ...base,
      deferDesignTurn: true,
      onDesignEscalation: enqueue,
      turnDriver: { run },
    });
    expect(run).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(result.runId).toBe('known-workflow');
  });
});
