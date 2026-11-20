/**
 * The workflow run driver (#5005; docs/content/ai-runs.md): steps over
 * registered prompts on core's tracked client, repair, the host check,
 * approval, budget stops and resume, versions, retry and recovery. Real
 * SQLite and DuckDB; scripted model, no provider.
 */
import {
  AiRunResumeRefusedError,
  AiRunStoppedError,
  AiRunTrackingDisabledError,
  createTrackedAiClient,
  getAiRun,
  getRunTrajectory,
  openAiRun,
  readAiRunCheckpoint,
  runAiRunCall,
  stopAiRunForChild,
} from '@happyvertical/smrt-core';
import {
  clearPromptCache,
  definePrompt,
  PromptRegistry,
} from '@happyvertical/smrt-prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRunCheckpointStore,
  createWorkflowRunDriver,
  RunConflictError,
  readWorkflowRunLease,
  WorkflowRunNotFoundError,
  type WorkflowStep,
} from '../index.js';
import {
  closeWorkflowDbs,
  deferred,
  definePrompts,
  definitionOf,
  driverFor,
  type Engine,
  rowsOf,
  scriptedModel,
  twoSteps,
  until,
  validate,
  valueSchema,
  workflowDb,
} from './harness.js';

const engines: Engine[] = ['sqlite', 'duckdb'];

beforeEach(() => {
  clearPromptCache();
  definePrompts();
});
afterEach(async () => {
  PromptRegistry.clear();
  await closeWorkflowDbs();
});

const byStep = (index: number) =>
  scriptedModel((_call, n) => ({ output: { value: n + 1 } }));

