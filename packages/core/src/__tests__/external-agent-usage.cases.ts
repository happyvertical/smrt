import type { DatabaseInterface } from '@happyvertical/sql';
import { beforeEach, describe, expect, it } from 'vitest';
import { AiUsagePersistenceHandler } from '../adapters/ai-usage.js';
import {
  ExternalAgentUsageRecorder,
  type ExternalAgentUsageReport,
  normalizeExternalAgentUsageReport,
  summarizeExternalAgentUsage,
} from '../external-agent-usage.js';
import { getTestDatabase } from '../testing/database.js';

export function externalAgentUsageSuite(
  type: 'sqlite' | 'duckdb' | 'postgres',
  database?: () => Promise<DatabaseInterface>,
  fixtureTenantId = `external-agent-fixture-${crypto.randomUUID()}`,
) {
  describe(`external agent usage ${type}`, () => {
    let db: DatabaseInterface;
    const binding = {
      tenantId: fixtureTenantId,
      workspaceId: 'workspace-a',
      projectId: 'project-a',
      taskId: 'task-a',
      sessionId: 'session-a',
      role: 'worker',
    };
    const fact = (
      overrides: Partial<ExternalAgentUsageReport> = {},
    ): ExternalAgentUsageReport => ({
      version: 1,
      binding,
      provider: 'fixture',
      model: 'fixture-model',
      provenance: {
        harness: 'fixture',
        source: 'fixture.usage',
        eventId: 'event-0',
      },
      observedAt: '2026-10-25T00:00:00.000Z',
      sequence: 0,
      epoch: 0,
      basis: 'cumulative',
      baseline: 'zero',
      scope: 'exclusive',
      inputIncludesCache: true,
      outputIncludesReasoning: true,
      counters: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        cacheReadTokens: 2,
        cacheWriteTokens: 0,
        reasoningTokens: 1,
      },
      ...overrides,
    });
    const next = (overrides: Partial<ExternalAgentUsageReport> = {}) =>
      fact({
        sequence: 1,
        provenance: {
          harness: 'fixture',
          source: 'fixture.usage',
          eventId: 'event-1',
        },
        counters: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
        ...overrides,
      });
    beforeEach(async () => {
      db = database
        ? await database()
        : await getTestDatabase({
            type: type as 'sqlite' | 'duckdb',
            classes: [],
          });
      if (database)
        await db.query(
          'DELETE FROM _smrt_ai_usage WHERE tenant_id = ?',
          fixtureTenantId,
        );
    });
    it('persists measured zero and unknown without cost, replays exactly and summarizes safely', async () => {
      const recorder = new ExternalAgentUsageRecorder(db, binding);
      const receipt = await recorder.record(
        fact({ counters: { inputTokens: 0 } }),
      );
      expect(
        await recorder.record(fact({ counters: { inputTokens: 0 } })),
      ).toEqual(receipt);
      expect(receipt.delta.inputTokens).toBe(0);
      expect(receipt.delta.totalTokens).toBeNull();
      const summary = await recorder.summarize();
      expect(summary.counters.inputTokens).toBe(0);
      expect(summary.complete).toBe(false);
      expect(summary.coverage.inputTokens).toEqual({
        knownReports: 1,
        unknownReports: 0,
      });
      expect(summary.coverage.totalTokens).toEqual({
        knownReports: 0,
        unknownReports: 1,
      });
      const row = await db.get('_smrt_ai_usage', { id: receipt.id });
      expect(row?.estimated_cost).toBeNull();
      expect(row?.total_tokens).toBeNull();
    });
    it('arbitrates concurrent same sequence and refuses conflicting reports', async () => {
      const recorder = new ExternalAgentUsageRecorder(db, binding);
      const receipts = await Promise.all([
        recorder.record(fact()),
        recorder.record(fact()),
      ]);
      expect(receipts[0]).toEqual(receipts[1]);
      await expect(
        recorder.record(fact({ counters: { inputTokens: 11 } })),
      ).rejects.toThrow('conflicting');
      const nonzero = await Promise.all([
        recorder.record(next()),
        recorder.record(next()),
      ]);
      expect(nonzero[0]).toEqual(nonzero[1]);
      await expect(recorder.record(next({ sequence: 2 }))).rejects.toThrow(
        'event already recorded',
      );
      expect((await recorder.summarize()).reports).toBe(2);
    });
    it('isolates recorder candidates and session summaries from native UUID rows sharing its class name', async () => {
      const recorder = new ExternalAgentUsageRecorder(db, binding);
      const first = await recorder.record(fact());
      const persisted = await db.get('_smrt_ai_usage', { id: first.id });
      await new AiUsagePersistenceHandler(db).handle({
        provider: 'fixture',
        model: 'native',
        operation: 'external-agent',
        className: String(persisted?.class_name),
        tenantId: binding.tenantId,
        timestamp: new Date('2026-10-25T00:00:00Z'),
        duration: 1,
        usage: { totalTokens: 100 },
        tags: { component: 'ordinary-native' },
      });
      expect((await recorder.summarize()).reports).toBe(1);
      await recorder.record(next());
      expect((await recorder.summarize()).reports).toBe(2);
      expect((await recorder.summarize()).counters.totalTokens).toBe(28);
    });
    it('denies untrusted ownership changes and persisted session rebinding', async () => {
      const recorder = new ExternalAgentUsageRecorder(db, binding);
      await recorder.record(fact());
      for (const key of [
        'tenantId',
        'workspaceId',
        'projectId',
        'taskId',
        'role',
        'sessionId',
      ] as const) {
        await expect(
          recorder.record(fact({ binding: { ...binding, [key]: 'other' } })),
        ).rejects.toThrow('binding');
      }
      const moved = { ...binding, projectId: 'other' };
      await expect(
        new ExternalAgentUsageRecorder(db, moved).record(
          next({ binding: moved }),
        ),
      ).rejects.toThrow('attribution');
      await expect(
        new ExternalAgentUsageRecorder(db, moved).summarize(),
      ).rejects.toThrow('binding');
      expect(
        (
          await new ExternalAgentUsageRecorder(db, {
            ...binding,
            tenantId: 'other',
          }).summarize()
        ).reports,
      ).toBe(0);
    });
    it('derives cumulative deltas, explicit resets and unknown baselines', async () => {
      const recorder = new ExternalAgentUsageRecorder(db, binding);
      await recorder.record(fact());
      expect((await recorder.record(next())).delta.inputTokens).toBe(10);
      const reset = next({
        sequence: 2,
        epoch: 1,
        provenance: {
          harness: 'fixture',
          source: 'fixture.usage',
          eventId: 'event-2',
        },
        counters: { inputTokens: 3 },
        baseline: 'unknown',
      });
      expect((await recorder.record(reset)).delta.inputTokens).toBeNull();
      const after = next({
        sequence: 3,
        epoch: 1,
        baseline: 'unknown',
        provenance: {
          harness: 'fixture',
          source: 'fixture.usage',
          eventId: 'event-3',
        },
        counters: { inputTokens: 7 },
      });
      expect((await recorder.record(after)).delta.inputTokens).toBe(4);
      expect((await recorder.summarize()).counters.inputTokens).toBeNull();
    });
    it('preserves same-epoch monotonicity across unknown snapshots without inventing gap deltas', async () => {
      const recorder = new ExternalAgentUsageRecorder(db, binding);
      const snapshot = (sequence: number, count: number | null, epoch = 0) =>
        fact({
          sequence,
          epoch,
          counters: { inputTokens: count },
          provenance: {
            harness: 'fixture',
            source: 'fixture.usage',
            eventId: `gap-${sequence}`,
          },
        });
      await recorder.record(snapshot(0, 1000));
      expect(
        (await recorder.record(snapshot(1, null))).delta.inputTokens,
      ).toBeNull();
      await expect(recorder.record(snapshot(2, 900))).rejects.toThrow(
        'counter decreased without reset',
      );
      expect((await recorder.summarize()).reports).toBe(2);
      expect(
        (await recorder.record(snapshot(2, 1100))).delta.inputTokens,
      ).toBeNull();
      expect((await recorder.record(snapshot(3, 1200))).delta.inputTokens).toBe(
        100,
      );
      expect(
        (await recorder.record(snapshot(4, 900, 1))).delta.inputTokens,
      ).toBe(900);
      expect((await recorder.summarize()).counters.inputTokens).toBeNull();
      const deltaBinding = { ...binding, sessionId: 'delta-basis-session' };
      const deltaRecorder = new ExternalAgentUsageRecorder(db, deltaBinding);
      await deltaRecorder.record({
        ...snapshot(0, 1000),
        binding: deltaBinding,
        basis: 'delta',
      });
      expect(
        (
          await deltaRecorder.record({
            ...snapshot(1, 900),
            binding: deltaBinding,
            basis: 'delta',
          })
        ).delta.inputTokens,
      ).toBe(900);
    });
    it('refuses gaps, undeclared reset, event reuse, changed semantics and reordered timestamps', async () => {
      const recorder = new ExternalAgentUsageRecorder(db, binding);
      await recorder.record(fact());
      for (const bad of [
        next({ sequence: 2 }),
        next({ epoch: 2 }),
        next({ counters: { inputTokens: 2 } }),
        next({ provenance: fact().provenance }),
        next({ model: 'other' }),
        next({ inputIncludesCache: false }),
        next({ observedAt: '2026-10-24T00:00:00Z' }),
      ])
        await expect(recorder.record(bad)).rejects.toThrow();
      expect((await recorder.summarize()).reports).toBe(1);
      await recorder.record(next());
    });
    it('allows explicit per-run delta basis without interpreting equal adjacent counters as duplicates', async () => {
      const recorder = new ExternalAgentUsageRecorder(db, binding);
      await recorder.record(fact({ basis: 'delta' }));
      await recorder.record(
        next({ basis: 'delta', counters: fact().counters }),
      );
      expect((await recorder.summarize()).counters.totalTokens).toBe(30);
    });
    it('shares caller transaction and rolls back receipt before retry', async () => {
      if (!db.transaction) throw new Error('Fixture requires transactions');
      await expect(
        db.transaction(async (tx) => {
          await new ExternalAgentUsageRecorder(tx, binding).record(fact());
          throw new Error('fixture rollback');
        }),
      ).rejects.toThrow('fixture rollback');
      const recorder = new ExternalAgentUsageRecorder(db, binding);
      expect((await recorder.summarize()).reports).toBe(0);
      await recorder.record(fact());
    });
    it('keeps immutable reports through telemetry retention and enumerates only trusted project scope', async () => {
      const { pruneAiUsage } = await import('../system/retention.js');
      const recorder = new ExternalAgentUsageRecorder(db, binding, {
        reporterId: 'manager-credential',
        reporterType: 'agent',
      });
      expect((await recorder.record(fact())).reporter?.reporterId).toBe(
        'manager-credential',
      );
      await pruneAiUsage(db, {
        maxRows: 0,
        maxAgeMs: 0,
        now: new Date('2027-01-01'),
      });
      expect((await recorder.summarize()).reports).toBe(1);
      const scope = {
        tenantId: binding.tenantId,
        workspaceId: binding.workspaceId,
        projectId: binding.projectId,
      };
      expect(await summarizeExternalAgentUsage(db, scope)).toHaveLength(1);
      expect(
        await summarizeExternalAgentUsage(db, { ...scope, projectId: 'other' }),
      ).toEqual([]);
      expect(
        await summarizeExternalAgentUsage(db, { ...scope, tenantId: 'other' }),
      ).toEqual([]);
    });
    it('rejects malformed or inclusive reports before mutation', async () => {
      const recorder = new ExternalAgentUsageRecorder(db, binding);
      const invalid = [
        { version: 2 },
        { scope: 'inclusive' },
        { basis: 'future' },
        { counters: { inputTokens: -1 } },
        { counters: { inputTokens: 0.5 } },
        { counters: { inputTokens: NaN } },
        { counters: { inputTokens: Number.MAX_SAFE_INTEGER + 1 } },
        { counters: { inputTokens: 1, cacheReadTokens: 2 } },
        { counters: { outputTokens: 1, reasoningTokens: 2 } },
        { provenance: { harness: 'fixture', source: 'fixture.usage' } },
        { secret: 'forbidden' },
        { counters: { unknownTokens: 1 } },
      ];
      for (const bad of invalid)
        await expect(
          recorder.record({ ...fact(), ...bad } as ExternalAgentUsageReport),
        ).rejects.toThrow();
      expect((await recorder.summarize()).reports).toBe(0);
      expect(
        normalizeExternalAgentUsageReport(
          fact({
            inputIncludesCache: false,
            counters: { inputTokens: 1, cacheReadTokens: 5 },
          }),
        ).counters.cacheReadTokens,
      ).toBe(5);
    });
  });
}
