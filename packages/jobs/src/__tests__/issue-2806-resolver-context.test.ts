/**
 * Class config resolvers see the resolving agent instance (#2806).
 *
 * Before #2806 a `static configResolvers` entry was a zero-argument callback
 * applied as an unconditional overlay: it could not tell which agent it was
 * resolving for, nor see that agent's own persisted value, so a "use the
 * agent's own credential, else a deployment default" resolver had no correct
 * implementation. An application-side workaround that scanned the tenant's
 * agent rows handed one agent another agent's provider credential when a
 * tenant ran several agents of one class (anytown.ai#1087).
 *
 * These run real object-bound jobs through the real TaskRunner: two agents of
 * one class in one tenant, each with its own persisted `_agentConfig`, plus a
 * third with none.
 */
import {
  type ConfigResolverContext,
  getTestDatabase,
  ObjectRegistry,
  preferPersisted,
  resetConfigResolvers,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { afterEach, describe, expect, it } from 'vitest';
import { createTaskRunner } from '../runner.js';
import { SmrtJobCollection } from '../smrt-job.js';

const DEPLOYMENT_DEFAULT = { provider: 'deployment', apiKey: 'shared-key' };

@smrt()
class Issue2806Agent extends SmrtObject {
  static contexts: ConfigResolverContext[] = [];
  static constructed = new Map<string, Record<string, unknown>>();

  static configResolvers = {
    // Per-agent provider credential with a deployment-wide fallback: must
    // never replace the agent's own persisted value. (Named `credential`
    // because `ai` is SmrtObject's own AI-client option.)
    credential: preferPersisted((context) => {
      Issue2806Agent.contexts.push(context);
      return DEPLOYMENT_DEFAULT;
    }),
    // Identity-derived value: proves the resolver knows *which* agent.
    region: (context: ConfigResolverContext) => {
      Issue2806Agent.contexts.push(context);
      return `region-for-${context.agentId}`;
    },
  };

  constructor(options: Record<string, unknown> = {}) {
    super(options as never);
    if (typeof options.id === 'string') {
      Issue2806Agent.constructed.set(options.id, { ...options });
    }
  }

  async ping(): Promise<string> {
    return 'pong';
  }
}

afterEach(() => {
  ObjectRegistry.configureCollectionCache(100);
  resetConfigResolvers();
  Issue2806Agent.contexts = [];
  Issue2806Agent.constructed.clear();
});

describe('TaskRunner resolver context (#2806)', () => {
  it('resolves each agent of one class on its own persisted value and identity', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const agent = new Issue2806Agent({ db });
      await agent.initialize();
      await agent.save();
      ids.push(agent.id as string);
    }
    const [agentA, agentB, agentC] = ids;

    const jobs = await SmrtJobCollection.create({ db });
    const agentConfigs: Record<string, Record<string, unknown>> = {
      [agentA]: {
        credential: { provider: 'anthropic', apiKey: 'agent-a-key' },
      },
      [agentB]: { credential: { provider: 'openai', apiKey: 'agent-b-key' } },
      [agentC]: {},
    };
    for (const id of ids) {
      await jobs.create({
        objectType: 'Issue2806Agent',
        objectId: id,
        method: 'ping',
        args: { _agentConfig: agentConfigs[id], _scheduleId: `schedule-${id}` },
      });
    }

    const runner = createTaskRunner({ concurrency: 1, pollInterval: 10 });
    await runner.initialize(db);
    let completed = 0;
    const done = new Promise<void>((resolve, reject) => {
      runner.on('job:completed', () => {
        completed += 1;
        if (completed === 3) resolve();
      });
      runner.once('job:failed', (_job, error) => reject(error));
    });
    await runner.start();
    try {
      await done;
    } finally {
      await runner.stop();
    }

    // Each agent keeps its own credential; only the agent without one gets
    // the deployment default. No agent ever receives another agent's key.
    expect(Issue2806Agent.constructed.get(agentA)?.credential).toEqual({
      provider: 'anthropic',
      apiKey: 'agent-a-key',
    });
    expect(Issue2806Agent.constructed.get(agentB)?.credential).toEqual({
      provider: 'openai',
      apiKey: 'agent-b-key',
    });
    expect(Issue2806Agent.constructed.get(agentC)?.credential).toEqual(
      DEPLOYMENT_DEFAULT,
    );
    for (const id of ids) {
      expect(Issue2806Agent.constructed.get(id)?.region).toBe(
        `region-for-${id}`,
      );
    }

    // The fallback ran only for the agent without its own value, and every
    // resolver call carried that job's identity.
    const aiCalls = Issue2806Agent.contexts.filter(
      (c) => c.key === 'credential',
    );
    expect(aiCalls.map((c) => c.agentId)).toEqual([agentC]);
    for (const context of Issue2806Agent.contexts) {
      expect(ids).toContain(context.agentId);
      expect(context.agentClass).toBe(
        ObjectRegistry.getClass('Issue2806Agent')?.qualifiedName,
      );
      expect(context.scheduleId).toBe(`schedule-${context.agentId}`);
      expect(typeof context.jobId).toBe('string');
    }
    const regionCalls = Issue2806Agent.contexts.filter(
      (c) => c.key === 'region',
    );
    expect(regionCalls.map((c) => c.agentId).sort()).toEqual([...ids].sort());
  });
});
