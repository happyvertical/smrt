import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterAll, describe, expect, it } from 'vitest';
import { AiUsagePersistenceHandler } from '../adapters/ai-usage.js';
import { SmrtClass } from '../class.js';
import {
  type ExternalAgentUsageReceipt,
  ExternalAgentUsageRecorder,
  type ExternalAgentUsageReport,
  summarizeExternalAgentUsage,
} from '../external-agent-usage.js';
import { ensureSystemTables } from '../system/bootstrap.js';
import { externalAgentUsageSuite } from './external-agent-usage.cases.js';

const url = process.env.SMRT_TEST_POSTGRES_URL;
if (url) {
  const db = await getDatabase({ type: 'postgres', url });
  await ensureSystemTables(db);
  const fixtureTenantId = `external-agent-fixture-${crypto.randomUUID()}`;
  externalAgentUsageSuite('postgres', async () => db, fixtureTenantId);
  // Distinct dbids yield distinct pools: both callbacks own genuine PG transactions.
  const contender = await getDatabase({
    type: 'postgres',
    url,
    dbid: `external-agent-contender-${fixtureTenantId}`,
  } as Parameters<typeof getDatabase>[0]);
  it.each([
    'identical',
    'conflicting',
  ] as const)('arbitrates a %s nonzero retry after both receipt reads miss', async (mode) => {
    const binding = {
      tenantId: fixtureTenantId,
      workspaceId: 'workspace',
      projectId: 'project',
      taskId: 'task',
      sessionId: `interleaved-${mode}`,
      role: 'worker',
    };
    const report = (
      sequence: number,
      inputTokens: number,
    ): ExternalAgentUsageReport => ({
      version: 1,
      binding,
      provider: 'fixture',
      model: 'fixture',
      provenance: {
        harness: 'fixture',
        source: 'fixture.usage',
        eventId: `event-${sequence}`,
      },
      observedAt: '2026-10-26T00:00:00Z',
      sequence,
      epoch: 0,
      basis: 'cumulative',
      baseline: 'zero',
      scope: 'exclusive',
      inputIncludesCache: true,
      outputIncludesReasoning: true,
      counters: { inputTokens },
    });
    await new ExternalAgentUsageRecorder(db, binding).record(report(0, 10));
    let releaseLoser!: () => void;
    let signalMiss!: () => void;
    const loserRelease = new Promise<void>((resolve) => {
      releaseLoser = resolve;
    });
    const loserMiss = new Promise<void>((resolve) => {
      signalMiss = resolve;
    });
    const misses: string[] = [];
    let loserSawWinner = false;
    // Instrument scheduling only. Every get/query/transaction reaches its actual driver.
    const instrument = (
      connection: DatabaseInterface,
      name: string,
    ): DatabaseInterface =>
      new Proxy(connection, {
        get(target, property) {
          if (property === 'transaction')
            return async (
              callback: (tx: DatabaseInterface) => Promise<unknown>,
            ) => {
              if (!target.transaction)
                throw new Error('PostgreSQL fixture requires transactions');
              return target.transaction((tx) =>
                callback(
                  new Proxy(tx, {
                    get(executor, method) {
                      if (method === 'get')
                        return async (
                          ...args: Parameters<DatabaseInterface['get']>
                        ) => {
                          const actual = await executor.get(...args);
                          const selector = args[1] as Record<string, unknown>;
                          if (
                            args[0] === '_smrt_ai_usage' &&
                            String(selector.id).endsWith(':1') &&
                            actual == null
                          ) {
                            misses.push(name);
                            if (name === 'loser') {
                              signalMiss();
                              await loserRelease;
                            }
                          }
                          return actual;
                        };
                      if (method === 'query')
                        return async (
                          ...args: Parameters<DatabaseInterface['query']>
                        ) => {
                          const actual = await executor.query(...args);
                          if (
                            name === 'loser' &&
                            typeof args[0] === 'string' &&
                            args[0].startsWith(
                              'SELECT tags FROM _smrt_ai_usage',
                            )
                          ) {
                            loserSawWinner = actual.rows.some(
                              (row) =>
                                (
                                  JSON.parse(
                                    String(row.tags),
                                  ) as ExternalAgentUsageReceipt
                                ).report.sequence === 1,
                            );
                          }
                          return actual;
                        };
                      const value = Reflect.get(executor, method, executor);
                      return typeof value === 'function'
                        ? value.bind(executor)
                        : value;
                    },
                  }),
                ),
              );
            };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    const losingReport = report(1, mode === 'identical' ? 20 : 21);
    const loser = new ExternalAgentUsageRecorder(
      instrument(contender, 'loser'),
      binding,
    ).record(losingReport);
    // Attach rejection handling before the deliberate pause to avoid unhandled errors.
    const outcome = loser.then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    );
    let winner: ExternalAgentUsageReceipt | undefined;
    let winnerError: unknown;
    try {
      await Promise.race([
        loserMiss,
        outcome.then((result) => {
          throw (
            result.error ??
            new Error('Loser completed before paused receipt read')
          );
        }),
      ]);
      winner = await new ExternalAgentUsageRecorder(
        instrument(db, 'winner'),
        binding,
      ).record(report(1, 20));
      expect(misses).toEqual(['loser', 'winner']);
      expect(
        await new ExternalAgentUsageRecorder(db, binding).record(report(1, 20)),
      ).toEqual(winner);
    } catch (error) {
      winnerError = error;
    } finally {
      releaseLoser();
    }
    const result = await outcome;
    if (winnerError) throw winnerError;
    expect(winner).toBeDefined();
    expect(loserSawWinner).toBe(true);
    if (mode === 'identical') {
      expect(result.error).toBeNull();
      expect(result.value).toEqual(winner);
    } else {
      expect(result.error).toMatchObject({ code: 'conflict' });
      expect(String(result.error)).toContain('conflicting concurrent replay');
    }
    expect(
      (await new ExternalAgentUsageRecorder(db, binding).summarize()).reports,
    ).toBe(2);
  });
  it('keeps native custom-operation UUID accounting separate from genuine external recorder rows', async () => {
    class NativeOperationReader extends SmrtClass {
      async start() {
        await this.initialize();
      }
    }
    const reader = new NativeOperationReader({ db });
    await reader.start();
    try {
      for (const tags of [undefined, { component: 'ordinary-native' }]) {
        await new AiUsagePersistenceHandler(db).handle({
          provider: 'fixture',
          model: 'native',
          operation: 'external-agent',
          className: 'Native',
          tenantId: fixtureTenantId,
          timestamp: new Date('2026-10-26T00:00:00Z'),
          duration: 12,
          estimatedCost: 0.25,
          usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
          ...(tags ? { tags } : {}),
        });
      }
      const binding = {
        tenantId: fixtureTenantId,
        workspaceId: 'native-compat-workspace',
        projectId: 'native-compat-project',
        taskId: 'task',
        sessionId: 'mixed-native-external',
        role: 'worker',
      };
      await new ExternalAgentUsageRecorder(db, binding).record({
        version: 1,
        binding,
        provider: 'fixture',
        model: 'external',
        provenance: {
          harness: 'fixture',
          source: 'fixture.usage',
          eventId: 'mixed-0',
        },
        observedAt: '2026-10-26T00:00:00Z',
        sequence: 0,
        epoch: 0,
        basis: 'delta',
        baseline: 'zero',
        scope: 'exclusive',
        inputIncludesCache: true,
        outputIncludesReasoning: true,
        counters: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      });
      expect(
        await reader.listAiUsage({ tenantId: fixtureTenantId }),
      ).toHaveLength(2);
      const native = await reader.summarizeAiUsage({
        tenantId: fixtureTenantId,
        groupBy: 'operation',
      });
      expect(native['external-agent']).toMatchObject({
        callCount: 2,
        promptTokens: 14,
        completionTokens: 6,
        totalTokens: 20,
        estimatedCost: 0.5,
      });
      const external = await summarizeExternalAgentUsage(db, {
        tenantId: fixtureTenantId,
        workspaceId: binding.workspaceId,
        projectId: binding.projectId,
      });
      expect(external).toHaveLength(1);
      expect(external[0]).toMatchObject({
        reports: 1,
        counters: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      });
    } finally {
      reader.destroy();
    }
  });
  afterAll(async () => {
    await db.query(
      'DELETE FROM _smrt_ai_usage WHERE tenant_id = ?',
      fixtureTenantId,
    );
    await contender.close?.();
    await db.close?.();
  });
} else {
  describe.skip('external agent usage PostgreSQL (SMRT_TEST_POSTGRES_URL required)', () => {});
}
