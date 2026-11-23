// The assistant as tracked AI work (#5005): its system prompt is a registered
// prompt, its model calls go through core's tracked client on the shell
// database, and each turn is a `turn` run with usage rows and events.

import { createTrackedAiClient } from '@happyvertical/smrt-core';
import {
  PromptRegistry,
  resolvePrompt,
  trackedPromptCall,
} from '@happyvertical/smrt-prompts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostOwner } from '../../../test/engine-principal.ts';
import type { TurnEvent } from '../../assistant/events.ts';
import { ApprovalCollection } from '../../objects/Approval.ts';
import { getHost, getShellDb } from '../host.ts';
import { callTool } from '../policy.ts';
import {
  applyWaiting,
  openShell,
  runAs,
  type ShellHarness,
} from '../test-support.ts';
import {
  ASSISTANT_PROMPT_KEY,
  packagedGuidance,
  resolveAssistantPrompt,
} from './guidance.ts';
import {
  type AssistantModel,
  createAiModelFactory,
  isTrackedAssistantModel,
  type TrackedAssistantModel,
} from './model.ts';
import { call, drive, say } from './test-helpers.ts';
import { createThread } from './threads.ts';
import { runTurn } from './turn.ts';

let h: ShellHarness;
beforeAll(async () => {
  h = await openShell();
});
afterAll(async () => {
  await h.close();
});

const rowsOf = (result: unknown): Array<Record<string, unknown>> =>
  Array.isArray(result)
    ? result
    : (((result as { rows?: unknown[] })?.rows ?? []) as Array<
        Record<string, unknown>
      >);
const query = async (sql: string, ...params: unknown[]) =>
  rowsOf(await (await getShellDb()).query(sql, ...params));

/**
 * What the production factory builds, over a scripted provider client: the
 * same bind and complete over core's tracked client.
 */
async function trackedModel(
  replies: Array<{ text: string; tool?: ReturnType<typeof call> }>,
): Promise<TrackedAssistantModel> {
  let n = 0;
  const provider = {
    embed: () => {},
    async chat() {
      const reply = replies[Math.min(n, replies.length - 1)];
      n += 1;
      return {
        content: reply.text,
        model: 'm-1',
        finishReason: reply.tool ? 'tool_calls' : 'stop',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        ...(reply.tool
          ? {
              toolCalls: [
                {
                  id: reply.tool.id,
                  type: 'function',
                  function: {
                    name: reply.tool.name,
                    arguments: reply.tool.arguments,
                  },
                },
              ],
            }
          : {}),
      };
    },
  };
  const tracked = createTrackedAiClient({
    db: await getShellDb(),
    tenantId: h.owner.tenantId,
    className: 'AppShellAssistant',
    ai: provider as never,
    transcript: false,
  });
  const { engineModelReply } = await import(
    '@happyvertical/smrt-inference/server'
  );
  const bind = (
    prompt: Awaited<ReturnType<typeof resolveAssistantPrompt>>,
    run?: never,
  ) =>
    ({
      async complete(request) {
        const ai = (await tracked.client(trackedPromptCall(prompt), {
          ...(run ? { runContext: run } : {}),
        })) as unknown as {
          chat(m: unknown, o: unknown): Promise<unknown>;
        };
        return engineModelReply(
          (await ai.chat(request.messages, { tools: request.tools })) as never,
        );
      },
    }) satisfies AssistantModel;
  return {
    tracked,
    complete: async (request) =>
      bind(await resolveAssistantPrompt({})).complete(request),
    bind: (prompt, run) => bind(prompt, run as never),
  };
}

