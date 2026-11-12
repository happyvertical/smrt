import { getTestDatabase } from '@happyvertical/smrt-core';
import { createCookbookToolService } from '@happyvertical/smrt-core/cookbook/tools';
import {
  type ResolvedWorkProfile,
  recommendedWorkProfile,
} from '@happyvertical/smrt-inference/server';
import { SmrtJobCollection, TaskRunner } from '@happyvertical/smrt-jobs';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type CookbookDesignRunsOptions,
  createCookbookDesignRuns,
} from '../host/design-runs.js';

const profile = (): ResolvedWorkProfile => ({
  ...recommendedWorkProfile('design'),
  name: 'design',
  engine: 'api',
  tier: 'best',
  budgets: {
    ...recommendedWorkProfile('design').budgets,
    passes: 3,
    maxRunTokens: 100,
    maxTurnTokens: 10,
    runTimeoutMs: 10_000,
    turnTimeoutMs: 1000,
  },
});
const metadata = {
  profile: 'design' as const,
  engine: 'api' as const,
  effort: 'max' as const,
  tokens: 2,
  toolCalls: 0,
  durationMs: 1,
};
const output = {
  summary: 'Keep the existing data and propose a field.',
  personSummary: 'I’m checking the requested changes.',
  checks: ['The request has a target list.'],
  ready: true,
  operations: [],
};

