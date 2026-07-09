/**
 * Agent orchestration through the conversational tool loop (#1892).
 *
 * The headline integration: a conversational agent (a mocked AI driving
 * {@link runToolLoop}) invokes a worker via the standard `invoke-agent` tool,
 * offered as a `PrincipalTool` alongside manifest tools. Real in-memory SQLite
 * with real RBAC; only the AI boundary is mocked. Proves:
 *   - the worker runs under the ORIGINATING user's permissions, not its own;
 *   - the worker's completion is surfaced back into the conversation transcript;
 *   - the tool is gated by the persona's `allowedTools` (execution + offer gates).
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AIInterface,
  AIMessage,
  AIResponse,
  ChatOptions,
} from '@happyvertical/ai';
import {
  createInvokeAgentTool,
  type PrincipalTool,
  rootDelegationEnvelope,
  type WorkerRunner,
} from '@happyvertical/smrt-agents';
import {
  MembershipCollection,
  PermissionCollection,
  RoleCollection,
  RolePermissionCollection,
  registerPermissionDefinitions,
  TenantCollection,
  UserCollection,
} from '@happyvertical/smrt-users';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ConversationPersona,
  runPersonaConversationTurn,
} from './persona-conversation.js';
import { runToolLoop } from './tool-loop.js';

function toolCall(name: string, args: Record<string, unknown>): AIResponse {
  return {
    content: '',
    finishReason: 'tool_calls',
    toolCalls: [
      {
        id: `tc_${Math.random().toString(36).slice(2)}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

function textResponse(content: string): AIResponse {
  return { content, finishReason: 'stop' };
}

function makeAI(
  handler: (
    messages: AIMessage[],
    options: ChatOptions | undefined,
    call: number,
  ) => AIResponse,
): AIInterface {
  let calls = 0;
  return {
    async chat(messages: AIMessage[], options?: ChatOptions) {
      const response = handler(messages, options, calls);
      calls += 1;
      return response;
    },
  } as unknown as AIInterface;
}

function toolsOffered(options: ChatOptions | undefined): boolean {
  return (
    Array.isArray(options?.tools) &&
    options.tools.length > 0 &&
    options?.toolChoice !== 'none'
  );
}

describe('agent orchestration via the invoke-agent tool', () => {
  let dbPath: string;
  let db: { type: 'sqlite'; url: string };
  let unregister: (() => void) | undefined;
  let userId: string;
  let tenantId: string;
  let roleId: string;
  let permissions: PermissionCollection;
  let rolePermissions: RolePermissionCollection;

  const ORIGINATOR = 'originator-42';

  beforeEach(async () => {
    dbPath = join(
      tmpdir(),
      `smrt-orchestration-${Date.now()}-${Math.random()}.db`,
    );
    db = { type: 'sqlite', url: dbPath };
    const options = { db };

    unregister = registerPermissionDefinitions([
      { slug: 'widgets.read' },
      { slug: 'widgets.create' },
    ]);

    const users = await UserCollection.create(options);
    const tenants = await TenantCollection.create(options);
    const roles = await RoleCollection.create(options);
    permissions = await PermissionCollection.create(options);
    rolePermissions = await RolePermissionCollection.create(options);
    const memberships = await MembershipCollection.create(options);

    const user = await users.create({ email: 'orchestrator@example.com' });
    await user.save();
    const tenant = await tenants.create({ name: 'Orchestration Org' });
    await tenant.save();
    const role = await roles.create({ name: 'Widget Reader' });
    await role.save();
    await (
      await memberships.create({
        userId: user.id,
        tenantId: tenant.id,
        roleId: role.id,
      })
    ).save();

    userId = user.id as string;
    tenantId = tenant.id as string;
    roleId = role.id as string;

    await grant('widgets.read'); // read yes, create no
  });

  afterEach(() => {
    vi.restoreAllMocks();
    unregister?.();
    unregister = undefined;
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // best-effort
      }
    }
  });

  async function grant(slug: string): Promise<void> {
    const permission = await permissions.create({ slug, name: slug });
    await permission.save();
    await rolePermissions.addPermission(roleId, permission.id as string);
  }

  /** A worker that probes the originating user's authority under its principal. */
  const probeWorker: WorkerRunner = async ({ run }) => {
    const readOk = (await run.assertOperation('widgets', 'read')).allowed;
    let createDenied = false;
    try {
      await run.assertOperation('widgets', 'create');
    } catch {
      createDenied = true;
    }
    return { actorUserId: run.context.userId, readOk, createDenied };
  };

  function invokeAgentTool(worker: WorkerRunner): PrincipalTool {
    return createInvokeAgentTool({
      db,
      parentEnvelope: rootDelegationEnvelope({
        runAsUserId: userId,
        tenantId,
        onBehalfOfUserId: ORIGINATOR,
        allowedTools: ['agents.invoke'],
      }),
      worker,
    });
  }

  it('invokes a worker that runs under the originating user, and surfaces its completion', async () => {
    let ranAsUserId: string | undefined;
    const worker: WorkerRunner = async (invocation) => {
      const result = await probeWorker(invocation);
      ranAsUserId = (result as { actorUserId?: string }).actorUserId;
      return result;
    };

    // The model delegates to a worker, then answers using the completion.
    const ai = makeAI((_m, options, call) =>
      call === 0 && toolsOffered(options)
        ? toolCall('agents-invoke', {
            agentClass: '@happyvertical/smrt-agents:Worker',
            task: { summarize: 'the report' },
          })
        : textResponse('The worker finished the task.'),
    );

    const result = await runToolLoop({
      ai,
      db,
      messages: [{ role: 'user', content: 'have a worker do it' }],
      tools: [],
      extraTools: [invokeAgentTool(worker)],
      principal: {
        runAsUserId: userId,
        tenantId,
        allowedTools: ['agents.invoke'],
      },
      onBehalfOfUserId: ORIGINATOR,
      audit: () => {},
    });

    // The worker ran under the originating user's principal.
    expect(ranAsUserId).toBe(userId);

    // One invocation of the invoke-agent tool, executed (not rejected).
    expect(result.invocations).toHaveLength(1);
    const invocation = result.invocations[0];
    expect(invocation).toMatchObject({
      slug: 'agents.invoke',
      ok: true,
      rejected: false,
    });

    // Its completion — the worker's result under the originating principal — is
    // the observation surfaced back into the conversation.
    const observation = invocation.observation as {
      status?: string;
      result?: {
        actorUserId?: string;
        readOk?: boolean;
        createDenied?: boolean;
      };
    };
    expect(observation.status).toBe('completed');
    expect(observation.result).toMatchObject({
      actorUserId: userId,
      readOk: true,
      createDenied: true,
    });

    // And it appears in the transcript as a tool observation the model saw.
    const toolMessage = result.messages.find((m) => m.role === 'tool');
    expect(toolMessage?.content).toContain('"status":"completed"');
    expect(result.content).toBe('The worker finished the task.');
  });

  it('rejects the invoke-agent tool when the persona does not allow-list it (execution gate)', async () => {
    const worker = vi.fn<WorkerRunner>(async () => ({ ran: true }));
    const ai = makeAI((_m, options, call) =>
      call === 0 && toolsOffered(options)
        ? toolCall('agents-invoke', {
            agentClass: '@happyvertical/smrt-agents:Worker',
            task: {},
          })
        : textResponse('cannot delegate'),
    );

    const result = await runToolLoop({
      ai,
      db,
      messages: [{ role: 'user', content: 'delegate please' }],
      tools: [],
      extraTools: [invokeAgentTool(worker)],
      // The principal does NOT allow-list agents.invoke.
      principal: { runAsUserId: userId, tenantId, allowedTools: [] },
      onBehalfOfUserId: ORIGINATOR,
      audit: () => {},
    });

    // The worker never ran, and the call was rejected fail-closed.
    expect(worker).not.toHaveBeenCalled();
    expect(result.invocations).toHaveLength(1);
    expect(result.invocations[0]).toMatchObject({
      slug: 'agents.invoke',
      ok: false,
      rejected: true,
      error: 'not_permitted',
    });
  });

  it('does not offer the invoke-agent tool through a persona turn that omits it (offer gate)', async () => {
    const worker = vi.fn<WorkerRunner>(async () => ({ ran: true }));
    const ai = makeAI((_m, options) =>
      // The model would call it if offered — but it must not be offered.
      toolsOffered(options)
        ? toolCall('agents-invoke', { agentClass: 'Worker', task: {} })
        : textResponse('no tools available'),
    );

    const persona: ConversationPersona = {
      id: null,
      tenantId,
      agentClass: '@happyvertical/smrt-agents:Orchestrator',
      runAsUserId: userId,
      allowedTools: [], // does NOT allow-list agents.invoke
      instructions: 'You are a helpful assistant.',
    };

    const { result } = await runPersonaConversationTurn({
      ai,
      db,
      persona,
      tenantId,
      userMessage: 'delegate to a worker',
      // The tool is passed, but the persona does not allow-list it, so the
      // offer-gate filter must drop it before the loop.
      extraTools: [invokeAgentTool(worker)],
      onBehalfOfUserId: ORIGINATOR,
      recall: false,
      audit: () => {},
    });

    expect(worker).not.toHaveBeenCalled();
    expect(result.invocations).toHaveLength(0);
    expect(result.stoppedReason).toBe('no_tools');
  });
});