describe('the assistant prompt (#5005)', () => {
  it('is registered under the package namespace and resolves to the packaged guidance', async () => {
    expect(PromptRegistry.get(ASSISTANT_PROMPT_KEY)).toBeDefined();
    expect(ASSISTANT_PROMPT_KEY.startsWith('app-shell.')).toBe(true);
    const resolved = await resolvePrompt(ASSISTANT_PROMPT_KEY, {
      db: await getShellDb(),
      tenantId: h.owner.tenantId,
    });
    expect(resolved.text).toBe(packagedGuidance().trim());
    expect(resolved.ai.usageTags.promptKey).toBe(ASSISTANT_PROMPT_KEY);
    expect(resolved.ai.usageTags.promptLayer).toBe('default');
  });

  it('declares the tier the assistant asks for', async () => {
    const resolved = await resolvePrompt(ASSISTANT_PROMPT_KEY, {});
    expect(resolved.ai.tier).toBe('good');
  });

  it('takes a layer above the default', async () => {
    const resolved = await resolvePrompt(ASSISTANT_PROMPT_KEY, {
      override: { template: 'Be terse.' },
    });
    expect(resolved.text).toBe('Be terse.');
    expect(resolved.ai.usageTags.promptLayer).toBe('runtime');
  });
});

describe('the production factory (#5005)', () => {
  it('builds a tracked model for the API engine, with no call made', async () => {
    const model = await createAiModelFactory({
      env: { ANTHROPIC_API_KEY: 'sk-test-key' },
    })({ principal: h.owner });
    expect(isTrackedAssistantModel(model)).toBe(true);
  });
});

