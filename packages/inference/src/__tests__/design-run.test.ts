import { describe, expect, it, vi } from 'vitest';
import {
  createDesignRunDriver,
  DesignRunConflictError,
  type DesignRunDriverOptions,
  type DesignRunProgress,
  type DesignRunState,
  type DesignRunStore,
} from '../design-run.js';

function fixture() {
  const rows = new Map<string, DesignRunState>();
  const store: DesignRunStore = {
    async load(id, owner) {
      const row = rows.get(id);
      return row?.ownerId === owner ? structuredClone(row) : null;
    },
    async releaseLease(id, owner, leaseRevision) {
      const row = rows.get(id);
      if (
        !row ||
        row.ownerId !== owner ||
        row.status !== 'stopped' ||
        row.leaseRevision !== leaseRevision
      )
        return false;
      rows.set(id, {
        ...row,
        revision: row.revision + 1,
        leaseUntil: undefined,
        leaseRevision: undefined,
      });
      return true;
    },
    async save(state, expected) {
      const row = rows.get(state.id);
      if (expected === null ? !!row : row?.revision !== expected) return false;
      rows.set(state.id, structuredClone(state));
      return true;
    },
  };
  const events: DesignRunProgress[] = [];
  const executePass = vi.fn<DesignRunDriverOptions['executePass']>(
    async () => ({
      output: { valid: true },
      metadata: {
        profile: 'design' as const,
        engine: 'claude-code' as const,
        model: 'strongest',
        effort: 'max' as const,
        durationMs: 1,
        tokens: 10,
        toolCalls: 1,
      },
    }),
  );
  const options: DesignRunDriverOptions = {
    store,
    definition: 'workbook:v1',
    passes: ['Profile', 'Propose', 'Revise'].map((name) => ({
      name,
      schema: { type: 'object' },
    })),
    // Host validator injection is mandatory; integration hosts supply full Ajv.
    validate: (_schema, value) =>
      (value as { valid?: boolean })?.valid ? [] : ['valid required'],
    executePass,
    readResource: async () => ({ data: 'summary' }),
    onProgress: (event) => {
      events.push(event);
    },
    now: () => 1000,
  };
  const input = {
    id: 'run',
    ownerId: 'owner',
    resourceIds: ['workbook'],
    budget: {
      maxTokens: 1000,
      maxDurationMs: 10000,
      maxCallTokens: 100,
      callTimeoutMs: 1000,
      repairRetries: 1,
      toolResultChars: 1000,
    },
  };
  return { rows, store, events, executePass, options, input };
}