describe('cookbook durable design jobs', () => {
  let db: DatabaseInterface;
  let host: ReturnType<typeof createCookbookDesignRuns>;
  let runner: TaskRunner | undefined;
  beforeEach(async () => {
    db = await getTestDatabase({
      classes: [
        'DesignRunRecord',
        'SmrtJob',
        'SmrtJobEvent',
        'SmrtWorker',
        'SmrtJobDedupeSlot',
      ],
    });
  });
  afterEach(async () => {
    await runner?.stop();
    runner = undefined;
    host?.dispose();
    await db.close?.();
  });
  function install(
    executePass: CookbookDesignRunsOptions['executePass'],
    listOperations?: CookbookDesignRunsOptions['listOperations'],
    extra: Partial<CookbookDesignRunsOptions> = {},
  ) {
    host = createCookbookDesignRuns({
      db,
      authorize: async () => {},
      executePass,
      listOperations,
      ...extra,
    });
    return host.forOwner('owner', null);
  }
  async function startWorker() {
    runner = new TaskRunner({
      concurrency: 1,
      pollInterval: 10,
      retention: false,
    });
    await runner.initialize(db);
    await runner.start();
  }
  async function terminal(id: string) {
    const bound = host.forOwner('owner', null);
    for (let index = 0; index < 300; index++) {
      const state = await bound.status(id);
      if (
        ['done', 'failed', 'stopped', 'waiting-approval'].includes(state.status)
      )
        return state;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Design job did not finish');
  }
  it('persists before execution and resumes three checked passes after a host restart', async () => {
    const execute = vi.fn<CookbookDesignRunsOptions['executePass']>(
      async () => ({ output, metadata }),
    );
    const bound = install(execute);
    const created = await bound.start({
      threadId: 'thread',
      content: 'Add a field',
      profile: profile(),
    });
    expect(execute).not.toHaveBeenCalled();
    const jobs = await db.query(
      'SELECT object_id AS target, method FROM _smrt_jobs',
    );
    expect(jobs.rows).toMatchObject([
      { target: created.id, method: 'execute' },
    ]);
    await bound.stop(created.id);
    host.dispose();
    const restarted = install(execute);
    await expect(
      host.forOwner('other', null).status(created.id),
    ).rejects.toThrow('not found');
    await restarted.resume(created.id);
    await startWorker();
    const done = await terminal(created.id);
    expect(done.status).toBe('done');
    expect(done.outputs).toHaveLength(3);
    expect(done.tokens).toBe(6);
    expect(execute.mock.calls.map(([input]) => input.stage)).toEqual([
      'propose',
      'revise',
      'revise',
    ]);
    expect(execute.mock.calls[1][0].request.input).toMatchObject({
      previousCheck: { pass: 1, checked: true },
    });
  });
  it('stops a running pass cooperatively and resumes without resetting usage', async () => {
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const execute = vi
      .fn<CookbookDesignRunsOptions['executePass']>()
      .mockImplementationOnce(async ({ request }) => {
        began();
        await new Promise<void>((_resolve, reject) => {
          request.signal.addEventListener(
            'abort',
            () => reject(request.signal.reason),
            { once: true },
          );
        });
        return { output, metadata };
      })
      .mockResolvedValue({ output, metadata });
    const bound = install(execute);
    const selected = profile();
    selected.budgets.turnTimeoutMs = 1_800_000;
    selected.budgets.runTimeoutMs = 3_600_000;
    const permissionCeiling = ['app.describe'];
    const created = await bound.start({
      threadId: 'thread',
      content: 'Inspect the app',
      profile: selected,
      permissions: permissionCeiling,
    });
    permissionCeiling.push('app.removeList');
    await startWorker();
    await started;
    const stopped = await bound.stop(created.id);
    expect(stopped.status).toBe('stopped');
    expect(execute.mock.calls[0][0].permissions).toEqual(['app.describe']);
    expect(stopped.tokens).toBe(10);
    expect(stopped.leaseUntil).toBeGreaterThan(Date.now() + 1_700_000);
    await vi.waitFor(async () => {
      expect((await bound.status(created.id)).leaseUntil).toBeUndefined();
      const active = await db.query(
        "SELECT id FROM _smrt_jobs WHERE object_id = ? AND status = 'running'",
        created.id,
      );
      expect(active.rows).toHaveLength(0);
    });
    await bound.resume(created.id);
    const done = await terminal(created.id);
    expect(done.status).toBe('done');
    expect(done.tokens).toBe(16);
    expect(execute).toHaveBeenCalledTimes(4);
  });
  it('keeps an uncooperative pass reserved until its actual promise settles', async () => {
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    let finish!: () => void;
    const external = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const execute = vi
      .fn<CookbookDesignRunsOptions['executePass']>()
      .mockImplementationOnce(async () => {
        began();
        await external;
        return { output, metadata };
      })
      .mockResolvedValue({ output, metadata });
    const bound = install(execute);
    const selected = profile();
    selected.budgets.turnTimeoutMs = 1_800_000;
    selected.budgets.runTimeoutMs = 3_600_000;
    const created = await bound.start({
      threadId: 'thread',
      content: 'Inspect the app',
      profile: selected,
    });
    await startWorker();
    await started;
    const stopped = await bound.stop(created.id);
    await vi.waitFor(async () => {
      const job = await db.query(
        'SELECT status FROM _smrt_jobs WHERE object_id = ?',
        created.id,
      );
      expect(job.rows[0].status).toBe('failed');
    });
    expect((await bound.status(created.id)).leaseUntil).toBe(
      stopped.leaseUntil,
    );
    await expect(bound.resume(created.id)).rejects.toThrow();
    finish();
    await vi.waitFor(async () =>
      expect((await bound.status(created.id)).leaseUntil).toBeUndefined(),
    );
    await bound.resume(created.id);
    expect((await terminal(created.id)).status).toBe('done');
    expect(execute).toHaveBeenCalledTimes(4);
  });
  it('refuses a late lease release when the captured job claim has changed', async () => {
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    let finish!: () => void;
    const external = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const bound = install(async () => {
      began();
      await external;
      return { output, metadata };
    });
    const selected = profile();
    selected.budgets.turnTimeoutMs = 1_800_000;
    selected.budgets.runTimeoutMs = 3_600_000;
    const created = await bound.start({
      threadId: 'thread',
      content: 'Inspect the app',
      profile: selected,
    });
    await startWorker();
    await started;
    const stopped = await bound.stop(created.id);
    await vi.waitFor(async () => {
      const job = await db.query(
        'SELECT status FROM _smrt_jobs WHERE object_id = ?',
        created.id,
      );
      expect(job.rows[0].status).toBe('failed');
    });
    // Same job and worker can claim a later attempt; old settlement has no authority.
    await db.query(
      'UPDATE _smrt_jobs SET attempts = attempts + 1 WHERE object_id = ?',
      created.id,
    );
    const transactions = vi.spyOn(db, 'transaction');
    const before = transactions.mock.calls.length;
    finish();
    await vi.waitFor(() =>
      expect(transactions.mock.calls.length).toBeGreaterThan(before),
    );
    await transactions.mock.results.at(-1)?.value;
    expect((await bound.status(created.id)).leaseUntil).toBe(
      stopped.leaseUntil,
    );
    expect((await bound.status(created.id)).leaseRevision).toBe(
      stopped.leaseRevision,
    );
    await expect(bound.resume(created.id)).rejects.toThrow();
    transactions.mockRestore();
  });
  it('uses full schema validation and bounded repair on the same pass', async () => {
    const execute = vi
      .fn<CookbookDesignRunsOptions['executePass']>()
      .mockResolvedValueOnce({ output: { ...output, summary: 42 }, metadata })
      .mockResolvedValue({ output, metadata });
    const bound = install(execute);
    const created = await bound.start({
      threadId: 'thread',
      content: 'Review the list',
      profile: profile(),
    });
    await startWorker();
    const done = await terminal(created.id);
    expect(done.status).toBe('done');
    expect(execute).toHaveBeenCalledTimes(4);
    expect(execute.mock.calls[1][0].request.repair?.errors.join(' ')).toContain(
      'string',
    );
    expect(done.tokens).toBe(8);
  });
  it('requires the separate v5 person field and repairs it on the same read-only pass', async () => {
    const { personSummary: _missing, ...missingPersonField } = output;
    const execute = vi
      .fn<CookbookDesignRunsOptions['executePass']>()
      .mockResolvedValueOnce({ output: missingPersonField, metadata })
      .mockResolvedValue({ output, metadata });
    const effect = vi.fn();
    const bound = install(execute, undefined, { executeOperation: effect });
    const created = await bound.start({
      threadId: 'thread',
      content: 'Review the list',
      profile: profile(),
    });
    await startWorker();
    const done = await terminal(created.id);
    expect(done.status).toBe('done');
    expect(done.definition).toBe('cookbook-design/v5/3');
    expect(execute).toHaveBeenCalledTimes(4);
    expect(execute.mock.calls[1][0].request.repair?.errors.join(' ')).toContain(
      'personSummary',
    );
    expect(done.outputs).toEqual([output, output, output]);
    expect(effect).not.toHaveBeenCalled();
  });
  it('advertises the exact core add-field schema and keeps valid proposals pending without effects', async () => {
    const effect = vi.fn();
    // Only list() runs: the actual owning input schema is the contract under test.
    const service = createCookbookToolService({
      catalog: { recipes: [], models: [] },
      engineFor: () => ({}) as never,
      modelEditorFor: () => ({}) as never,
      isOwner: async () => true,
      can: async () => true,
      approvals: {} as never,
      isAppEmpty: async () => true,
      commit: effect,
      audit: async () => {},
    });
    const definitions = (
      await service.list({
        surface: 'mcp',
        userId: 'owner',
        tenantId: 'tenant',
      })
    ).filter((tool) => tool.name === 'app.addField');
    const privateReasoning =
      '@happyvertical/smrt-commerce:Customer app.addField expectedRevision 2 cookbook';
    const onProgress = vi.fn();
    const proposed = {
      ...output,
      summary: privateReasoning,
      personSummary: privateReasoning,
      operations: [
        {
          tool: 'app.addField',
          args: {
            list: 'Customers',
            label: 'Birthday',
            kind: 'date',
            expectedRevision: 1,
          },
        },
      ],
    };
    const execute = vi.fn<CookbookDesignRunsOptions['executePass']>(
      async () => ({ output: proposed, metadata }),
    );
    const apply = vi
      .fn<NonNullable<CookbookDesignRunsOptions['executeOperation']>>()
      .mockResolvedValue({
        status: 'approval_required',
        summary: 'Review Birthday.',
        approvalId: 'approval',
      });
    const bound = install(execute, async () => definitions, {
      executeOperation: apply,
      onProgress,
    });
    const selected = profile();
    selected.previewBeforeApply = true;
    const created = await bound.start({
      threadId: 'thread',
      content: 'Add a birthday field',
      profile: selected,
      fixedPasses: true,
      permissions: ['app.addField'],
    });
    await startWorker();
    const pending = await terminal(created.id);
    expect(pending.status).toBe('waiting-approval');
    expect(pending.note).toContain('Review Birthday');
    expect(pending.outputs[2]).toEqual(proposed);
    expect(onProgress.mock.calls.at(-1)?.[0].note).toBe(
      'Your changes are ready for your review.',
    );
    expect(JSON.stringify(onProgress.mock.calls)).not.toContain(
      privateReasoning,
    );
    expect(execute).toHaveBeenCalledTimes(3);
    expect(pending.definition).toBe('cookbook-design/v5/3');
    expect(execute.mock.calls[0][0].request.schema).toMatchObject({
      required: expect.arrayContaining(['summary', 'personSummary']),
      properties: {
        operations: {
          items: {
            oneOf: [
              {
                properties: {
                  tool: { const: 'app.addField' },
                  args: {
                    required: ['list', 'label', 'kind', 'expectedRevision'],
                  },
                },
              },
            ],
          },
        },
      },
    });
    expect(
      JSON.stringify(execute.mock.calls[0][0].request.schema),
    ).not.toContain('approvalId');
    expect(effect).not.toHaveBeenCalled();
    apply.mockResolvedValue({
      status: 'ok',
      summary: 'Added Birthday.',
      revision: 2,
    });
    await bound.resumeAfterApproval(created.id);
    const done = await terminal(created.id);
    expect(done.status).toBe('done');
    expect(done.outputs).toEqual(pending.outputs);
    expect(done.attempts).toEqual(pending.attempts);
    expect((done.input as { results: unknown[] }).results).toEqual([
      { status: 'ok', summary: 'Added Birthday.', revision: 2 },
    ]);
    expect(apply.mock.calls.map(([input]) => input.actionId)).toEqual([
      '0',
      '0',
    ]);
    expect(execute).toHaveBeenCalledTimes(3);
  });
  it.each([
    'add',
    'add-number',
    'add-date',
    'add-date-time',
    'add-long-text',
    'add-yes-no',
    'add-choice',
    'rename-field',
    'hide',
    'rename-list',
    'same-list-chain',
    'cross-list',
    'ambiguous',
    'oversized-aliases',
    'unavailable-descriptor',
    'remove',
    'link',
    'money',
    'money-clarification',
    'fixed-four',
    'collision',
    'unready',
    'partial-collision',
    'unknown-after-effect',
  ])('classifies v5 checked work without inventing passes: %s', async (scenario) => {
    const service = createCookbookToolService({
      catalog: { recipes: [], models: [] },
      engineFor: () => ({}) as never,
      modelEditorFor: () => ({}) as never,
      isOwner: async () => true,
      can: async () => true,
      approvals: {} as never,
      isAppEmpty: async () => true,
      commit: async () => {},
      audit: async () => {},
    });
    const definitions = await service.list({
      surface: 'mcp',
      userId: 'owner',
      tenantId: 'tenant',
    });
    const field = {
      tool: 'app.addField',
      args: {
        list: 'Customers',
        label: 'Note',
        kind: 'text',
        expectedRevision: 1,
      },
    };
    const kinds: Record<string, string> = {
      'add-number': 'number',
      'add-date': 'date',
      'add-date-time': 'date-time',
      'add-long-text': 'long text',
      'add-yes-no': 'yes/no',
      'add-choice': 'choice',
    };
    const kind = kinds[scenario];
    if (kind) field.args.kind = kind;
    const baseField =
      scenario === 'add-choice'
        ? { ...field, args: { ...field.args, options: ['New', 'Returning'] } }
        : field;
    const operations =
      scenario === 'rename-field'
        ? [
            {
              tool: 'app.renameField',
              args: {
                list: 'Clients',
                field: 'Name',
                label: 'Full name',
                expectedRevision: 1,
              },
            },
          ]
        : scenario === 'hide'
          ? [
              {
                tool: 'app.hideField',
                args: {
                  list: 'a:Customer',
                  field: 'Email',
                  expectedRevision: 1,
                },
              },
            ]
          : scenario === 'rename-list'
            ? [
                {
                  tool: 'app.renameList',
                  args: {
                    list: 'Customers',
                    label: 'Members',
                    expectedRevision: 1,
                  },
                },
              ]
            : scenario === 'same-list-chain'
              ? [
                  {
                    tool: 'app.renameList',
                    args: {
                      list: 'a:Customer',
                      label: 'Members',
                      expectedRevision: 1,
                    },
                  },
                  {
                    tool: 'app.addField',
                    args: {
                      list: 'Members',
                      label: 'Note',
                      kind: 'text',
                      expectedRevision: 2,
                    },
                  },
                  {
                    tool: 'app.renameField',
                    args: {
                      list: 'Clients',
                      field: 'Note',
                      label: 'Visit note',
                      expectedRevision: 3,
                    },
                  },
                  {
                    tool: 'app.hideField',
                    args: {
                      list: 'a:Customer',
                      field: 'Email',
                      expectedRevision: 4,
                    },
                  },
                ]
              : scenario === 'cross-list'
                ? [
                    field,
                    {
                      ...field,
                      args: {
                        ...field.args,
                        list: 'Suppliers',
                        expectedRevision: 2,
                      },
                    },
                  ]
                : scenario === 'ambiguous' || scenario === 'oversized-aliases'
                  ? [
                      {
                        ...field,
                        args: {
                          ...field.args,
                          list:
                            scenario === 'oversized-aliases'
                              ? 'Clients'
                              : 'Shared',
                        },
                      },
                    ]
                  : scenario === 'remove'
                    ? [
                        {
                          tool: 'app.removeField',
                          args: {
                            list: 'Customers',
                            field: 'Email',
                            expectedRevision: 1,
                          },
                        },
                      ]
                    : scenario === 'link'
                      ? [
                          {
                            ...field,
                            args: {
                              ...field.args,
                              kind: 'link',
                              linkTo: 'Suppliers',
                            },
                          },
                        ]
                      : scenario === 'money' ||
                          scenario === 'money-clarification'
                        ? [
                            {
                              ...field,
                              args: {
                                ...field.args,
                                kind: 'money',
                                currency: 'CAD',
                              },
                            },
                          ]
                        : scenario === 'partial-collision'
                          ? [
                              field,
                              {
                                ...field,
                                args: {
                                  ...field.args,
                                  label: 'Another',
                                  expectedRevision: 2,
                                },
                              },
                            ]
                          : [baseField];
    const effect = vi.fn();
    let operationsCalled = 0;
    const apply = vi.fn<
      NonNullable<CookbookDesignRunsOptions['executeOperation']>
    >(async () => {
      operationsCalled++;
      if (
        (['collision', 'money-clarification'].includes(scenario) &&
          operationsCalled === 1) ||
        (scenario === 'partial-collision' && operationsCalled === 2)
      )
        return {
          status:
            scenario === 'money-clarification'
              ? 'clarification_required'
              : 'collision',
          summary: 'Choose another field label.',
        };
      effect();
      if (scenario === 'unknown-after-effect')
        throw new Error('Uncertain completion');
      return { status: 'ok', summary: 'Changed the app.' };
    });
    const execute = vi.fn<CookbookDesignRunsOptions['executePass']>(
      async ({ request }) => ({
        output: {
          ...output,
          ready: scenario !== 'unready' || request.pass.index > 1,
          operations:
            scenario === 'money-clarification' && request.pass.index === 1
              ? operations.map((operation) => {
                  const args: Record<string, unknown> = { ...operation.args };
                  delete args.currency;
                  return { ...operation, args };
                })
              : operations,
        },
        metadata,
      }),
    );
    const progress = vi.fn();
    const bound = install(execute, async () => definitions, {
      executeOperation: apply,
      onProgress: progress,
      describeApp: async () =>
        scenario === 'unavailable-descriptor'
          ? undefined
          : {
              status: 'ok',
              summary: 'Your app lists.',
              revision: 1,
              lists: [
                {
                  id: 'a:Customer',
                  label: 'Customers',
                  synonyms: ['Clients', 'Shared'],
                },
                {
                  id: 'b:Supplier',
                  label: 'Suppliers',
                  synonyms:
                    scenario === 'oversized-aliases'
                      ? [
                          ...Array.from({ length: 32 }, () => 'Other'),
                          'Clients',
                        ]
                      : ['Shared'],
                },
              ],
            },
    });
    const selected = profile();
    if (scenario === 'fixed-four') selected.budgets.passes = 4;
    const created = await bound.start({
      threadId: 'thread',
      content: 'Change my lists',
      profile: selected,
      permissions: definitions.map((tool) => tool.name),
      fixedPasses: scenario === 'fixed-four',
    });
    await startWorker();
    const done = await terminal(created.id);
    const small =
      [
        'add',
        'rename-field',
        'hide',
        'rename-list',
        'same-list-chain',
        'money',
      ].includes(scenario) || scenario.startsWith('add-');
    const failed = ['partial-collision', 'unknown-after-effect'].includes(
      scenario,
    );
    const count = small || failed ? 1 : scenario === 'fixed-four' ? 4 : 3;
    expect(done.status).toBe(failed ? 'failed' : 'done');
    expect(execute).toHaveBeenCalledTimes(count);
    expect(done.outputs).toHaveLength(count);
    expect(done.attempts).toHaveLength(count);
    expect(done.tokens).toBe(count * 2);
    expect(execute.mock.calls[0][0].stage).toBe('propose');
    if (small) {
      expect(done).toMatchObject({ phase: 'check', passIndex: 0 });
      expect(progress.mock.calls.at(-1)?.[0].pass.count).toBe(1);
      await bound.stop(created.id);
      await expect(bound.resume(created.id)).rejects.toThrow('ended');
      expect((await bound.status(created.id)).status).toBe('done');
      expect(execute).toHaveBeenCalledTimes(1);
    } else if (!failed)
      expect(progress.mock.calls.at(-1)?.[0].pass.count).toBe(count);
    expect(effect).toHaveBeenCalledTimes(failed ? 1 : operations.length);
    if (scenario === 'collision') expect(apply).toHaveBeenCalledTimes(2);
  });

  it('replays pinned v4 schemas and its original first profile pass unchanged', async () => {
    const execute = vi.fn<CookbookDesignRunsOptions['executePass']>(
      async () => ({ output, metadata }),
    );
    const bound = install(execute);
    const created = await bound.start({
      threadId: 'thread',
      content: 'Review my app',
      profile: profile(),
      fixedPasses: true,
    });
    const state = await bound.status(created.id);
    const legacyInput = { ...(state.input as Record<string, unknown>) };
    delete legacyInput.fixedPasses;
    const legacy = {
      ...state,
      definition: 'cookbook-design/v4/3',
      input: legacyInput,
    };
    await db.query(
      'UPDATE _smrt_inference_design_runs SET payload = ? WHERE id = ?',
      JSON.stringify(legacy),
      created.id,
    );
    await startWorker();
    expect((await terminal(created.id)).status).toBe('done');
    expect(execute.mock.calls.map(([call]) => call.stage)).toEqual([
      'profile',
      'propose',
      'revise',
    ]);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('keeps completed v1 proposal contracts unchanged rather than reinterpreting unsupported operations', async () => {
    const execute = vi.fn<CookbookDesignRunsOptions['executePass']>();
    const bound = install(execute);
    const created = await bound.start({
      threadId: 'thread',
      content: 'Add Birthday',
      profile: profile(),
    });
    const legacy = {
      ...created,
      definition: 'cookbook-design/v1/3',
      status: 'waiting-approval',
      passIndex: 3,
      outputs: Array.from({ length: 3 }, () => ({
        ...output,
        ready: false,
        operations: [{ tool: 'mcp__smrt__app_customize', args: {} }],
      })),
    };
    await db.query(
      'UPDATE _smrt_inference_design_runs SET payload = ? WHERE id = ?',
      JSON.stringify(legacy),
      created.id,
    );
    expect(await bound.status(created.id)).toEqual(legacy);
    await expect(bound.resume(created.id)).rejects.toThrow(
      'Review the proposed design',
    );
    expect(await bound.status(created.id)).toEqual(legacy);
    expect(execute).not.toHaveBeenCalled();
  });
  it.each([
    { tool: 'mcp__smrt__app_customize', args: {} },
    {
      tool: 'app.addField',
      args: {
        list: 'Customers',
        label: 'Birthday',
        kind: 'date',
        expectedRevision: 1,
        profile: 'design',
      },
    },
    {
      tool: 'app.addField',
      args: {
        list: 'Customers',
        label: 'Birthday',
        kind: 'date',
        expectedRevision: 1,
        approvalId: 'forged',
      },
    },
  ])('repairs unsupported proposal operations without invoking effects: $tool', async (operation) => {
    const effect = vi.fn();
    const service = createCookbookToolService({
      catalog: { recipes: [], models: [] },
      engineFor: () => ({}) as never,
      modelEditorFor: () => ({}) as never,
      isOwner: async () => true,
      can: async () => true,
      approvals: {} as never,
      isAppEmpty: async () => true,
      commit: effect,
      audit: async () => {},
    });
    const definitions = (
      await service.list({
        surface: 'mcp',
        userId: 'owner',
        tenantId: 'tenant',
      })
    ).filter((tool) => tool.name === 'app.addField');
    const execute = vi
      .fn<CookbookDesignRunsOptions['executePass']>()
      .mockResolvedValueOnce({
        output: { ...output, operations: [operation] },
        metadata,
      })
      .mockResolvedValue({ output, metadata });
    const bound = install(execute, async () => definitions);
    const created = await bound.start({
      threadId: 'thread',
      content: 'Add Birthday',
      profile: profile(),
    });
    await startWorker();
    expect((await terminal(created.id)).status).toBe('done');
    expect(execute).toHaveBeenCalledTimes(4);
    expect(
      execute.mock.calls[1][0].request.repair?.errors.length,
    ).toBeGreaterThan(0);
    expect(effect).not.toHaveBeenCalled();
  });
  it.each([
    'success',
    'ready-false',
    'v1',
    'foreign-thread',
    'changed-content',
    'changed-schema',
    'old-schema-drift',
    'stale-revision',
    'missing-permission',
    'lease',
    'concurrent',
  ])('migrates only the exact compatible owner v2 proposal: %s', async (scenario) => {
    const service = createCookbookToolService({
      catalog: { recipes: [], models: [] },
      engineFor: () => ({}) as never,
      modelEditorFor: () => ({}) as never,
      isOwner: async () => true,
      can: async () => true,
      approvals: {} as never,
      isAppEmpty: async () => true,
      commit: async () => {},
      audit: async () => {},
    });
    const definition = (
      await service.list({
        surface: 'mcp',
        userId: 'owner',
        tenantId: 'tenant',
      })
    ).find((tool) => tool.name === 'app.addField')!;
    let changedSchema = scenario === 'old-schema-drift';
    let concurrent = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = vi.fn<CookbookDesignRunsOptions['executePass']>();
    const apply = vi
      .fn<NonNullable<CookbookDesignRunsOptions['executeOperation']>>()
      .mockResolvedValue({ status: 'ok', summary: 'Added field', revision: 2 });
    let legacy: import('@happyvertical/smrt-inference/server').DesignRunState;
    const bound = install(
      execute,
      async () => [
        {
          ...definition,
          inputSchema: changedSchema
            ? {
                ...definition.inputSchema,
                properties: {
                  ...(definition.inputSchema.properties as object),
                  list: { type: 'string', maxLength: 199 },
                },
              }
            : definition.inputSchema,
        },
      ],
      {
        executeOperation: apply,
        currentRevision: async () => (scenario === 'stale-revision' ? 2 : 1),
        authorizeThread: async () => {
          if (scenario === 'foreign-thread')
            throw new Error('Thread unavailable');
          if (scenario === 'changed-content')
            await db.query(
              'UPDATE _smrt_inference_design_runs SET payload = ? WHERE id = ?',
              JSON.stringify({
                ...legacy,
                input: {
                  ...(legacy.input as object),
                  content: 'Changed request',
                },
              }),
              legacy.id,
            );
          if (scenario === 'changed-schema') changedSchema = true;
          if (scenario === 'concurrent') {
            concurrent++;
            if (concurrent === 2) release();
            await gate;
          }
        },
      },
    );
    const created = await bound.start({
      threadId: 'thread',
      content: 'Add Note',
      profile: profile(),
      permissions: scenario === 'missing-permission' ? [] : ['app.addField'],
    });
    await bound.stop(created.id);
    for (const job of await (await SmrtJobCollection.create({ db })).list({
      where: { objectId: created.id },
    }))
      await job.cancel();
    const prior = await bound.status(created.id);
    const { personSummary: _presentation, ...legacyOutput } = output;
    const proposal = {
      ...legacyOutput,
      ready: scenario !== 'ready-false',
      operations: [
        {
          tool: 'app.addField',
          args: {
            list: 'Customers',
            label: 'Note',
            kind: 'text',
            expectedRevision: 1,
          },
        },
      ],
    };
    legacy = {
      ...prior,
      definition:
        scenario === 'v1' ? 'cookbook-design/v1/3' : 'cookbook-design/v2/3',
      status: 'waiting-approval',
      phase: 'model',
      passIndex: 3,
      outputs: [proposal, proposal, proposal],
      attempts: [metadata, metadata, metadata],
      tokens: 6,
      ...(scenario === 'lease'
        ? { leaseRevision: 99, leaseUntil: Date.now() + 100000 }
        : {}),
    };
    await db.query(
      'UPDATE _smrt_inference_design_runs SET payload = ? WHERE id = ?',
      JSON.stringify(legacy),
      created.id,
    );
    if (scenario === 'success' || scenario === 'concurrent') {
      if (scenario === 'concurrent') {
        const results = await Promise.allSettled([
          bound.resume(created.id),
          bound.resume(created.id),
        ]);
        expect(
          results.filter((result) => result.status === 'fulfilled'),
        ).toHaveLength(1);
      } else await bound.resume(created.id);
      const migrated = await bound.status(created.id);
      expect(migrated).toMatchObject({
        id: created.id,
        definition: 'cookbook-design/v3/3',
        phase: 'check',
        passIndex: 2,
        outputs: legacy.outputs,
        attempts: legacy.attempts,
        tokens: 6,
      });
      await startWorker();
      expect((await terminal(created.id)).status).toBe('done');
      expect(execute).not.toHaveBeenCalled();
      expect(
        (await terminal(created.id)).outputs.every(
          (result) => !Object.hasOwn(result as object, 'personSummary'),
        ),
      ).toBe(true);
      expect(apply).toHaveBeenCalledTimes(1);
    } else {
      await expect(bound.resume(created.id)).rejects.toThrow();
      expect((await bound.status(created.id)).definition).toBe(
        legacy.definition,
      );
      expect(execute).not.toHaveBeenCalled();
      expect(apply).not.toHaveBeenCalled();
    }
  });
  it('charges unknown usage and pauses the cumulative budget until an owner raises it', async () => {
    const execute = vi.fn<CookbookDesignRunsOptions['executePass']>(
      async () => ({
        output,
        metadata: { ...metadata, tokens: undefined },
      }),
    );
    const bound = install(execute);
    const settings = profile();
    settings.budgets.maxRunTokens = 10;
    const created = await bound.start({
      threadId: 'thread',
      content: 'Review the list',
      profile: settings,
    });
    await startWorker();
    const paused = await terminal(created.id);
    expect(paused.status).toBe('stopped');
    expect(paused.tokens).toBe(10);
    expect(execute).toHaveBeenCalledTimes(1);
    // Await terminal job transition so resume reserves a fresh nonterminal slot.
    const jobs = await SmrtJobCollection.create({ db });
    for (let index = 0; index < 100; index++) {
      const rows = await jobs.list({
        where: { objectId: created.id, status: 'running' },
      });
      if (!rows.length) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await bound.resume(created.id, { maxTokens: 50 });
    const done = await terminal(created.id);
    expect(done.status).toBe('done');
    expect(done.tokens).toBe(30);
  });
});
