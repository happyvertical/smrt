import { describe, expect, it } from 'vitest';
import { SmrtObject } from '../object.js';
import { smrt } from '../registry.js';
import { MCPGenerator, type MCPTaskStore } from './mcp.js';

@smrt({ mcp: { include: ['slowAction'], tasks: ['slowAction'] } })
class TaskEnabledProtocolProbe extends SmrtObject {
  async slowAction(options: { prompt: string }) {
    return { prompt: options.prompt };
  }
}

@smrt({ mcp: { include: ['slowAction'] } })
class TaskDisabledProtocolProbe extends SmrtObject {
  async slowAction(options: { prompt: string }) {
    return { prompt: options.prompt };
  }
}

describe('MCP Tasks extension eligibility', () => {
  it('defaults task support off unless a model explicitly opts in', async () => {
    const generator = new MCPGenerator();
    expect(
      await generator.supportsTaskTool('taskdisabledprotocolprobe_slowaction'),
    ).toBe(false);
    expect(
      await generator.supportsTaskTool('taskenabledprotocolprobe_slowaction'),
    ).toBe(true);
  });

  it('projects exact custom-action arguments into a durable task store', async () => {
    let received: Parameters<MCPTaskStore['createTask']>[0] | undefined;
    const taskStore: MCPTaskStore = {
      createTask: async (input) => {
        received = input;
        return {
          taskId: 'task-1',
          status: 'working',
          createdAt: '2026-08-09T00:00:00.000Z',
          lastUpdatedAt: '2026-08-09T00:00:00.000Z',
          ttlMs: 60_000,
        };
      },
    };
    const generator = new MCPGenerator({}, { taskStore });

    const result = await generator.createTask({
      method: 'tools/call',
      params: {
        name: 'taskenabledprotocolprobe_slowaction',
        arguments: { id: 'probe-1', options: { prompt: 'hello' } },
      },
    });

    expect(received).toMatchObject({
      objectId: 'probe-1',
      method: 'slowAction',
      invocationArgs: [{ prompt: 'hello' }],
    });
    expect(result).toMatchObject({
      resultType: 'task',
      taskId: 'task-1',
      status: 'working',
    });
  });
});