describe('durable design run driver', () => {
  it('runs three ordered schema-checked passes with mechanical checks between calls', async () => {
    const f = fixture();
    const order: string[] = [];
    f.options.passes = f.options.passes.map((pass) => ({
      ...pass,
      check: async (_output, state) => {
        order.push(`check:${pass.name}`);
        return { input: `facts:${state.passIndex}` };
      },
    }));
    f.executePass.mockImplementation(async (...args) => {
      const request = args[0] as unknown as { pass: { name: string } };
      order.push(request.pass.name);
      return {
        output: { valid: true },
        metadata: {
          profile: 'design',
          engine: 'claude-code',
          model: 'strongest',
          effort: 'max',
          durationMs: 1,
          tokens: 10,
          toolCalls: 1,
        },
      };
    });
    const driver = createDesignRunDriver(f.options);
    await driver.start(f.input);
    const state = await driver.run('run', 'owner');
    expect(state.status).toBe('done');
    expect(state.tokens).toBe(30);
    expect(order).toEqual([
      'Profile',
      'check:Profile',
      'Propose',
      'check:Propose',
      'Revise',
      'check:Revise',
    ]);
    expect(
      f.events.some(
        (event) => event.status === 'checking' && event.pass.index === 2,
      ),
    ).toBe(true);
    expect(f.events.at(-1)).toEqual({
      runId: 'run',
      pass: { index: 3, count: 3, name: 'Revise' },
      status: 'done',
    });
  });

  it('repairs invalid CLI output and bounds automatic repair attempts', async () => {
    const f = fixture();
    f.executePass.mockResolvedValueOnce({
      output: { valid: false },
      metadata: {
        profile: 'design',
        engine: 'claude-code',
        effort: 'max',
        model: 'strongest',
        durationMs: 1,
        tokens: 10,
        toolCalls: 1,
      },
    });
    const driver = createDesignRunDriver(f.options);
    await driver.start(f.input);
    expect((await driver.run('run', 'owner')).status).toBe('done');
    expect(f.executePass.mock.calls[1]?.[0]).toMatchObject({
      repair: { output: { valid: false }, errors: ['valid required'] },
    });
    const bad = fixture();
    bad.options.validate = () => ['schema invalid'];
    const failed = createDesignRunDriver(bad.options);
    await failed.start(bad.input);
    expect((await failed.run('run', 'owner')).status).toBe('failed');
    expect(bad.executePass).toHaveBeenCalledTimes(2);
  });

  it('persists cumulative exhaustion and resumes in a fresh driver without repeating accepted passes', async () => {
    const f = fixture();
    f.input.budget.maxTokens = 10;
    const driver = createDesignRunDriver(f.options);
    await driver.start(f.input);
    const paused = await driver.run('run', 'owner');
    expect(paused).toMatchObject({
      status: 'stopped',
      tokens: 10,
      passIndex: 0,
      phase: 'check',
    });
    const restarted = createDesignRunDriver(f.options);
    await restarted.resume('run', 'owner', { maxTokens: 50 });
    const completed = await restarted.run('run', 'owner');
    expect(completed).toMatchObject({ status: 'done', tokens: 30 });
    expect(f.executePass).toHaveBeenCalledTimes(3);
    await expect(restarted.status('run', 'stranger')).rejects.toThrow(
      'not found',
    );
  });

  it('rejects stale completion after Stop and prevents concurrent resume while a pass holds its lease', async () => {
    const f = fixture();
    let release!: (value: Awaited<ReturnType<typeof f.executePass>>) => void;
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    f.executePass.mockImplementationOnce(() => {
      began();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const driver = createDesignRunDriver(f.options);
    await driver.start(f.input);
    const active = driver.run('run', 'owner');
    await started;
    await expect(driver.run('run', 'owner')).rejects.toBeInstanceOf(
      DesignRunConflictError,
    );
    await driver.stop('run', 'owner');
    await expect(driver.resume('run', 'owner')).rejects.toBeInstanceOf(
      DesignRunConflictError,
    );
    release({
      output: { valid: true },
      metadata: {
        profile: 'design',
        engine: 'claude-code',
        effort: 'max',
        model: 'strongest',
        durationMs: 1,
        tokens: 10,
        toolCalls: 1,
      },
    });
    await expect(active).rejects.toBeInstanceOf(DesignRunConflictError);
    expect(await driver.status('run', 'owner')).toMatchObject({
      status: 'stopped',
      outputs: [],
      tokens: 100,
    });
  });

  it('keeps crash reservations on recovery and enforces owner resource ids and page limits', async () => {
    const f = fixture();
    const driver = createDesignRunDriver(f.options);
    await driver.start(f.input);
    const state = f.rows.get('run');
    if (!state) throw new Error('Missing test run');
    state.tokens = 100;
    state.durationMs = 1000;
    state.leaseUntil = 999;
    f.executePass.mockImplementation(async (...args) => {
      const request = args[0] as unknown as Parameters<
        DesignRunDriverOptions['executePass']
      >[0];
      await expect(request.readResource('other')).rejects.toThrow('not found');
      expect(await request.readResource('workbook')).toEqual({
        data: 'summary',
      });
      return {
        output: { valid: true },
        metadata: {
          profile: 'design',
          engine: 'claude-code',
          effort: 'max',
          model: 'strongest',
          durationMs: 1,
          tokens: 10,
          toolCalls: 1,
        },
      };
    });
    const result = await createDesignRunDriver(f.options).run('run', 'owner');
    expect(result.tokens).toBe(130);
    expect(result.durationMs).toBe(1000);
  });
  it('repeats revision passes only within the host limit', async () => {
    const f = fixture();
    let checks = 0;
    f.options.passes = [
      {
        name: 'Revise',
        schema: {},
        maxRepeats: 1,
        check: async () => ({
          repeat: ++checks < 2,
          input: 'mechanical discrepancies',
        }),
      },
    ];
    const driver = createDesignRunDriver(f.options);
    await driver.start(f.input);
    expect((await driver.run('run', 'owner')).status).toBe('done');
    expect(f.executePass).toHaveBeenCalledTimes(2);
    expect(f.executePass.mock.calls[1]?.[0].input).toBe(
      'mechanical discrepancies',
    );
  });

  it('pauses timed-out mechanical checks and preserves their phase for resume', async () => {
    const f = fixture();
    f.input.budget.callTimeoutMs = 5;
    f.options.passes = [
      {
        name: 'Check data',
        schema: {},
        check: async () => new Promise(() => {}),
      },
    ];
    const driver = createDesignRunDriver(f.options);
    await driver.start(f.input);
    expect(await driver.run('run', 'owner')).toMatchObject({
      status: 'stopped',
      phase: 'check',
      tokens: 10,
      durationMs: 5,
    });
    expect((await driver.status('run', 'owner')).note).toContain('time budget');
  });

  it('pauses wall-budget exhaustion and oversized pages cannot enter model context', async () => {
    const f = fixture();
    f.options.now = (() => {
      let time = 0;
      return () => (time += 2);
    })();
    f.input.budget.maxDurationMs = 1;
    f.options.readResource = async () => ({ data: 'x'.repeat(2000) });
    f.executePass.mockImplementation(async (request) => {
      await expect(request.readResource('workbook')).rejects.toThrow(
        'result budget',
      );
      return {
        output: { valid: true },
        metadata: {
          profile: 'design',
          engine: 'claude-code',
          effort: 'max',
          durationMs: 2,
          tokens: 10,
          toolCalls: 1,
        },
      };
    });
    const driver = createDesignRunDriver(f.options);
    await driver.start(f.input);
    expect(await driver.run('run', 'owner')).toMatchObject({
      status: 'stopped',
      phase: 'check',
    });
    expect(f.executePass).toHaveBeenCalledTimes(1);
  });
  it('recovers a future crashed-pass lease only with replacement job ownership proof', async () => {
    const f = fixture();
    const original = createDesignRunDriver(f.options);
    await original.start(f.input);
    const checkpoint = f.rows.get('run');
    if (!checkpoint) throw new Error('Missing test run');
    // Simulates a persisted pre-call checkpoint, not an actual process death.
    // The replacement host supplies proof from the recovered TaskRunner claim.
    checkpoint.tokens = 100;
    checkpoint.durationMs = 1000;
    checkpoint.revision = 1;
    checkpoint.leaseRevision = 1;
    checkpoint.leaseUntil = 1000 + 30 * 60 * 1000;
    const unowned = createDesignRunDriver({
      ...f.options,
      ownsExecution: async () => false,
    });
    await expect(unowned.run('run', 'owner')).rejects.toBeInstanceOf(
      DesignRunConflictError,
    );
    expect(f.executePass).not.toHaveBeenCalled();
    expect(await unowned.status('run', 'owner')).toMatchObject({
      tokens: 100,
      durationMs: 1000,
      leaseUntil: 1801000,
    });
    const replacement = createDesignRunDriver({
      ...f.options,
      ownsExecution: async () => true,
    });
    const result = await replacement.run('run', 'owner');
    expect(result).toMatchObject({
      status: 'done',
      tokens: 130,
      durationMs: 1000,
    });
    expect(f.executePass).toHaveBeenCalledTimes(3);
  });
  it('releases a cooperative stopped pass immediately after its original promise settles', async () => {
    const f = fixture();
    f.input.budget.callTimeoutMs = 30 * 60 * 1000;
    f.input.budget.maxDurationMs = 60 * 60 * 1000;
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    f.executePass.mockImplementationOnce(
      (request) =>
        new Promise((_resolve, reject) => {
          began();
          request.signal.addEventListener(
            'abort',
            () => reject(request.signal.reason),
            { once: true },
          );
        }),
    );
    const driver = createDesignRunDriver(f.options);
    await driver.start(f.input);
    const controller = new AbortController();
    const active = driver.run('run', 'owner', controller.signal);
    await started;
    await driver.stop('run', 'owner');
    controller.abort();
    await expect(active).rejects.toBeInstanceOf(DesignRunConflictError);
    expect((await driver.status('run', 'owner')).leaseUntil).toBeUndefined();
    await driver.resume('run', 'owner');
    expect((await driver.run('run', 'owner')).status).toBe('done');
  });

  it('retains an unsettled stopped pass lease until true engine settlement', async () => {
    const f = fixture();
    let clock = 1000;
    f.options.now = () => clock;
    let began!: () => void;
    let settle!: (
      result: Awaited<ReturnType<DesignRunDriverOptions['executePass']>>,
    ) => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    f.executePass.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          began();
          settle = resolve;
        }),
    );
    const release = vi.spyOn(f.store, 'releaseLease');
    const driver = createDesignRunDriver(f.options);
    await driver.start(f.input);
    const controller = new AbortController();
    const active = driver.run('run', 'owner', controller.signal);
    await started;
    await driver.stop('run', 'owner');
    controller.abort();
    await expect(active).rejects.toBeInstanceOf(DesignRunConflictError);
    expect(release).not.toHaveBeenCalled();
    clock = 5000; // Even an expired timer cannot prove the engine promise settled.
    await expect(driver.resume('run', 'owner')).rejects.toBeInstanceOf(
      DesignRunConflictError,
    );
    settle({
      output: { valid: true },
      metadata: {
        profile: 'design',
        engine: 'claude-code',
        effort: 'max',
        durationMs: 1,
        tokens: 1,
        toolCalls: 0,
      },
    });
    await Promise.resolve();
    expect(release).toHaveBeenCalledTimes(1);
    await driver.resume('run', 'owner');
  });
});

