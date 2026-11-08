/**
 * Agents end a run `skipped` when AI is unavailable (#4757): `execute()`
 * catches `AI_UNAVAILABLE` at the lifecycle boundary, records the reason
 * and mode in the run record instead of `error`, and does not rethrow;
 * interests stop at the first unavailable handler instead of logging and
 * continuing per type.
 */
import {
  InferenceUnavailableError,
  setInferenceResolver,
  smrt,
} from '@happyvertical/smrt-core';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Agent } from '../agent.js';

@smrt()
class Issue4757SummaryAgent extends Agent {
  protected config = {};
  attempts = 0;

  async run(): Promise<void> {
    this.attempts += 1;
    // No `ai` anywhere: core throws AI_UNAVAILABLE (unconfigured).
    await this.do('summarize the week');
  }
}

@smrt()
class Issue4757InterestAgent extends Agent {
  protected config = {};

  async run(): Promise<void> {
    await this.interesting();
  }
}

describe('#4757 agents skip when AI is unavailable', () => {
  let db: unknown;
  const saved = process.env.SMRT_AI_PROVIDER;

  beforeAll(async () => {
    delete process.env.SMRT_AI_PROVIDER;
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
  });

  afterEach(() => {
    setInferenceResolver(undefined);
    if (saved === undefined) delete process.env.SMRT_AI_PROVIDER;
    else process.env.SMRT_AI_PROVIDER = saved;
  });

  it('ends an unconfigured run skipped with the reason, without throwing', async () => {
    const agent = new Issue4757SummaryAgent({ name: 'summary', db } as never);
    await expect(agent.execute()).resolves.toBeUndefined();
    expect(agent.status).toBe('skipped');
    expect(agent.runRecord).toMatchObject({
      status: 'skipped',
      reason: 'unconfigured',
      mode: 'off',
    });
    expect(agent.runRecord?.error).toBeUndefined();
    expect(agent.attempts).toBe(1);
  });

  it('records mode off from the resolver as reason off', async () => {
    setInferenceResolver({
      resolve: () => undefined,
      mode: () => ({ mode: 'off', unavailable: 'off' }),
    });
    const agent = new Issue4757SummaryAgent({
      name: 'summary-off',
      db,
      ai: { embed: () => {}, message: vi.fn() },
    } as never);
    await agent.execute();
    expect(agent.status).toBe('skipped');
    expect(agent.runRecord).toMatchObject({ status: 'skipped', reason: 'off' });
  });

  it('a tenant mode off still initializes, then the run is skipped', async () => {
    setInferenceResolver({
      resolve: (request) => ({
        tierResolved: request.tier === 'auto' ? 'good' : request.tier,
        target: {},
        via: 'resolver',
        mode: 'off',
        unavailable: 'off',
      }),
    });
    const agent = new Issue4757SummaryAgent({
      name: 'tenant-off',
      db,
      ai: { provider: 'ollama', model: 'llama-test' },
    } as never);
    // Hydration and admin listings initialize agents: that must not throw.
    await expect(agent.initialize()).resolves.toBeDefined();
    await agent.execute();
    expect(agent.status).toBe('skipped');
    expect(agent.runRecord).toMatchObject({ status: 'skipped', reason: 'off' });
    expect(agent.attempts).toBe(0);
  });

  it("an agent ignores the invoking user's mode and uses the tenant's", async () => {
    setInferenceResolver({
      resolve: () => undefined,
      // The ambient user turned AI off; the tenant did not.
      mode: (request) =>
        request.userId === null
          ? undefined
          : { mode: 'off', unavailable: 'off' },
    });
    const message = vi.fn(async () => 'summary');
    const agent = new Issue4757SummaryAgent({
      name: 'tenant-scope',
      db,
      ai: { embed: () => {}, message },
    } as never);
    await agent.execute();
    expect(agent.status).toBe('idle');
    expect(agent.runRecord?.status).toBe('completed');
    expect(message).toHaveBeenCalledTimes(1);
  });

  it('still records and rethrows other errors as error', async () => {
    const agent = new Issue4757SummaryAgent({ name: 'broken', db } as never);
    agent.run = async () => {
      throw new Error('boom');
    };
    await expect(agent.execute()).rejects.toThrow('boom');
    expect(agent.status).toBe('error');
    expect(agent.runRecord).toMatchObject({ status: 'error', error: 'boom' });
  });

  it('interests stop at an unavailable handler instead of continuing per type', async () => {
    const agent = new Issue4757InterestAgent({
      name: 'interests',
      db,
      interests: { objects: { A: { filter: {} }, B: { filter: {} } } },
    } as never);
    const query = vi.fn(async () => {
      throw new InferenceUnavailableError({ reason: 'off' });
    });
    (
      agent as unknown as { queryInterestingObjects: typeof query }
    ).queryInterestingObjects = query;
    await agent.execute();
    expect(query).toHaveBeenCalledTimes(1);
    expect(agent.status).toBe('skipped');
    expect(agent.runRecord?.reason).toBe('off');
  });

  it('the typed error is not retryable for the jobs runner', () => {
    expect(new InferenceUnavailableError({ reason: 'off' }).retryable).toBe(
      false,
    );
  });
});