describe('an assistant turn as an AI run (#5005)', () => {
  it('opens one turn run: a usage row and call event per model call, action and observation events, messages by reference', async () => {
    const model = await trackedModel([
      { text: '', tool: call('app_describe', {}) },
      { text: 'All described.' },
    ]);
    const { stop, threadId } = await drive({
      principal: h.owner,
      model,
      text: 'secret-user-words',
    });
    expect(stop).toBe('complete');
    const runs = await query(
      `SELECT id, type, status, definition_key, prompt_key, tenant_id, calls, tokens
         FROM _smrt_ai_runs WHERE definition_key = 'app-shell.assistant.turn'
        ORDER BY started_at DESC`,
    );
    const run = runs[0];
    expect(run).toMatchObject({
      type: 'turn',
      status: 'done',
      prompt_key: ASSISTANT_PROMPT_KEY,
      tenant_id: h.owner.tenantId,
      calls: 2,
      tokens: 30,
    });
    const usage = await query(
      'SELECT run_id, prompt_key FROM _smrt_ai_usage WHERE run_id = $1',
      run?.id,
    );
    expect(usage).toHaveLength(2);
    expect(usage.every((u) => u.prompt_key === ASSISTANT_PROMPT_KEY)).toBe(
      true,
    );
    const trail = await query(
      `SELECT type, name, payload, payload_ref, parent_event_id, id
         FROM _smrt_ai_run_events WHERE run_id = $1 ORDER BY seq`,
      run?.id,
    );
    const types = trail.map((event) => event.type);
    expect(types.filter((type) => type === 'call')).toHaveLength(2);
    const action = trail.find((event) => event.type === 'action');
    expect(action?.name).toBe('app_describe');
    expect(
      trail.find(
        (event) =>
          event.type === 'observation' && event.parent_event_id === action?.id,
      ),
    ).toBeDefined();
    expect(
      trail.some((event) =>
        String(event.payload_ref ?? '').startsWith('assistant-message:'),
      ),
    ).toBe(true);
    expect(JSON.stringify(trail)).not.toContain('secret-user-words');
    expect(threadId).toBeTruthy();
  });

  it('records a risky call: a requested approval event and, once held and decided, its decision, in the same run', async () => {
    const host = await getHost();
    await runAs(h.owner, () =>
      callTool(h.owner, 'app_definemodel', {
        name: 'Chore',
        fields: { title: { type: 'text' } },
      }),
    );
    await applyWaiting(h.owner);
    await callTool(h.owner, 'chore_create', { title: 'tracked-mop' });
    const chore = (await host.list(hostOwner(host), 'Chore')).find(
      (row) => (row as { title?: string }).title === 'tracked-mop',
    );
    const model = await trackedModel([
      { text: '', tool: call('chore_delete', { id: chore?.id }) },
      { text: 'Done.' },
    ]);
    const events: TurnEvent[] = [];
    const running = drive({
      principal: h.owner,
      model,
      onEvent: (e) => events.push(e),
    });
    const ask = await new Promise<
      Extract<TurnEvent, { type: 'approval_required' }>
    >((resolve, reject) => {
      const end = Date.now() + 5000;
      const poll = () => {
        const found = events.find((e) => e.type === 'approval_required');
        if (found) return resolve(found as never);
        if (Date.now() > end) return reject(new Error('no approval'));
        setTimeout(poll, 10);
      };
      poll();
    });
    const row = await (
      await ApprovalCollection.create({ db: await getShellDb() })
    ).get(ask.approvalId);
    await runAs(h.owner, () => row!.decide(true));
    await running;
    const runs = await query(
      `SELECT id FROM _smrt_ai_runs ORDER BY started_at DESC LIMIT 1`,
    );
    const approvals = await query(
      `SELECT status, parent_event_id, id FROM _smrt_ai_run_events
        WHERE run_id = $1 AND type = 'approval' ORDER BY seq`,
      runs[0]?.id,
    );
    expect(approvals.map((event) => event.status)).toEqual([
      'requested',
      'approved',
    ]);
    expect(approvals[1]?.parent_event_id).toBe(approvals[0]?.id);
  });

  it('records a decision made after the hold timed out in the next turn of the thread, once', async () => {
    const host = await getHost();
    await runAs(h.owner, () =>
      callTool(h.owner, 'app_definemodel', {
        name: 'Chore',
        fields: { title: { type: 'text' } },
      }),
    );
    await applyWaiting(h.owner);
    await callTool(h.owner, 'chore_create', { title: 'late-mop' });
    const chore = (await host.list(hostOwner(host), 'Chore')).find(
      (row) => (row as { title?: string }).title === 'late-mop',
    );
    const thread = await createThread(h.owner.id, 'late decision');
    const turn = (model: AssistantModel) =>
      runTurn({
        principal: h.owner,
        thread,
        text: 'go on',
        model,
        signal: new AbortController().signal,
        emit: () => {},
        // Nobody answers in time: the turn ends waiting.
        hold: async () => ({ status: 'timeout' }),
      });
    const runIds = async () =>
      (
        await query(
          `SELECT id FROM _smrt_ai_runs
            WHERE definition_key = 'app-shell.assistant.turn'
            ORDER BY started_at`,
        )
      ).map((row) => String(row.id));
    const before = await runIds();
    expect(
      await turn(
        await trackedModel([
          { text: '', tool: call('chore_delete', { id: chore?.id }) },
        ]),
      ),
    ).toBe('waiting');
    const [first] = (await runIds()).filter((id) => !before.includes(id));
    const [request] = await query(
      `SELECT id, payload_ref FROM _smrt_ai_run_events
        WHERE run_id = $1 AND type = 'approval' AND status = 'requested'`,
      first,
    );
    expect(request).toBeDefined();
    const approvalId = String(request?.payload_ref).replace(/^approval:/, '');

    // The owner approves later; the change is applied outside any turn.
    const row = await (
      await ApprovalCollection.create({ db: await getShellDb() })
    ).get(approvalId);
    await runAs(h.owner, () => row!.decide(true));

    const reply = async () => {
      const seen = await runIds();
      expect(await turn(await trackedModel([{ text: 'Noted.' }]))).toBe(
        'complete',
      );
      const [id] = (await runIds()).filter((run) => !seen.includes(run));
      return query(
        `SELECT status, parent_event_id, payload_ref FROM _smrt_ai_run_events
          WHERE run_id = $1 AND type = 'approval'`,
        id,
      );
    };
    expect(await reply()).toEqual([
      {
        status: 'approved',
        parent_event_id: request?.id,
        payload_ref: request?.payload_ref,
      },
    ]);
    // Recorded once: a later turn adds nothing.
    expect(await reply()).toEqual([]);
  });
});