describe('approval-gated check checkpoints', () => {
  it.each([
    1, 2,
  ])('rechecks pass %i after owner approval without repeating its model output', async (passCount) => {
    const f = fixture();
    let approved = false;
    let mutations = 0;
    const applied = new Set<string>();
    const check = vi.fn(
      async (_output: unknown, state: Readonly<DesignRunState>) => {
        if (!approved)
          return {
            waitingApproval: true,
            note: 'Owner approval required',
            input: { approvalId: 'owner-hold' },
          };
        if (!applied.has(state.id)) {
          applied.add(state.id);
          mutations++;
        }
        return {};
      },
    );
    f.options.passes = Array.from({ length: passCount }, (_, index) => ({
      name: `Pass ${index}`,
      schema: {},
      ...(index === 0 ? { check } : {}),
    }));
    // Include a repaired output so waiting clears all prior repair state.
    f.executePass.mockResolvedValueOnce({
      output: { valid: false },
      metadata: {
        profile: 'design',
        engine: 'claude-code',
        effort: 'max',
        model: 'strongest',
        durationMs: 1,
        tokens: 7,
        toolCalls: 0,
      },
    });
    const driver = createDesignRunDriver(f.options);
    await driver.start(f.input);
    const paused = await driver.run('run', 'owner');
    expect(paused).toMatchObject({
      status: 'waiting-approval',
      phase: 'check',
      passIndex: 0,
      tokens: 17,
      repair: 0,
      input: { approvalId: 'owner-hold' },
      outputs: [{ valid: true }],
    });
    expect(paused.leaseRevision).toBeUndefined();
    expect(paused.leaseUntil).toBeUndefined();
    expect(paused.invalidOutput).toBeUndefined();
    expect(paused.validationErrors).toBeUndefined();
    const attempts = structuredClone(paused.attempts);
    const resumed = createDesignRunDriver(f.options);
    await resumed.resume('run', 'owner');
    expect((await resumed.run('run', 'owner')).status).toBe('waiting-approval');
    expect(f.executePass).toHaveBeenCalledTimes(2);
    expect((await resumed.status('run', 'owner')).attempts).toEqual(attempts);
    approved = true;
    await resumed.resume('run', 'owner');
    const done = await resumed.run('run', 'owner');
    expect(done.status).toBe('done');
    expect(done.tokens).toBe(17 + (passCount - 1) * 10);
    expect(f.executePass).toHaveBeenCalledTimes(passCount + 1);
    expect(mutations).toBe(1);
    await resumed.run('run', 'owner');
    expect(mutations).toBe(1);
  });

  it('replays an applied check after a lost completion checkpoint under replacement execution ownership', async () => {
    const f = fixture();
    const effects = new Map<string, unknown>();
    let mutations = 0;
    const check = vi.fn(
      async (output: unknown, state: Readonly<DesignRunState>) => {
        if (!effects.has(state.id)) {
          effects.set(state.id, structuredClone(output));
          mutations++;
        }
        expect(effects.get(state.id)).toEqual(output);
        return {};
      },
    );
    f.options.passes = [{ name: 'Apply final output', schema: {}, check }];
    const save = f.store.save.bind(f.store);
    let rejectCompletion = true;
    f.store.save = async (state, expected) => {
      // The last durable record is checking with its live lease. The effect is
      // durable, but this worker loses ownership before completing the CAS.
      if (rejectCompletion && state.passIndex === 1) return false;
      return save(state, expected);
    };
    const original = createDesignRunDriver(f.options);
    await original.start(f.input);
    await expect(original.run('run', 'owner')).rejects.toBeInstanceOf(
      DesignRunConflictError,
    );
    const persisted = await original.status('run', 'owner');
    expect(persisted).toMatchObject({
      status: 'checking',
      phase: 'check',
      passIndex: 0,
      tokens: 10,
      outputs: [{ valid: true }],
    });
    expect(persisted.leaseRevision).toBeDefined();
    expect(mutations).toBe(1);
    const attempts = structuredClone(persisted.attempts);
    const unowned = createDesignRunDriver({
      ...f.options,
      ownsExecution: async () => false,
    });
    await expect(unowned.run('run', 'owner')).rejects.toBeInstanceOf(
      DesignRunConflictError,
    );
    expect(check).toHaveBeenCalledTimes(1);
    rejectCompletion = false;
    // Integration hosts replace this fixture proof with the live TaskRunner
    // claim. No elapsed-time inference or frontend lease clearing is involved.
    const replacement = createDesignRunDriver({
      ...f.options,
      ownsExecution: async () => true,
    });
    expect(await replacement.run('run', 'owner')).toMatchObject({
      status: 'done',
      tokens: 10,
      attempts,
      outputs: [{ valid: true }],
    });
    expect(check).toHaveBeenCalledTimes(2);
    expect(f.executePass).toHaveBeenCalledOnce();
    expect(mutations).toBe(1);
  });

  it('ends a denied approval check without replaying the validated model output', async () => {
    const f = fixture();
    let denied = false;
    f.options.passes = [
      {
        name: 'Apply',
        schema: {},
        check: async () => {
          if (denied) throw new Error('Owner denied');
          return { waitingApproval: true };
        },
      },
    ];
    const driver = createDesignRunDriver(f.options);
    await driver.start(f.input);
    expect((await driver.run('run', 'owner')).status).toBe('waiting-approval');
    denied = true;
    await driver.resume('run', 'owner');
    const failed = await driver.run('run', 'owner');
    expect(failed).toMatchObject({
      status: 'failed',
      phase: 'check',
      passIndex: 0,
      tokens: 10,
      outputs: [{ valid: true }],
    });
    expect(f.executePass).toHaveBeenCalledOnce();
    await expect(driver.resume('run', 'owner')).rejects.toThrow('has ended');
    expect((await driver.run('run', 'owner')).status).toBe('failed');
    expect(f.executePass).toHaveBeenCalledOnce();
  });
});

