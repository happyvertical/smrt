/**
 * The cookbook host's change workflow on smrt-workflows (#4994, #5005):
 * in-process SQLite, the real TaskRunner with claim fencing, a scripted step
 * turn. The routes, approvals, crash recovery and budget stops through the
 * full host are in cookbookHost.test.ts.
 */
import {
  getAiRun,
  getRunTrajectory,
  getTestDatabase,
} from '@happyvertical/smrt-core';
import {
  JobHandlerRegistrationClosedError,
  TaskRunner,
} from '@happyvertical/smrt-jobs';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COOKBOOK_CHANGE_STEP_PROMPT,
  type CookbookWorkflowRunsOptions,
  createCookbookWorkflowRuns,
  type WorkflowRunExecution,
} from '../host/workflow-runs.js';

const execution = (): WorkflowRunExecution => ({
  engine: 'api',
  tier: 'best',
  previewBeforeApply: true,
});
const output = {
  summary: 'Keep the existing data and propose nothing yet.',
  personSummary: 'I’m checking the requested changes.',
  checks: ['The request has a target list.'],
  ready: true,
  operations: [],
};
const addField = {
  name: 'app.addField',
  description: 'Add a field',
  inputSchema: {
    type: 'object',
    required: ['list', 'label', 'kind', 'expectedRevision'],
    properties: {
      list: { type: 'string' },
      label: { type: 'string' },
      kind: { type: 'string' },
      expectedRevision: { type: 'integer' },
      approvalId: { type: 'string' },
    },
  },
};

