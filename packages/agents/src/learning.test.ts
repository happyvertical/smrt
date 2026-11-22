/**
 * Unit tests for the opt-in Learning trait wiring (#1886):
 *   - `resolveAgentLearning` declaration normalisation;
 *   - off-by-default guarantee (a non-opted agent is unchanged);
 *   - recall-before / capture-after lifecycle seams.
 *
 * Real in-memory SQLite; nothing mocked.
 */

import { smrt } from '@happyvertical/smrt-core';
import { getCurrentTenant, withTenant } from '@happyvertical/smrt-tenancy';
import { getDatabase } from '@happyvertical/sql';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent } from './agent.js';
import { type AgentLearningConfig, resolveAgentLearning } from './learning.js';

async function countContexts(
  db: Awaited<ReturnType<typeof getDatabase>>,
): Promise<number> {
  const { rows } = await db.query('SELECT COUNT(*) AS n FROM _smrt_contexts');
  return Number(rows[0]?.n ?? 0);
}

// -----------------------------------------------------------------------------
// Test agents (top-level so the manifest scanner picks up field metadata).
// -----------------------------------------------------------------------------

/** Not opted in — must behave byte-for-byte as today. */
@smrt()
class NonLearningAgent extends Agent {
  protected config = {};
  ran = false;
  async run(): Promise<void> {
    this.ran = true;
  }
}

/** Opted in via a config object; stages an episode and snapshots recall. */
@smrt()
class WiringAgent extends Agent {
  static override learning: AgentLearningConfig = { enabled: true };
  protected config = {};

  fail = false;
  recalledCountAtRun = -1;

  async run(): Promise<void> {
    // recall-before-run must have populated recalledMemories by now.
    this.recalledCountAtRun = this.recalledMemories.length;
    this.stageLearning({
      scope: this.learningScope(),
      key: 'strategy',
      value: { plan: 'A' },
    });
    if (this.fail) {
      this.reportLearningOutcome({ success: false, error: 'bad' });
    }
  }
}

/** Gates `OverlapLearner.run()` per tenant so a test can interleave runs. */
const overlapGates = new Map<string, Promise<void>>();
const overlapSeen: Array<{ tenant: string | undefined; recalled: unknown[] }> =
  [];

/** Opted in; stages a tenant-specific episode, then waits on its gate. */
@smrt()
class OverlapLearner extends Agent {
  static override learning: AgentLearningConfig = { enabled: true };
  protected config = {};

  async run(): Promise<void> {
    const tenant = getCurrentTenant()?.tenantId;
    overlapSeen.push({
      tenant,
      recalled: this.recalledMemories.map((memory) => memory.value),
    });
    this.stageLearning({
      scope: this.learningScope(),
      key: 'strategy',
      value: { tenant },
    });
    await overlapGates.get(tenant ?? '');
  }
}

/** Opted in; its first run re-enters `run()` once, as a recursive retry would. */
@smrt()
class ReentrantLearner extends Agent {
  static override learning: AgentLearningConfig = { enabled: true };
  protected config = {};
  depth = 0;
  runs = 0;

  async run(): Promise<void> {
    this.runs += 1;
    this.stageLearning({
      scope: this.learningScope(),
      key: 'reentry',
      value: { runs: this.runs },
    });
    if (this.depth === 0) {
      this.depth += 1;
      try {
        await this.run();
      } finally {
        this.depth -= 1;
      }
    }
  }
}

/** Opted in; waits on a gate so a test can hold a run open. */
const slowGate: { open: Promise<void> } = { open: Promise.resolve() };
@smrt()
class SlowLearner extends Agent {
  static override learning: AgentLearningConfig = { enabled: true };
  static override learningRunWaitWarnMs = 20;
  protected config = {};
  started: string[] = [];

  async run(): Promise<void> {
    const label = String(getCurrentTenant()?.tenantId ?? 'none');
    this.started.push(label);
    if (label === 'first') await slowGate.open;
  }
}

/** Opted in; throws from run() to exercise the failure-capture path. */
@smrt()
class ThrowingLearner extends Agent {
  static override learning = true;
  protected config = {};

  async run(): Promise<void> {
    this.stageLearning({ scope: this.learningScope(), key: 'k', value: 'v' });
    throw new Error('run exploded');
  }
}