describe.each(engines)('workflow runs on %s', (engine) => {
  it('runs two steps through registered prompts and records each call, check and step', async () => {
    const db = await workflowDb(engine);
    const { model, calls } = scriptedModel((call) => ({
      output: { value: call.text.startsWith('Propose') ? 1 : 2 },
      tokens: 12,
    }));
    const driver = driverFor(
      db,
      model,
      definitionOf([
        { ...twoSteps[0], check: async () => ({ note: 'looks right' }) },
        twoSteps[1] as WorkflowStep,
      ]),
    );
    const started = await driver.start({
      ownerId: 'owner',
      input: { prompt: 'a kitchen' },
      budget: { maxTokens: 100_000 },
    });
    expect(started).toMatchObject({
      status: 'running',
      step: { index: 1, count: 2 },
    });
    const done = await driver.run(started.id, 'owner');
    expect(done).toMatchObject({
      status: 'done',
      stopReason: null,
      outputs: [{ value: 1 }, { value: 2 }],
      totals: { tokens: 24, calls: 2, stepsUsed: 2 },
    });
    expect(calls[0]?.text).toBe('Propose a value for {"prompt":"a kitchen"}. ');

    const usage = rowsOf(
      await db.query(
        'SELECT prompt_key, template_hash, step_index, step_name, attempt, run_id FROM _smrt_ai_usage ORDER BY step_index',
      ),
    );
    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({
      prompt_key: 'test.workflow.propose',
      step_name: 'Propose',
      run_id: started.id,
    });
    expect(Number(usage[0]?.step_index)).toBe(0);
    expect(Number(usage[0]?.attempt)).toBe(1);
    expect(String(usage[0]?.template_hash)).toMatch(/^[0-9a-f]{12}$/);
    expect(usage[1]).toMatchObject({ prompt_key: 'test.workflow.refine' });

    const trajectory = await getRunTrajectory(db, started.id);
    const events = (trajectory?.entries ?? []).map((entry) => entry.event);
    expect(events.map((event) => [event?.type, event?.status])).toEqual([
      ['call', 'ok'],
      ['check', 'passed'],
      ['call', 'ok'],
      ['check', 'passed'],
    ]);
    // A check points at the call it judged.
    expect(events[1]?.parentEventId).toBe(events[0]?.id);
    expect(events[1]?.payload).toEqual({ note: 'looks right' });
    expect(events[3]?.parentEventId).toBe(events[2]?.id);

    // The checkpoint holds the run type's state, not tokens or attempts.
    const checkpoint = await readAiRunCheckpoint(db, started.id);
    expect(checkpoint?.state).toMatchObject({
      v: 1,
      stepIndex: 2,
      outputs: [{ value: 1 }, { value: 2 }],
    });
    expect(JSON.stringify(checkpoint?.state)).not.toMatch(/tokens|attempts/);
  });

  it("sends each step's prompt call options: its effort as reasoning, no tier keys", async () => {
    const db = await workflowDb(engine);
    definePrompt({
      key: 'test.workflow.effort',
      template: 'Think hard about {input}.',
      ai: { effort: 'high', temperature: 0.2, maxTokens: 300 },
    });
    const { model, calls } = scriptedModel(() => ({ output: { value: 1 } }));
    const driver = driverFor(
      db,
      model,
      definitionOf([
        {
          name: 'Think',
          promptKey: 'test.workflow.effort',
          schema: valueSchema,
          expectedOutputTokens: 50,
        },
      ]),
    );
    const run = await driver.start({ ownerId: 'owner' });
    expect(await driver.run(run.id, 'owner')).toMatchObject({ status: 'done' });
    expect(calls[0]?.options).toMatchObject({
      reasoning: { effort: 'high' },
      temperature: 0.2,
      maxTokens: 300,
    });
    expect(calls[0]?.options).not.toHaveProperty('tier');
    expect(calls[0]?.options.signal).toBeInstanceOf(AbortSignal);
  });

  it('records bounded structured schema and host diagnostics linked to the judged call', async () => {
    const db = await workflowDb(engine);
    const { model, calls } = byStep(0);
    let first = true;
    const issue = {
      code: 'invalid-expression',
      path: 'tables[0].fields[2].calculated',
      message: `mul requires left and right. ${'x'.repeat(1100)}`,
      repair: 'model-only fragment',
    };
    const driver = driverFor(
      db,
      model,
      definitionOf([
        {
          ...twoSteps[0],
          check: () => ({ complete: true, diagnostics: [issue] }),
        },
      ]),
      {
        validate: () => {
          if (!first) return [];
          first = false;
          return [issue];
        },
      },
    );
    const run = await driver.start({
      ownerId: 'owner',
      budget: { repairRetries: 1 },
    });
    expect((await driver.run(run.id, 'owner')).status).toBe('done');
    expect(calls[1]?.text).toContain('mul requires left and right');
    expect(calls[1]?.text).toContain('model-only fragment');
    const events = (await getRunTrajectory(db, run.id))!.entries
      .map((e) => e.event)
      .filter((e) => e?.type === 'check');
    expect(events.map((e) => e?.status)).toEqual(['failed', 'passed']);
    for (const event of events) {
      expect(event?.parentEventId).toBeTruthy();
      expect(JSON.stringify(event?.payload)).not.toContain(
        'model-only fragment',
      );
      expect(event?.payload).toMatchObject({
        diagnostics: [
          {
            code: issue.code,
            path: issue.path,
            message: issue.message.slice(0, 1000),
          },
        ],
      });
    }
    const rejected = driverFor(db, model, definitionOf([twoSteps[0]]), {
      validate: () => [issue],
    });
    const failed = await rejected.start({
      ownerId: 'owner',
      budget: { repairRetries: 0 },
    });
    expect((await rejected.run(failed.id, 'owner')).stopReason).toBe(
      'repairs_exhausted',
    );
    expect((await readAiRunCheckpoint(db, failed.id))?.state).toMatchObject({
      invalid: {
        output: { value: 3 },
        errors: [expect.stringContaining('invalid-expression')],
      },
    });
    const many = driverFor(
      db,
      model,
      definitionOf([
        {
          ...twoSteps[0],
          check: () => ({
            complete: true,
            diagnostics: Array.from({ length: 20 }, () => issue),
          }),
        },
      ]),
    );
    const large = await many.start({ ownerId: 'owner' });
    await many.run(large.id, 'owner');
    const event = (await getRunTrajectory(db, large.id))?.entries.find(
      (e) => e.event?.type === 'check',
    )?.event;
    expect(event?.truncated).toBe(false);
    expect(
      new TextEncoder().encode(JSON.stringify(event?.payload)).byteLength,
    ).toBeLessThan(9000);
  });

  it('repairs invalid output on the same step instance, then fails with repairs_exhausted', async () => {
    const db = await workflowDb(engine);
    const { model, calls } = scriptedModel((_call, n) => ({
      output: n === 0 ? { wrong: true } : { value: 1 },
    }));
    const driver = driverFor(db, model);
    const run = await driver.start({
      ownerId: 'owner',
      budget: { repairRetries: 1 },
    });
    expect((await driver.run(run.id, 'owner')).status).toBe('done');
    expect(calls[1]?.text).toContain('must NOT have additional properties');
    const attempts = rowsOf(
      await db.query(
        'SELECT step_index, step_instance_id, attempt FROM _smrt_ai_usage ORDER BY created_at, attempt',
      ),
    );
    expect(attempts.map((row) => Number(row.attempt))).toEqual([1, 2, 1]);
    expect(attempts[0]?.step_instance_id).toBe(attempts[1]?.step_instance_id);

    const { model: broken } = scriptedModel(() => ({ output: 'not json' }));
    const failing = driverFor(db, broken);
    const second = await failing.start({
      ownerId: 'owner',
      budget: { repairRetries: 1 },
    });
    expect(await failing.run(second.id, 'owner')).toMatchObject({
      status: 'failed',
      stopReason: 'repairs_exhausted',
    });
    expect((await getAiRun(db, second.id))?.calls).toBe(2);
  });

  it('fails with check_failed on a host rejection and bounds repeats', async () => {
    const db = await workflowDb(engine);
    const { model } = byStep(0);
    const rejecting = driverFor(
      db,
      model,
      definitionOf([
        {
          ...twoSteps[0],
          check: () => ({ failure: 'The owner rejected it.' }),
        },
      ] as WorkflowStep[]),
    );
    const run = await rejecting.start({ ownerId: 'owner' });
    expect(await rejecting.run(run.id, 'owner')).toMatchObject({
      status: 'failed',
      stopReason: 'check_failed',
    });
    const events = (await getRunTrajectory(db, run.id))?.entries ?? [];
    expect(events.at(-1)?.event).toMatchObject({
      type: 'check',
      status: 'failed',
      payload: { failure: 'The owner rejected it.' },
    });

    let checks = 0;
    const repeating = driverFor(
      db,
      model,
      definitionOf([
        {
          ...twoSteps[0],
          maxRepeats: 1,
          check: () => ({ repeat: ++checks < 5 }),
        },
      ] as WorkflowStep[]),
    );
    const again = await repeating.start({
      ownerId: 'owner',
      budget: { maxSteps: 1 },
    });
    expect(await repeating.run(again.id, 'owner')).toMatchObject({
      status: 'failed',
      stopReason: 'check_failed',
      // A repeat is the same step index: counted once against maxSteps.
      totals: { stepsUsed: 1 },
    });
    expect(checks).toBe(2);
  });

  it('pauses for approval (durable) and continues after the decision', async () => {
    const db = await workflowDb(engine);
    const { model, calls } = byStep(0);
    const approvals: (string | null)[] = [];
    const step: WorkflowStep = {
      ...(twoSteps[0] as WorkflowStep),
      check: (_output, context) => {
        approvals.push(context.approval);
        return context.approval === 'approved'
          ? {}
          : { waitingApproval: true, note: 'Apply to the kitchen?' };
      },
    };
    const driver = driverFor(db, model, definitionOf([step]));
    for (const approved of [true, false]) {
      const run = await driver.start({ ownerId: 'owner' });
      expect(await driver.run(run.id, 'owner')).toMatchObject({
        status: 'waiting-approval',
        pending: { value: expect.any(Number) },
      });
      // Running it again while it waits does nothing.
      expect((await driver.run(run.id, 'owner')).status).toBe(
        'waiting-approval',
      );
      const decided = await driver.decide(run.id, 'owner', { approved });
      if (approved) {
        expect(decided.status).toBe('running');
        expect(await driver.run(run.id, 'owner')).toMatchObject({
          status: 'done',
          outputs: [{ value: expect.any(Number) }],
        });
      } else {
        expect(decided).toMatchObject({
          status: 'failed',
          stopReason: 'check_failed',
        });
      }
      const events = ((await getRunTrajectory(db, run.id))?.entries ?? []).map(
        (entry) => entry.event,
      );
      const request = events.find((event) => event?.status === 'requested');
      const decision = events.find(
        (event) => event?.status === (approved ? 'approved' : 'refused'),
      );
      expect(request).toMatchObject({
        type: 'approval',
        parentEventId: events[0]?.id,
        payload: { note: 'Apply to the kitchen?' },
      });
      expect(decision).toMatchObject({
        type: 'approval',
        parentEventId: request?.id,
      });
    }
    // The model was called once per run: approval never repeats the call.
    expect(calls).toHaveLength(2);
    expect(approvals).toEqual([null, 'approved', null]);
    await expect(
      driver.decide((await driver.start({ ownerId: 'owner' })).id, 'owner', {
        approved: true,
      }),
    ).rejects.toBeInstanceOf(RunConflictError);
  });

  it('holds a step once per gated action and never ends done with a hold outstanding', async () => {
    const db = await workflowDb(engine);
    const { model, calls } = byStep(0);
    const seen: Array<[string | null, number]> = [];
    const step: WorkflowStep = {
      ...(twoSteps[0] as WorkflowStep),
      // Two gated actions: the check holds for each in turn.
      check: (_output, context) => {
        seen.push([context.approval, context.approvals]);
        return context.approvals < 2
          ? {
              waitingApproval: true,
              holdRef: `approval:hold-${context.approvals + 1}`,
            }
          : { note: 'both applied' };
      },
    };
    const driver = driverFor(db, model, definitionOf([step]));
    const run = await driver.start({ ownerId: 'owner' });
    expect((await driver.run(run.id, 'owner')).status).toBe('waiting-approval');
    expect(
      (await driver.decide(run.id, 'owner', { approved: true })).status,
    ).toBe('running');
    // The first approval does not pass the second hold.
    expect(await driver.run(run.id, 'owner')).toMatchObject({
      status: 'waiting-approval',
      outputs: [],
    });
    expect((await getAiRun(db, run.id))?.status).toBe('waiting-approval');
    await driver.decide(run.id, 'owner', { approved: true });
    expect(await driver.run(run.id, 'owner')).toMatchObject({
      status: 'done',
      outputs: [{ value: expect.any(Number) }],
    });
    expect(seen).toEqual([
      [null, 0],
      ['approved', 1],
      ['approved', 2],
    ]);
    expect(calls).toHaveLength(1);
    const approvalEvents = ((await getRunTrajectory(db, run.id))?.entries ?? [])
      .map((entry) => entry.event)
      .filter((event) => event?.type === 'approval');
    expect(
      approvalEvents.map((event) => [event?.status, event?.payloadRef]),
    ).toEqual([
      ['requested', 'approval:hold-1'],
      ['approved', null],
      ['requested', 'approval:hold-2'],
      ['approved', null],
    ]);
    // A refused second hold fails the step: nothing after it runs.
    const refused = await driver.start({ ownerId: 'owner' });
    await driver.run(refused.id, 'owner');
    await driver.decide(refused.id, 'owner', { approved: true });
    await driver.run(refused.id, 'owner');
    expect(
      await driver.decide(refused.id, 'owner', { approved: false }),
    ).toMatchObject({ status: 'failed', stopReason: 'check_failed' });
  });

  it('keeps a decision made while the run is stopped until resume', async () => {
    const db = await workflowDb(engine);
    const { model } = byStep(0);
    const step: WorkflowStep = {
      ...(twoSteps[0] as WorkflowStep),
      check: (_output, context) =>
        context.approval === 'approved' ? {} : { waitingApproval: true },
    };
    const driver = driverFor(db, model, definitionOf([step]));
    for (const approved of [true, false]) {
      const run = await driver.start({ ownerId: 'owner' });
      await driver.run(run.id, 'owner');
      expect((await driver.stop(run.id, 'owner')).status).toBe('stopped');
      expect((await driver.decide(run.id, 'owner', { approved })).status).toBe(
        'stopped',
      );
      await expect(
        driver.decide(run.id, 'owner', { approved }),
      ).rejects.toBeInstanceOf(RunConflictError);
      expect((await driver.resume(run.id, 'owner')).status).toBe('running');
      expect(await driver.run(run.id, 'owner')).toMatchObject(
        approved
          ? { status: 'done', outputs: [{ value: expect.any(Number) }] }
          : { status: 'failed', stopReason: 'check_failed' },
      );
    }
  });

  it('stops at a budget limit, refuses an unchanged resume, and resumes with a raised one', async () => {
    const db = await workflowDb(engine);
    const { model, calls } = scriptedModel(() => ({
      output: { value: 1 },
      tokens: 30,
    }));
    // Each call reserves its input (characters / 4) plus 100 output tokens:
    // the first fits, the second does not once the first used 30.
    const steps = twoSteps.map((step) => ({
      ...step,
      expectedOutputTokens: 100,
    }));
    const driver = driverFor(db, model, definitionOf(steps));
    const run = await driver.start({
      ownerId: 'owner',
      budget: { maxTokens: 130 },
    });
    const stopped = await driver.run(run.id, 'owner');
    expect(stopped).toMatchObject({
      status: 'stopped',
      stopReason: 'max_tokens',
      stopDetail: { limit: 'maxTokens' },
      step: { index: 2 },
      totals: { calls: 1 },
    });
    await expect(driver.resume(run.id, 'owner')).rejects.toMatchObject({
      reason: 'budget_unchanged',
    });
    await expect(
      driver.resume(run.id, 'owner', { budget: { maxTokens: 100 } }),
    ).rejects.toMatchObject({ reason: 'budget_lowered' });
    const ceilinged = driverFor(db, model, definitionOf(steps), {
      ceiling: { maxTokens: 5000 },
    });
    await expect(
      ceilinged.resume(run.id, 'owner', { budget: { maxTokens: 9000 } }),
    ).rejects.toMatchObject({ reason: 'above_ceiling' });
    expect(
      await ceilinged.resume(run.id, 'owner', { budget: { maxTokens: 5000 } }),
    ).toMatchObject({ status: 'running', budget: { maxTokens: 5000 } });
    expect(await ceilinged.run(run.id, 'owner')).toMatchObject({
      status: 'done',
      totals: { calls: 2, tokens: 60, stepsUsed: 2 },
    });
    expect(calls).toHaveLength(2);
  });

  it('retries a resume and its admission as one transaction after a conflict', async () => {
    const db = await workflowDb(engine);
    const { model } = scriptedModel(() => ({
      output: { value: 1 },
      tokens: 30,
    }));
    const steps = twoSteps.map((step) => ({
      ...step,
      expectedOutputTokens: 100,
    }));
    const driver = driverFor(db, model, definitionOf(steps));
    const run = await driver.start({
      ownerId: 'owner',
      budget: { maxTokens: 130 },
    });
    expect((await driver.run(run.id, 'owner')).status).toBe('stopped');
    const seen: string[] = [];
    const resumed = await driver.resume(run.id, 'owner', {
      budget: { maxTokens: 5000 },
      admit: async (tx) => {
        const [row] = rowsOf(
          await tx.query(
            'SELECT status FROM _smrt_ai_runs WHERE id = $1',
            run.id,
          ),
        );
        seen.push(String(row?.status));
        // A write conflict on the first try: the status change rolls back
        // with it, so the second try resumes a stopped run again.
        if (seen.length === 1) throw new Error('write-write conflict');
      },
    });
    expect(seen).toEqual(['running', 'running']);
    expect(resumed).toMatchObject({
      status: 'running',
      budget: { maxTokens: 5000 },
    });
  });

  it('counts a step once against maxSteps across stop and resume', async () => {
    const db = await workflowDb(engine);
    const gate = deferred();
    let first = true;
    const { model } = scriptedModel(async (_call, n) => {
      if (first) {
        first = false;
        await gate.promise;
      }
      return { output: { value: n } };
    });
    const driver = driverFor(db, model);
    const run = await driver.start({
      ownerId: 'owner',
      budget: { maxSteps: 2 },
    });
    const working = driver.run(run.id, 'owner');
    await until(async () => (await getAiRun(db, run.id))?.reservedCalls === 1);
    expect((await driver.stop(run.id, 'owner')).status).toBe('stopped');
    gate.resolve();
    expect(await working).toMatchObject({
      status: 'stopped',
      stopReason: 'interrupted',
      totals: { stepsUsed: 1 },
    });
    for (let i = 0; i < 3; i++) {
      await driver.resume(run.id, 'owner');
      await driver.stop(run.id, 'owner');
    }
    await driver.resume(run.id, 'owner');
    expect(await driver.run(run.id, 'owner')).toMatchObject({
      status: 'done',
      totals: { stepsUsed: 2 },
    });
  });

  it('stops with definition_changed unless a newer version accepts and migrates the checkpoint', async () => {
    const db = await workflowDb(engine);
    const gate = deferred();
    const { model } = scriptedModel(async (_call, n) => {
      if (n === 1) await gate.promise;
      return { output: { value: n + 1 } };
    });
    const v1 = driverFor(db, model);
    const run = await v1.start({ ownerId: 'owner', input: { size: 1 } });
    const working = v1.run(run.id, 'owner');
    await until(async () => (await getAiRun(db, run.id))?.stepsUsed === 2);
    await v1.stop(run.id, 'owner');
    gate.resolve();
    await working;

    const v2 = driverFor(db, model, definitionOf(twoSteps, { version: '2' }));
    await expect(v2.resume(run.id, 'owner')).rejects.toMatchObject({
      reason: 'definition_changed',
    });
    expect(await v2.get(run.id, 'owner')).toMatchObject({
      status: 'stopped',
      stopReason: 'definition_changed',
    });

    const migrate = vi.fn((state) => ({
      ...state,
      input: { size: (state.input as { size: number }).size, unit: 'm' },
    }));
    const v3 = driverFor(
      db,
      model,
      definitionOf(twoSteps, {
        version: '3',
        olderCheckpoints: { accepts: (version) => version === '1', migrate },
      }),
    );
    await v3.resume(run.id, 'owner');
    expect(await v3.run(run.id, 'owner')).toMatchObject({
      status: 'done',
      definitionVersion: '3',
      input: { size: 1, unit: 'm' },
      outputs: [{ value: 1 }, { value: expect.any(Number) }],
    });
    expect(migrate).toHaveBeenCalledWith(
      expect.objectContaining({ stepIndex: 1 }),
      '1',
    );
    expect((await getAiRun(db, run.id))?.definitionVersion).toBe('3');
  });

  it('retries a failed run from its last accepted step as a new run', async () => {
    const db = await workflowDb(engine);
    let refuse = true;
    const { model, calls } = byStep(0);
    const steps: WorkflowStep[] = [
      twoSteps[0] as WorkflowStep,
      {
        ...(twoSteps[1] as WorkflowStep),
        check: () => (refuse ? { failure: 'Not yet.' } : {}),
      },
    ];
    const driver = driverFor(db, model, definitionOf(steps));
    const failed = await driver.start({ ownerId: 'owner', input: { n: 1 } });
    expect(await driver.run(failed.id, 'owner')).toMatchObject({
      status: 'failed',
      stopReason: 'check_failed',
      outputs: [{ value: 1 }],
    });
    refuse = false;
    const retry = await driver.retry(failed.id, 'owner', {
      budget: { maxSteps: 1 },
    });
    expect(retry).toMatchObject({
      status: 'running',
      retryOfRunId: failed.id,
      step: { index: 2 },
      outputs: [{ value: 1 }],
      input: { n: 1 },
      totals: { tokens: 0, calls: 0, stepsUsed: 0 },
    });
    // The inherited step is not counted against the retry's maxSteps.
    expect(await driver.run(retry.id, 'owner')).toMatchObject({
      status: 'done',
      outputs: [{ value: 1 }, { value: 3 }],
      totals: { stepsUsed: 1, calls: 1 },
    });
    expect(calls).toHaveLength(3);
    // The failed run keeps its own spend; it was never resumed in place.
    expect(await getAiRun(db, failed.id)).toMatchObject({
      status: 'failed',
      calls: 2,
    });
    await expect(driver.retry(retry.id, 'owner')).rejects.toMatchObject({
      reason: 'not_retryable',
    });
    const v2 = driverFor(db, model, definitionOf(steps, { version: '2' }));
    await expect(v2.retry(failed.id, 'owner')).rejects.toMatchObject({
      reason: 'definition_changed',
    });
    await expect(driver.retry(failed.id, 'stranger')).rejects.toBeInstanceOf(
      WorkflowRunNotFoundError,
    );
  });

  it('cancels for good, and stops (resumable) when the job signal aborts', async () => {
    const db = await workflowDb(engine);
    const { model } = scriptedModel(
      async (call) =>
        new Promise((resolve, reject) => {
          const signal = call.options.signal as AbortSignal;
          // The job may abort between the reservation and the send.
          if (signal.aborted) reject(signal.reason);
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const driver = driverFor(db, model);
    const run = await driver.start({ ownerId: 'owner' });
    const job = new AbortController();
    const working = driver.run(run.id, 'owner', { signal: job.signal });
    await until(async () => (await getAiRun(db, run.id))?.reservedCalls === 1);
    job.abort(new Error('job cancelled'));
    expect(await working).toMatchObject({
      status: 'stopped',
      stopReason: 'interrupted',
    });
    // The aborted call was released, never charged.
    expect(await getAiRun(db, run.id)).toMatchObject({
      reservedCalls: 0,
      calls: 0,
    });
    expect((await driver.cancel(run.id, 'owner')).status).toBe('cancelled');
    await expect(driver.resume(run.id, 'owner')).rejects.toMatchObject({
      reason: 'not_resumable',
    });
  });

  it('treats a child run stop as a stop of the workflow, never a repair, and resumes with a new child', async () => {
    const db = await workflowDb(engine);
    const children: string[] = [];
    const fusionStep: WorkflowStep = {
      name: 'Draft',
      promptKey: 'test.workflow.propose',
      schema: valueSchema,
      // What the tracked client does for a tier bound to a fusion: open the
      // child run with a handoff, reserve the seats against the chain, and
      // carry a child's stop up to the run that made the entry call.
      execute: async ({ runContext }) => {
        const child = await openAiRun(
          { db, usageTracking: true },
          {
            type: 'fusion',
            parentRunId: runContext.runId,
            handoff: {
              callId: 'entry',
              stepIndex: runContext.stepIndex ?? null,
            },
          },
        );
        children.push(child.id);
        try {
          await runAiRunCall(
            { runId: child.id, db },
            {
              inputTokens: 900,
              outputLimit: 100,
              fallbackUsage: {
                provider: 'test',
                model: 'seat',
                operation: 'message',
              },
            },
            async (invocation) => {
              invocation.capture({
                provider: 'test',
                model: 'seat',
                operation: 'message',
                usage: {
                  promptTokens: 900,
                  completionTokens: 50,
                  totalTokens: 950,
                },
                duration: 1,
                timestamp: new Date(),
              });
              return 'ok';
            },
          );
        } catch (error) {
          if (error instanceof AiRunStoppedError) {
            throw await stopAiRunForChild(db, runContext.runId, error);
          }
          throw error;
        }
        return { value: 1 };
      },
    };
    const { model } = byStep(0);
    const driver = driverFor(db, model, definitionOf([fusionStep]));
    const run = await driver.start({
      ownerId: 'owner',
      budget: { maxTokens: 500, repairRetries: 3 },
    });
    const stopped = await driver.run(run.id, 'owner');
    expect(stopped).toMatchObject({
      status: 'stopped',
      stopReason: 'max_tokens',
      stoppedByRunId: run.id,
      phase: 'call',
    });
    expect((await readAiRunCheckpoint(db, run.id))?.state).toMatchObject({
      repairs: 0,
    });
    await driver.resume(run.id, 'owner', { budget: { maxTokens: 5000 } });
    expect(await driver.run(run.id, 'owner')).toMatchObject({
      status: 'done',
      totals: { tokens: 0, inclusiveTokens: 950, stepsUsed: 1 },
    });
    expect(children).toHaveLength(2);
    const events = ((await getRunTrajectory(db, run.id))?.entries ?? []).map(
      (entry) => entry.event,
    );
    const handoffs = events.filter((event) => event?.type === 'handoff');
    expect(handoffs.map((event) => event?.childRunId)).toEqual(children);
    // The check of the step points at the handoff to the child that answered.
    expect(events.at(-1)).toMatchObject({
      type: 'check',
      status: 'passed',
      parentEventId: handoffs[1]?.id,
    });
  });

  it('passes large input by reference, never into the checkpoint', async () => {
    const db = await workflowDb(engine);
    const { model, calls } = byStep(0);
    const readInput = vi.fn(async (ref: string) => ({
      document: `${ref}:body`,
    }));
    const driver = driverFor(db, model, definitionOf(), { readInput });
    const run = await driver.start({ ownerId: 'owner', inputRef: 'file:42' });
    expect((await readAiRunCheckpoint(db, run.id))?.state).toMatchObject({
      input: null,
      inputRef: 'file:42',
    });
    expect((await driver.run(run.id, 'owner')).status).toBe('done');
    expect(readInput).toHaveBeenCalledWith('file:42', {
      ownerId: 'owner',
      tenantId: null,
    });
    expect(calls[0]?.text).toContain('file:42:body');
  });
});

describe('workflow run safety', () => {
  it('refuses to open a run while usage tracking is off', async () => {
    const db = await workflowDb('sqlite');
    const { model } = byStep(0);
    const driver = createWorkflowRunDriver({
      ai: createTrackedAiClient({
        db,
        ai: model as never,
        usage: { persist: false },
      }),
      definition: definitionOf(),
      validate,
    });
    await expect(driver.start({ ownerId: 'owner' })).rejects.toBeInstanceOf(
      AiRunTrackingDisabledError,
    );
    expect(rowsOf(await db.query('SELECT id FROM _smrt_ai_runs'))).toEqual([]);
  });

  it('scopes runs to their owner and tenant', async () => {
    const db = await workflowDb('sqlite');
    const { model } = byStep(0);
    const driver = driverFor(db, model);
    const run = await driver.start({ ownerId: 'owner' });
    await expect(driver.get(run.id, 'other')).rejects.toBeInstanceOf(
      WorkflowRunNotFoundError,
    );
    const otherTenant = driverFor(
      db,
      model,
      definitionOf(),
      {},
      crypto.randomUUID(),
    );
    await expect(otherTenant.get(run.id, 'owner')).rejects.toBeInstanceOf(
      WorkflowRunNotFoundError,
    );
    await expect(otherTenant.run(run.id, 'owner')).rejects.toBeInstanceOf(
      WorkflowRunNotFoundError,
    );
  });

  it('retries only a failed run of its own tenant; another tenant run reads as unknown', async () => {
    const db = await workflowDb('sqlite');
    const { model } = byStep(0);
    const steps: WorkflowStep[] = [
      twoSteps[0] as WorkflowStep,
      { ...(twoSteps[1] as WorkflowStep), check: () => ({ failure: 'No.' }) },
    ];
    const driver = driverFor(db, model, definitionOf(steps));
    const failed = await driver.start({ ownerId: 'owner', input: { n: 1 } });
    expect((await driver.run(failed.id, 'owner')).status).toBe('failed');
    const otherTenant = driverFor(
      db,
      model,
      definitionOf(steps),
      {},
      crypto.randomUUID(),
    );
    const before = rowsOf(await db.query('SELECT id FROM _smrt_ai_runs'));
    const foreign = await otherTenant
      .retry(failed.id, 'owner')
      .catch((error) => error);
    const unknown = await otherTenant
      .retry(crypto.randomUUID(), 'owner')
      .catch((error) => error);
    expect(foreign).toBeInstanceOf(AiRunResumeRefusedError);
    expect(foreign.reason).toBe('retry_source_pruned');
    expect(foreign.constructor).toBe(unknown.constructor);
    expect(foreign.reason).toBe(unknown.reason);
    expect(rowsOf(await db.query('SELECT id FROM _smrt_ai_runs'))).toEqual(
      before,
    );
    // The owning tenant still retries it.
    expect((await driver.retry(failed.id, 'owner')).retryOfRunId).toBe(
      failed.id,
    );
  });

  it('looks a retried run up in its own tenant before reading it', async () => {
    const db = await workflowDb('sqlite');
    const { model } = byStep(0);
    const steps: WorkflowStep[] = [
      twoSteps[0] as WorkflowStep,
      { ...(twoSteps[1] as WorkflowStep), check: () => ({ failure: 'No.' }) },
    ];
    const driver = driverFor(db, model, definitionOf(steps));
    const failed = await driver.start({ ownerId: 'owner', input: { n: 1 } });
    expect((await driver.run(failed.id, 'owner')).status).toBe('failed');
    const otherTenant = driverFor(
      db,
      model,
      definitionOf(steps),
      {},
      crypto.randomUUID(),
    );
    // Every statement naming the other tenant's run carries the tenant as a
    // predicate, except core's single read of its tenant before refusing.
    const unscoped: string[] = [];
    const original = db.query.bind(db);
    (db as { query: unknown }).query = (sql: string, ...params: unknown[]) => {
      const text = sql.replace(/\s+/g, ' ').trim();
      if (
        params.includes(failed.id) &&
        !/tenant_id (=|IS NULL)/.test(text) &&
        text !== 'SELECT tenant_id FROM _smrt_ai_runs WHERE id = $1'
      ) {
        unscoped.push(text);
      }
      return original(sql, ...params);
    };
    await expect(otherTenant.retry(failed.id, 'owner')).rejects.toBeInstanceOf(
      AiRunResumeRefusedError,
    );
    (db as { query: unknown }).query = original;
    expect(unscoped).toEqual([]);
  });

  it('never pairs a run with the checkpoint of a run that took its id', async () => {
    const db = await workflowDb('sqlite');
    const { model } = byStep(0);
    const run = await driverFor(db, model).start({ ownerId: 'owner' });
    const store = createRunCheckpointStore({ db, ownerId: 'owner' });
    // The id is pruned and reused by another tenant while the checkpoint is
    // read: what the store returns is this tenant's or nothing.
    const original = db.query.bind(db);
    (db as { query: unknown }).query = async (
      sql: string,
      ...params: unknown[]
    ) => {
      if (
        /FROM _smrt_ai_run_checkpoints c\b/.test(sql) &&
        params.includes(run.id)
      ) {
        await original(
          "UPDATE _smrt_ai_runs SET tenant_id = 'other-tenant', created_at = $1, started_at = $1 WHERE id = $2",
          new Date(Date.now() + 5_000).toISOString(),
          run.id,
        );
      }
      return original(sql, ...params);
    };
    expect(await store.load(run.id)).toBeNull();
    (db as { query: unknown }).query = original;
  });

  it('loads a checkpoint whose run kept its id and tenant (control)', async () => {
    const db = await workflowDb('sqlite');
    const { model } = byStep(0);
    const run = await driverFor(db, model).start({ ownerId: 'owner' });
    const store = createRunCheckpointStore({ db, ownerId: 'owner' });
    expect((await store.load(run.id))?.run.id).toBe(run.id);
  });

  it('judges a retry source with one read in its tenant, and core refuses another owner under its lock', async () => {
    const db = await workflowDb('sqlite');
    const { model } = byStep(0);
    const driver = driverFor(db, model, definitionOf());
    const run = await driver.start({ ownerId: 'owner' });
    // The source changes owner after the workflow's pre-check (a row an
    // older core rewrote): core compares the owner again under its lock.
    const original = db.query.bind(db);
    let reads = 0;
    (db as { query: unknown }).query = async (
      sql: string,
      ...params: unknown[]
    ) => {
      const text = sql.replace(/\s+/g, ' ').trim();
      if (
        text.includes('FROM _smrt_ai_runs r WHERE r.id = $1') &&
        params[0] === run.id &&
        ++reads === 2
      ) {
        await original(
          "UPDATE _smrt_ai_runs SET owner_id = 'stranger', status = 'failed' WHERE id = $1",
          run.id,
        );
      }
      return original(sql, ...params);
    };
    const refused = await driver
      .retry(run.id, 'owner')
      .catch((error: unknown) => error);
    (db as { query: unknown }).query = original;
    expect(refused).toBeInstanceOf(AiRunResumeRefusedError);
    expect((refused as AiRunResumeRefusedError).reason).toBe('not_retryable');
  });

  it('lets one of two concurrent checkpoint saves win (revision compare-and-swap)', async () => {
    const db = await workflowDb('sqlite');
    const { model } = byStep(0);
    const run = await driverFor(db, model).start({ ownerId: 'owner' });
    const a = createRunCheckpointStore({ db, ownerId: 'owner' });
    const b = createRunCheckpointStore({ db, ownerId: 'owner' });
    const loaded = await a.load(run.id);
    if (!loaded) throw new Error('missing run');
    const results = await Promise.allSettled([
      a.save(run.id, {
        expectedRevision: loaded.checkpoint.revision,
        state: { ...loaded.state, repairs: 1 },
      }),
      b.save(run.id, {
        expectedRevision: loaded.checkpoint.revision,
        state: { ...loaded.state, repairs: 2 },
      }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const lost = results.find((result) => result.status === 'rejected');
    expect(lost?.status === 'rejected' && lost.reason).toBeInstanceOf(
      RunConflictError,
    );
    expect((await a.load(run.id))?.checkpoint.revision).toBe(
      loaded.checkpoint.revision + 1,
    );
  });

  it('renews its lease on the checkpoint while it works, on the run’s own connection', async () => {
    const db = await workflowDb('sqlite');
    const gate = deferred();
    const { model } = scriptedModel(async () => {
      await gate.promise;
      return { output: { value: 1 } };
    });
    const driver = driverFor(
      db,
      model,
      definitionOf([twoSteps[0] as WorkflowStep]),
      {
        leaseTtlMs: 60,
      },
    );
    const run = await driver.start({ ownerId: 'owner' });
    const working = driver.run(run.id, 'owner', { holder: 'worker-1' });
    await until(async () => (await getAiRun(db, run.id))?.reservedCalls === 1);
    const firstLease = readWorkflowRunLease(
      (await readAiRunCheckpoint(db, run.id)) ?? { lease: null },
    );
    expect(firstLease?.holder).toBe('worker-1');
    await until(async () => {
      const lease = readWorkflowRunLease(
        (await readAiRunCheckpoint(db, run.id)) ?? { lease: null },
      );
      return Boolean(
        lease && firstLease && lease.expiresAt > firstLease.expiresAt,
      );
    });
    gate.resolve();
    expect((await working).status).toBe('done');
    // A second worker in this process is refused while the first works.
    const again = await driver.start({ ownerId: 'owner' });
    const hold = deferred();
    const { model: slow } = scriptedModel(async () => {
      await hold.promise;
      return { output: { value: 1 } };
    });
    const slowDriver = driverFor(
      db,
      slow,
      definitionOf([twoSteps[0] as WorkflowStep]),
    );
    const busy = slowDriver.run(again.id, 'owner');
    await until(
      async () => (await getAiRun(db, again.id))?.reservedCalls === 1,
    );
    await expect(slowDriver.run(again.id, 'owner')).rejects.toBeInstanceOf(
      RunConflictError,
    );
    await expect(slowDriver.resume(again.id, 'owner')).rejects.toBeInstanceOf(
      RunConflictError,
    );
    hold.resolve();
    expect((await busy).status).toBe('done');
  });

  it('recovers after a worker dies mid-call: reconciles its reservation and finishes without counting the step again', async () => {
    const db = await workflowDb('sqlite');
    const hung = deferred();
    let crashed = false;
    const { model, calls } = scriptedModel(async (_call, n) => {
      if (!crashed) {
        crashed = true;
        await hung.promise; // the first worker's process "dies" here
      }
      return { output: { value: n + 1 } };
    });
    const first = driverFor(db, model, definitionOf(), { leaseTtlMs: 1000 });
    const run = await first.start({
      ownerId: 'owner',
      budget: { maxSteps: 2 },
    });
    const dead = first.run(run.id, 'owner', { holder: 'worker-1' });
    await until(async () => (await getAiRun(db, run.id))?.reservedCalls === 1);

    // A replacement worker (another process: another driver) takes the run.
    const second = driverFor(db, model);
    expect(
      await second.run(run.id, 'owner', { holder: 'worker-2' }),
    ).toMatchObject({
      status: 'done',
      totals: { stepsUsed: 2 },
    });
    const after = await getAiRun(db, run.id);
    expect(after).toMatchObject({
      reservedCalls: 0,
      stepsUsed: 2,
      status: 'done',
    });
    const reservations = ((await getRunTrajectory(db, run.id))?.entries ?? [])
      .map((entry) => entry.event)
      .filter((event) => event?.type === 'call')
      .map((event) => event?.reservation);
    expect(reservations[0]).toBe('abandoned');

    // The dead worker's late answer is charged once and writes nothing else.
    hung.resolve();
    const late = await dead.catch((error) => error);
    expect(late instanceof RunConflictError || late?.status === 'done').toBe(
      true,
    );
    const final = await getAiRun(db, run.id);
    expect(final).toMatchObject({ status: 'done', reservedCalls: 0 });
    expect(final?.calls).toBe(calls.length);
    expect((await second.get(run.id, 'owner')).outputs).toHaveLength(2);
  });
});
