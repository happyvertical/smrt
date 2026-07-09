/**
 * End-to-end integration test for the opt-in Learning trait (#1886).
 *
 * Drives a full **learn → recall → adapt** cycle on a reference sample learning
 * agent across multiple runs, proving:
 *   - a first run generates a strategy and captures success (seeds confident memory);
 *   - a later run recalls and reuses it (no regeneration) and success strengthens it;
 *   - a failing run decays it below the reuse floor;
 *   - the next run stops reusing it and regenerates.
 *
 * Uses a real in-memory SQLite database (system tables bootstrapped by
 * `initialize()`). The sample's "AI" is an in-process counter standing in for
 * the real AI boundary, so nothing external is touched.
 *
 * (Named `*.test.ts` rather than `*.spec.ts` because the agents package's
 * vitest config only includes `src/**\/*.test.ts`.)
 */

import { smrt } from '@happyvertical/smrt-core';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent } from './agent.js';
import type { AgentLearningConfig } from './learning.js';

// -----------------------------------------------------------------------------
// Reference sample learning agent.
//
// This is the canonical shape of an agent that opts into learning: it recalls a
// confident cached strategy before acting, reuses it when present, generates a
// fresh one (its stand-in for an AI call) when not, and stages the episode so
// the lifecycle reinforces the outcome after `run()`. A validated failure is
// reported without throwing so a bad strategy decays and stops being reused —
// the generalisation of anytown `praeco`'s confidence-scored parser cache.
// -----------------------------------------------------------------------------
@smrt()
class LearningSampleAgent extends Agent {
  /** Single-declaration opt-in. Off by default on the base class. */
  static override learning: AgentLearningConfig = { enabled: true };

  protected config = {};

  /** The task this run should solve; also the memory key. */
  task = 'invoice';
  /** Test hook: whether the strategy used this run proved valid. */
  strategyValid = true;

  /** Number of "AI" strategy generations (should not advance when reusing). */
  aiCalls = 0;
  /** The strategy acted on this run. */
  lastStrategy: string | null = null;
  /** Whether the strategy was recalled from memory or freshly generated. */
  lastStrategySource: 'recalled' | 'generated' | null = null;

  /** Stand-in for a real AI call that synthesises a strategy for a task. */
  protected async generateStrategy(task: string): Promise<string> {
    this.aiCalls += 1;
    return `strategy:${task}:v${this.aiCalls}`;
  }

  override learningScope(): string {
    return `sample/${this.task}`;
  }

  async run(): Promise<void> {
    const key = this.task;

    // Recall-before-run has already populated `recalledMemories` (confidence
    // >= floor). Reuse a confident strategy; otherwise generate a new one.
    const recalled = this.recalledMemories.find((m) => m.key === key);
    let strategy: string;
    if (recalled) {
      strategy = String(recalled.value);
      this.lastStrategySource = 'recalled';
    } else {
      strategy = await this.generateStrategy(key);
      this.lastStrategySource = 'generated';
    }
    this.lastStrategy = strategy;

    // Stage the episode so the lifecycle reinforces it after run(). When the
    // strategy was freshly generated (e.g. after the previous one decayed),
    // `updateValue` replaces the stored value so a superseded/failed strategy
    // is not later recalled at rising confidence.
    this.stageLearning({
      scope: this.learningScope(),
      key,
      value: strategy,
      updateValue: this.lastStrategySource === 'generated',
    });

    // A validated failure decays the memory without throwing.
    if (!this.strategyValid) {
      this.reportLearningOutcome({ success: false, error: 'strategy invalid' });
    }
  }
}

async function readMemoryRow(
  db: Awaited<ReturnType<typeof getDatabase>>,
  ownerId: string,
  scope: string,
  key: string,
) {
  return db.get('_smrt_contexts', {
    owner_id: ownerId,
    scope,
    key,
    version: 1,
  });
}

async function countContexts(
  db: Awaited<ReturnType<typeof getDatabase>>,
): Promise<number> {
  const { rows } = await db.query('SELECT COUNT(*) AS n FROM _smrt_contexts');
  return Number(rows[0]?.n ?? 0);
}