describe('cookbook workflow runs', () => {
  let db: DatabaseInterface;
  let host: ReturnType<typeof createCookbookWorkflowRuns> | undefined;
  let runner: TaskRunner | undefined;
  beforeEach(async () => {
    db = await getTestDatabase({
      classes: [
        'PromptOverride',
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
    host = undefined;
    await db.close?.();
  });
  function install(
    executeStep: CookbookWorkflowRunsOptions['executeStep'],
    extra: Partial<CookbookWorkflowRunsOptions> = {},
  ) {
    host = createCookbookWorkflowRuns({
      db,
      budget: { steps: 3 },
      authorize: async () => {},
      listOperations: async () => [addField],
      executeStep,
      ...extra,
    });
    return host.forOwner('owner', null);
  }
  async function startWorker() {
    runner = new TaskRunner({
      concurrency: 1,
      pollInterval: 10,
      retention: false,
      claimFencing: true,
    });
    await runner.initialize(db);
    await runner.start();
  }
  async function settled(id: string) {
    const bound = host!.forOwner('owner', null);
    for (let index = 0; index < 500; index++) {
      const state = await bound.get(id);
      if (!['running'].includes(state.status)) return state;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Workflow job did not settle');
  }

  it('admits before any step runs, then runs three checked steps on the registered prompt', async () => {
    const execute = vi.fn<CookbookWorkflowRunsOptions['executeStep']>(
      async () => output,
    );
    const bound = install(execute);
    const created = await bound.start({
      threadId: 'thread',
      content: 'Add a field',
      execution: execution(),
    });
    expect(created).toMatchObject({
      status: 'running',
      definitionKey: 'cookbook-host.change',
      definitionVersion: '1/steps-3',
    });
    expect(execute).not.toHaveBeenCalled();
    const jobs = await db.query(
      'SELECT dedupe_key AS run, method FROM _smrt_jobs',
    );
    expect(jobs.rows).toMatchObject([{ run: created.id }]);
    // Another owner never sees it.
    await expect(
      host!.forOwner('other', null).get(created.id),
    ).rejects.toThrow();
    await startWorker();
    const done = await settled(created.id);
    expect(done.status).toBe('done');
    expect(done.outputs).toHaveLength(3);
    expect(execute.mock.calls.map(([input]) => input.stage)).toEqual([
      'propose',
      'revise',
      'revise',
    ]);
    const [first] = execute.mock.calls[0];
    expect(first.prompt.key).toBe(COOKBOOK_CHANGE_STEP_PROMPT);
    expect(first.prompt.text).toContain('Add a field');
    expect(first.prompt.text).toContain('Workflow step 1/3: propose');
    expect(first.runContext).toMatchObject({
      runId: created.id,
      stepIndex: 0,
      fence: expect.any(Function),
    });
    // The pinned schema carries the live owner's operation, without approvalId.
    expect(JSON.stringify(first.schema)).toContain('"const":"app.addField"');
    expect(JSON.stringify(first.schema)).not.toContain('approvalId');
    expect(execute.mock.calls[1][0].prompt.text).toContain(
      'Workflow step 2/3: revise',
    );
    const checks = ((await getRunTrajectory(db, created.id))?.entries ?? [])
      .map((entry) => entry.event)
      .filter((event) => event?.type === 'check');
    expect(checks.map((event) => event?.status)).toEqual([
      'passed',
      'passed',
      'passed',
    ]);
    expect((await bound.present(done)).step).toMatchObject({
      index: 3,
      count: 3,
    });
  });

  it('repairs invalid output on the same step through the prompt', async () => {
    let calls = 0;
    const execute = vi.fn<CookbookWorkflowRunsOptions['executeStep']>(
      async () =>
        calls++ === 0 ? { ...output, operations: [{ tool: 'x' }] } : output,
    );
    const bound = install(execute, { budget: { steps: 1 } });
    const created = await bound.start({
      threadId: 'thread',
      content: 'Add a field',
      execution: execution(),
    });
    await startWorker();
    expect((await settled(created.id)).status).toBe('done');
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1][0].prompt.text).toContain(
      'Repair this invalid output using the schema',
    );
  });

  it('fails an unready final proposal with the host note and no effects', async () => {
    const executeOperation = vi.fn();
    const bound = install(async () => ({ ...output, ready: false }), {
      budget: { steps: 1 },
      executeOperation,
    });
    const created = await bound.start({
      threadId: 'thread',
      content: 'Add a field',
      execution: execution(),
    });
    await startWorker();
    const failed = await settled(created.id);
    expect(failed).toMatchObject({
      status: 'failed',
      stopReason: 'check_failed',
    });
    expect(executeOperation).not.toHaveBeenCalled();
    expect((await bound.present(failed)).note).toBe(
      'No changes were made. I need a little more information.',
    );
  });

  it('stops a step cooperatively and resumes the same run', async () => {
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    let first = true;
    const bound = install(
      async ({ signal }) => {
        if (first) {
          first = false;
          began();
          await new Promise((_, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            }),
          );
        }
        return output;
      },
      { budget: { steps: 1 } },
    );
    const created = await bound.start({
      threadId: 'thread',
      content: 'Add a field',
      execution: execution(),
    });
    await startWorker();
    await started;
    expect((await bound.stop(created.id)).status).toBe('stopped');
    await vi.waitFor(
      async () =>
        expect(
          (
            await db.query(
              "SELECT id FROM _smrt_jobs WHERE dedupe_key = ? AND status IN ('pending', 'running')",
              created.id,
            )
          ).rows,
        ).toHaveLength(0),
      { timeout: 10000 },
    );
    expect((await getAiRun(db, created.id))?.stopReason).toBe('interrupted');
    expect((await bound.resume(created.id)).status).toBe('running');
    expect((await settled(created.id)).status).toBe('done');
  });

  it('fails a step whose live operation schema changed since admission', async () => {
    let schema = addField;
    const bound = install(async () => output, {
      budget: { steps: 1 },
      listOperations: async () => [schema],
    });
    const created = await bound.start({
      threadId: 'thread',
      content: 'Add a field',
      execution: execution(),
    });
    schema = { ...addField, description: 'Changed' };
    await startWorker();
    expect(await settled(created.id)).toMatchObject({
      status: 'failed',
      stopReason: 'error',
    });
  });

  it('refuses to register after the task runner started', async () => {
    await startWorker();
    expect(() => install(async () => output)).toThrow(
      JobHandlerRegistrationClosedError,
    );
    host = undefined;
  });
});
