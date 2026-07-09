/**
 * Unit tests for the opt-in Learning trait wiring (#1886):
 *   - `resolveAgentLearning` declaration normalisation;
 *   - off-by-default guarantee (a non-opted agent is unchanged);
 *   - recall-before / capture-after lifecycle seams.
 *
 * Real in-memory SQLite; nothing mocked.
 */

import { smrt } from '@happyvertical/smrt-core';
import { getDatabase } from '@happyvertical/sql';
import { beforeEach, describe, expect, it } from 'vitest';
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
});