describe('resolveAgentLearning', () => {
  it('treats undefined and false as disabled', () => {
    expect(resolveAgentLearning(undefined)).toEqual({
      enabled: false,
      memoryConfig: {},
    });
    expect(resolveAgentLearning(false)).toEqual({
      enabled: false,
      memoryConfig: {},
    });
  });

  it('treats true as enabled with defaults', () => {
    expect(resolveAgentLearning(true)).toEqual({
      enabled: true,
      scope: undefined,
      memoryConfig: {},
    });
  });

  it('forwards only explicitly-set thresholds (never clobbers defaults with undefined)', () => {
    const resolved = resolveAgentLearning({
      scope: 'invoices',
      minConfidence: 0.8,
    });
    expect(resolved.enabled).toBe(true);
    expect(resolved.scope).toBe('invoices');
    expect(resolved.memoryConfig).toEqual({ minConfidence: 0.8 });
    // Unset keys are absent, not `undefined`.
    expect('successConfidence' in resolved.memoryConfig).toBe(false);
  });

  it('honours an explicit enabled:false in a config object', () => {
    expect(resolveAgentLearning({ enabled: false, scope: 'x' })).toEqual({
      enabled: false,
      scope: 'x',
      memoryConfig: {},
    });
  });
});

describe('Learning trait — off by default', () => {
  let db: Awaited<ReturnType<typeof getDatabase>>;

  beforeEach(async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
  });

  it('a non-opted agent has no learning memory, empty recall, and writes no rows', async () => {
    const agent = new NonLearningAgent({ name: 'plain', db });
    await agent.execute();

    expect(agent.ran).toBe(true);
    expect(agent.status).toBe('idle');
    expect(agent.getLearningMemory()).toBeNull();
    expect(await countContexts(db)).toBe(0);
  });

  it('getLearningMemory() is null before initialize when disabled (no db access)', () => {
    const agent = new NonLearningAgent({ name: 'plain-2' });
    expect(agent.getLearningMemory()).toBeNull();
  });
});