describe('trusted host early completion', () => {
  it.each([
    0, 1,
  ])('completes at actual pass %i and stays terminal without invented work', async (index) => {
    const f = fixture();
    f.options.passes = f.options.passes.map((pass, current) => ({
      ...pass,
      check: async () => ({
        complete: current === index,
        input: { checked: current },
      }),
    }));
    const driver = createDesignRunDriver(f.options);
    await driver.start(f.input);
    const done = await driver.run('run', 'owner');
    expect(done).toMatchObject({
      status: 'done',
      passIndex: index,
      phase: 'check',
      tokens: (index + 1) * 10,
      input: { checked: index },
    });
    expect(done.outputs).toHaveLength(index + 1);
    expect(done.attempts).toHaveLength(index + 1);
    expect(done.leaseRevision).toBeUndefined();
    expect(done.leaseUntil).toBeUndefined();
    expect(await driver.run('run', 'owner')).toEqual(done);
    expect(await driver.stop('run', 'owner')).toEqual(done);
    expect(await driver.status('run', 'owner')).toEqual(done);
    await expect(driver.resume('run', 'owner')).rejects.toThrow('has ended');
    expect(f.executePass).toHaveBeenCalledTimes(index + 1);
    expect(f.events.at(-1)).toMatchObject({
      status: 'done',
      pass: { index: index + 1, count: 3 },
    });
  });

  it('ignores a completion field returned by the model', async () => {
    const f = fixture();
    const result = await f.executePass({} as never);
    f.executePass.mockClear();
    f.executePass.mockResolvedValue({
      ...result,
      output: { valid: true, complete: true },
    });
    const driver = createDesignRunDriver(f.options);
    await driver.start(f.input);
    expect((await driver.run('run', 'owner')).passIndex).toBe(3);
    expect(f.executePass).toHaveBeenCalledTimes(3);
  });

  it('holds the first proposal then completes its same check without another provider call', async () => {
    const f = fixture();
    let approved = false;
    f.options.passes = f.options.passes.map((pass) => ({
      ...pass,
      check: async () => ({
        complete: true,
        waitingApproval: !approved,
        input: { approval: 'same-hold' },
      }),
    }));
    const driver = createDesignRunDriver(f.options);
    await driver.start(f.input);
    const held = await driver.run('run', 'owner');
    expect(held).toMatchObject({
      status: 'waiting-approval',
      passIndex: 0,
      phase: 'check',
    });
    approved = true;
    const fresh = createDesignRunDriver(f.options);
    await fresh.resume('run', 'owner');
    const done = await fresh.run('run', 'owner');
    expect(done).toMatchObject({
      status: 'done',
      passIndex: 0,
      phase: 'check',
      tokens: held.tokens,
      attempts: held.attempts,
      outputs: held.outputs,
      input: held.input,
    });
    expect(f.executePass).toHaveBeenCalledOnce();
  });

  it('honors repeat before completion and never lets completion override failure', async () => {
    const f = fixture();
    let checks = 0;
    f.options.passes = [
      {
        name: 'Propose',
        schema: {},
        maxRepeats: 1,
        check: async () => ({
          complete: true,
          repeat: ++checks === 1,
          ...(checks === 2 ? { failure: 'The change is unavailable.' } : {}),
        }),
      },
    ];
    const driver = createDesignRunDriver(f.options);
    await driver.start(f.input);
    expect(await driver.run('run', 'owner')).toMatchObject({
      status: 'failed',
      note: 'The change is unavailable.',
      passIndex: 0,
    });
    expect(f.executePass).toHaveBeenCalledTimes(2);
  });

  it('recovers the same action after an early completion CAS is lost, requiring replacement ownership', async () => {
    const f = fixture();
    let approved = false;
    const effects = new Set<string>();
    const keys: string[] = [];
    const check = vi.fn(
      async (_output: unknown, state: Readonly<DesignRunState>) => {
        if (!approved) return { waitingApproval: true, complete: true };
        const key = `${state.id}:${state.passIndex}:0`;
        keys.push(key);
        effects.add(key);
        return { complete: true };
      },
    );
    f.options.passes = f.options.passes.map((pass) => ({ ...pass, check }));
    const save = f.store.save.bind(f.store);
    let loseCompletion = true;
    f.store.save = (state, expected) =>
      loseCompletion && state.status === 'done'
        ? Promise.resolve(false)
        : save(state, expected);
    const driver = createDesignRunDriver(f.options);
    await driver.start(f.input);
    expect(await driver.run('run', 'owner')).toMatchObject({
      status: 'waiting-approval',
      phase: 'check',
      passIndex: 0,
    });
    approved = true;
    await driver.resume('run', 'owner');
    await expect(driver.run('run', 'owner')).rejects.toBeInstanceOf(
      DesignRunConflictError,
    );
    const checkpoint = await driver.status('run', 'owner');
    expect(checkpoint).toMatchObject({
      status: 'checking',
      phase: 'check',
      passIndex: 0,
    });
    await expect(
      createDesignRunDriver(f.options).run('run', 'owner'),
    ).rejects.toBeInstanceOf(DesignRunConflictError);
    loseCompletion = false;
    const replacement = createDesignRunDriver({
      ...f.options,
      ownsExecution: async () => true,
    });
    expect(await replacement.run('run', 'owner')).toMatchObject({
      status: 'done',
      passIndex: 0,
      tokens: checkpoint.tokens,
      attempts: checkpoint.attempts,
      outputs: checkpoint.outputs,
    });
    expect(keys).toEqual(['run:0:0', 'run:0:0']);
    expect(effects.size).toBe(1);
    expect(f.executePass).toHaveBeenCalledOnce();
  });

  it('cannot overwrite Stop with an early completion from a stale check', async () => {
    const f = fixture();
    let finish!: () => void;
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    f.options.passes = [
      {
        name: 'Propose',
        schema: {},
        check: async () => {
          began();
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          return { complete: true };
        },
      },
    ];
    const driver = createDesignRunDriver(f.options);
    await driver.start(f.input);
    const running = driver.run('run', 'owner');
    await started;
    await driver.stop('run', 'owner');
    finish();
    await expect(running).rejects.toBeInstanceOf(DesignRunConflictError);
    expect(await driver.status('run', 'owner')).toMatchObject({
      status: 'stopped',
      phase: 'check',
      passIndex: 0,
    });
    expect(f.executePass).toHaveBeenCalledOnce();
  });
});

