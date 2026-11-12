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