describe('Learning trait — lifecycle seams', () => {
  let db: Awaited<ReturnType<typeof getDatabase>>;

  beforeEach(async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
  });

  it('recalls before run() and captures a staged success after run()', async () => {
    const agent = new WiringAgent({ name: 'wiring', db });

    await agent.execute();
    // First run: nothing to recall yet.
    expect(agent.recalledCountAtRun).toBe(0);
    expect(agent.getLearningMemory()).not.toBeNull();

    const row = await db.get('_smrt_contexts', {
      owner_id: agent.id as string,
      key: 'strategy',
      version: 1,
    });
    expect(JSON.parse(String(row?.value))).toEqual({ plan: 'A' });
    expect(Number(row?.success_count)).toBe(1);

    // Second run: the staged strategy is now recalled before run().
    await agent.execute();
    expect(agent.recalledCountAtRun).toBe(1);
  });

  it('learns on the scheduled path — recall/capture fire when run() is called directly (not execute)', async () => {
    // ScheduleRunner → TaskRunner constructs the agent, calls initialize(), then
    // invokes its configured method (default 'run') DIRECTLY, bypassing
    // execute(). The learning loop must still fire on this path.
    const agent = new WiringAgent({ name: 'scheduled', db });
    await agent.initialize();
    await agent.run(); // direct invocation, no execute()

    // capture-after fired: the staged episode was persisted.
    const row = await db.get('_smrt_contexts', {
      owner_id: agent.id as string,
      key: 'strategy',
      version: 1,
    });
    expect(row).not.toBeNull();
    expect(Number(row?.success_count)).toBe(1);

    // recall-before fired on the next direct run: the prior memory is recalled.
    await agent.run();
    expect(agent.recalledCountAtRun).toBe(1);
  });

  it('captures a reported failure so the memory decays', async () => {
    const agent = new WiringAgent({ name: 'wiring-fail', db });
    agent.fail = true;

    await agent.execute();

    const row = await db.get('_smrt_contexts', {
      owner_id: agent.id as string,
      key: 'strategy',
      version: 1,
    });
    // Fresh insert on failure seeds at the failure confidence (0.3).
    expect(Number(row?.confidence)).toBeCloseTo(0.3, 5);
    expect(Number(row?.failure_count)).toBe(1);
  });

  it('captures failure when run() throws, then re-throws the original error', async () => {
    const agent = new ThrowingLearner({ name: 'thrower', db });

    await expect(agent.execute()).rejects.toThrow('run exploded');
    expect(agent.status).toBe('error');

    const row = await db.get('_smrt_contexts', {
      owner_id: agent.id as string,
      key: 'k',
      version: 1,
    });
    expect(row).not.toBeNull();
    expect(Number(row?.failure_count)).toBe(1);
    expect(Number(row?.confidence)).toBeCloseTo(0.3, 5);
  });

  it('keeps overlapping runs of one instance from exchanging episodes or recall', async () => {
    const tenantA = '0e1d2c3b-4a59-4687-9a6b-5c4d3e2f1a01';
    const tenantB = 'f1e2d3c4-b5a6-4978-8a7b-6c5d4e3f2b02';
    const agent = new OverlapLearner({ name: 'overlap', db });
    await agent.initialize();
    // Seed B's memory so a leaked recall would be visible in A's run.
    await withTenant({ tenantId: tenantB }, async () => {
      await agent
        .getLearningMemory()
        ?.capture(
          { scope: agent.learningScope(), key: 'strategy', value: 'b-seed' },
          { success: true },
        );
    });
    overlapSeen.length = 0;

    let openA: () => void = () => {};
    let openB: () => void = () => {};
    overlapGates.set(tenantA, new Promise<void>((r) => (openA = r)));
    overlapGates.set(tenantB, new Promise<void>((r) => (openB = r)));
    const runA = withTenant({ tenantId: tenantA }, () => agent.execute());
    const runB = withTenant({ tenantId: tenantB }, () => agent.execute());
    // Let both runs get as far as they can before either is released.
    await new Promise((r) => setTimeout(r, 50));
    openA();
    await new Promise((r) => setTimeout(r, 50));
    openB();
    await Promise.all([runA, runB]);

    const { rows } = await db.query(
      `SELECT tenant_id, value FROM _smrt_contexts WHERE owner_id = ?`,
      agent.id as string,
    );
    const byTenant = Object.fromEntries(
      rows.map((row: Record<string, unknown>) => [
        row.tenant_id,
        JSON.parse(String(row.value)),
      ]),
    );
    expect(byTenant[tenantA]).toEqual({ tenant: tenantA });
    expect(byTenant[tenantB]).toEqual({ tenant: tenantB });
    const seenA = overlapSeen.find((entry) => entry.tenant === tenantA);
    expect(seenA?.recalled).toEqual([]);
  });

  it('runs a re-entrant learning run inline instead of waiting on itself', async () => {
    const agent = new ReentrantLearner({ name: 'reentrant', db });
    const bounded = (work: Promise<void>) =>
      Promise.race([
        work,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('learning run deadlocked')), 3000),
        ),
      ]);

    await bounded(agent.execute());
    expect(agent.runs).toBe(2);
    // The outermost run captured once; a later run on the instance still starts.
    await bounded(agent.execute());
    expect(agent.runs).toBe(4);
    const { rows } = await db.query(
      `SELECT success_count FROM _smrt_contexts WHERE owner_id = ? AND key = 'reentry'`,
      agent.id as string,
    );
    expect(
      rows.map((row: Record<string, unknown>) => Number(row.success_count)),
    ).toEqual([2]);
  });

  it('starts a later run only after a slow run of the same instance, warning while it waits', async () => {
    const agent = new SlowLearner({ name: 'slow', db });
    await agent.initialize();
    const warn = vi.spyOn(
      (agent as unknown as { logger: { warn: (...args: unknown[]) => void } })
        .logger,
      'warn',
    );
    let open: () => void = () => {};
    slowGate.open = new Promise<void>((resolve) => {
      open = resolve;
    });

    const first = withTenant({ tenantId: 'first' }, () => agent.execute());
    const second = withTenant({ tenantId: 'second' }, () => agent.execute());
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(agent.started).toEqual(['first']);
    expect(
      warn.mock.calls.some((call) => /waiting more than/.test(String(call[0]))),
    ).toBe(true);

    open();
    await Promise.all([first, second]);
    expect(agent.started).toEqual(['first', 'second']);
  });

  it('files one instance’s memory under the tenant each run resolves', async () => {
    const tenantA = '5d3c2b1a-0f9e-4d8c-a7b6-c5d4e3f2a101';
    const tenantB = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c02';
    const agent = new WiringAgent({ name: 'two-tenants', db });

    await withTenant({ tenantId: tenantA }, () => agent.execute());
    await withTenant({ tenantId: tenantB }, async () => {
      await agent.execute();
      // B's first run recalls nothing from A's identical owner/scope/key.
      expect(agent.recalledCountAtRun).toBe(0);
    });

    const { rows } = await db.query(
      `SELECT tenant_id, success_count FROM _smrt_contexts
        WHERE owner_id = ? ORDER BY tenant_id`,
      agent.id as string,
    );
    expect(
      rows.map((row: Record<string, unknown>) => [
        row.tenant_id,
        Number(row.success_count),
      ]),
    ).toEqual(
      [
        [tenantA, 1],
        [tenantB, 1],
      ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    );
  });
});