describe('Learning trait — end-to-end learn → recall → adapt (#1886)', () => {
  let db: Awaited<ReturnType<typeof getDatabase>>;

  beforeEach(async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('generates on the first run and seeds a confident memory', async () => {
    const agent = new LearningSampleAgent({ name: 'learner', db });
    await agent.execute();

    expect(agent.lastStrategySource).toBe('generated');
    expect(agent.aiCalls).toBe(1);

    const row = await readMemoryRow(
      db,
      agent.id as string,
      'sample/invoice',
      'invoice',
    );
    expect(row).not.toBeNull();
    expect(Number(row?.confidence)).toBeCloseTo(0.9, 5);
    expect(Number(row?.success_count)).toBe(1);
    expect(Number(row?.failure_count)).toBe(0);
  });

  it('recalls and reuses a confident memory on the second run, strengthening it', async () => {
    const agent = new LearningSampleAgent({ name: 'learner', db });

    await agent.execute(); // run 1 — generate
    await agent.execute(); // run 2 — recall + reuse

    // Reused without a fresh generation.
    expect(agent.lastStrategySource).toBe('recalled');
    expect(agent.aiCalls).toBe(1);
    expect(agent.lastStrategy).toBe('strategy:invoice:v1');

    const row = await readMemoryRow(
      db,
      agent.id as string,
      'sample/invoice',
      'invoice',
    );
    // 0.9 -> 0.9 + 0.5*(1 - 0.9) = 0.95 (strengthened).
    expect(Number(row?.confidence)).toBeCloseTo(0.95, 5);
    expect(Number(row?.success_count)).toBe(2);
  });

  it('decays below the reuse floor on failure and stops reusing on the next run', async () => {
    const agent = new LearningSampleAgent({ name: 'learner', db });

    await agent.execute(); // run 1 — generate, success (0.9)
    await agent.execute(); // run 2 — reuse, success (0.95)

    // Run 3 — the strategy proves invalid.
    agent.strategyValid = false;
    await agent.execute();
    expect(agent.lastStrategySource).toBe('recalled'); // still reused this run

    const decayed = await readMemoryRow(
      db,
      agent.id as string,
      'sample/invoice',
      'invoice',
    );
    // 0.95 -> 0.95 + 0.5*(0.3 - 0.95) = 0.625 (< 0.7 floor).
    expect(Number(decayed?.confidence)).toBeCloseTo(0.625, 5);
    expect(Number(decayed?.failure_count)).toBe(1);
    expect(Number(decayed?.confidence)).toBeLessThan(0.7);

    // Run 4 — memory is below the floor, so recall omits it and the agent
    // regenerates rather than reusing a strategy that stopped working.
    agent.strategyValid = true;
    await agent.execute();
    expect(agent.lastStrategySource).toBe('generated');
    expect(agent.aiCalls).toBe(2);

    // The regenerated strategy supersedes the failed one in storage, so a
    // later run recalls the new strategy — never the one that stopped working.
    const regenerated = await readMemoryRow(
      db,
      agent.id as string,
      'sample/invoice',
      'invoice',
    );
    expect(JSON.parse(String(regenerated?.value))).toBe('strategy:invoice:v2');
    expect(Number(regenerated?.confidence)).toBeGreaterThanOrEqual(0.7);
  });

  it('isolates memory by owner — a distinct agent instance starts cold', async () => {
    const agentA = new LearningSampleAgent({ name: 'learner-a', db });
    const agentB = new LearningSampleAgent({ name: 'learner-b', db });

    await agentA.execute(); // A learns
    await agentB.execute(); // B has its own owner id → starts cold

    expect(agentA.id).not.toBe(agentB.id);
    expect(agentA.aiCalls).toBe(1);
    // B did not inherit A's learned strategy despite the same class + scope.
    expect(agentB.lastStrategySource).toBe('generated');

    // Two independent memory rows exist — one per owner.
    expect(await countContexts(db)).toBe(2);
    expect(
      await readMemoryRow(db, agentA.id as string, 'sample/invoice', 'invoice'),
    ).not.toBeNull();
    expect(
      await readMemoryRow(db, agentB.id as string, 'sample/invoice', 'invoice'),
    ).not.toBeNull();
  });
});