describe('trusted host check failures', () => {
  it('fails terminally with the host explanation while retaining the accepted checkpoint', async () => {
    const f = fixture();
    const check = vi.fn(async () => ({
      failure: 'The final proposal is not ready. Start a new design run.',
      input: { ready: false },
      // A definitive failure must take precedence over a conflicting hold/repeat.
      waitingApproval: true,
      repeat: true,
    }));
    f.options.passes = [{ name: 'Final readiness', schema: {}, check }];
    const driver = createDesignRunDriver(f.options);
    await driver.start(f.input);
    const failed = await driver.run('run', 'owner');
    expect(failed).toMatchObject({
      status: 'failed',
      note: 'The final proposal is not ready. Start a new design run.',
      phase: 'check',
      passIndex: 0,
      input: { ready: false },
      outputs: [{ valid: true }],
      tokens: 10,
      durationMs: 0,
      repair: 0,
    });
    expect(failed.attempts).toHaveLength(1);
    expect(failed.leaseRevision).toBeUndefined();
    expect(failed.leaseUntil).toBeUndefined();
    expect(f.events.some((event) => event.status === 'waiting-approval')).toBe(
      false,
    );
    await expect(driver.resume('run', 'owner')).rejects.toThrow('has ended');
    const fresh = createDesignRunDriver(f.options);
    expect(await fresh.run('run', 'owner')).toEqual(failed);
    expect(check).toHaveBeenCalledOnce();
    expect(f.executePass).toHaveBeenCalledOnce();
  });

  it('continues to sanitize ordinary thrown check errors', async () => {
    const f = fixture();
    f.options.passes = [
      {
        name: 'Final',
        schema: {},
        check: async () => {
          throw new Error('private-provider-payload');
        },
      },
    ];
    const driver = createDesignRunDriver(f.options);
    await driver.start(f.input);
    const failed = await driver.run('run', 'owner');
    expect(failed.status).toBe('failed');
    expect(failed.note).toBe(
      'The design run failed. Review its inputs before starting again.',
    );
    expect(JSON.stringify(failed)).not.toContain('private-provider-payload');
  });
});
