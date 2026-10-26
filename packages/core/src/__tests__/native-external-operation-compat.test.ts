import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiUsagePersistenceHandler } from '../adapters/ai-usage.js';
import { SmrtClass } from '../class.js';
import { summarizeExternalAgentUsage } from '../external-agent-usage.js';
import { pruneAiUsage } from '../system/retention.js';
import { getTestDatabase } from '../testing/database.js';

class NativeUsageReader extends SmrtClass {
  async start() {
    await this.initialize();
  }
}

// The public native event operation is arbitrary text. A UUID row written by the
// real native handler must not become an external receipt because of that text.
describe.each([
  'sqlite',
  'duckdb',
] as const)('native external-agent operation %s', (type) => {
  describe.each([
    ['null', undefined],
    ['ordinary', { component: 'native-fixture' }],
  ] as const)('%s tags', (_name, tags) => {
    let db: DatabaseInterface;
    let reader: NativeUsageReader;
    let nativeId: string;
    const tenantId = `native-operation-${crypto.randomUUID()}`;
    beforeEach(async () => {
      db = await getTestDatabase({ type, classes: [] });
      reader = new NativeUsageReader({ db });
      await reader.start();
      await new AiUsagePersistenceHandler(db).handle({
        provider: 'fixture',
        model: 'native-model',
        operation: 'external-agent',
        usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
        duration: 12,
        timestamp: new Date('2026-10-26T00:00:00Z'),
        estimatedCost: 0.25,
        className: 'Native',
        tenantId,
        ...(tags ? { tags } : {}),
      });
      const rows = await db.query(
        'SELECT id, tags FROM _smrt_ai_usage WHERE tenant_id = ?',
        tenantId,
      );
      expect(rows.rows).toHaveLength(1);
      nativeId = String(rows.rows[0].id);
      expect(nativeId).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
      expect(rows.rows[0].tags).toBe(tags ? JSON.stringify(tags) : null);
    });
    afterEach(async () => {
      reader.destroy();
      await db.close?.();
    });
    it('keeps the native custom operation in native lists', async () => {
      const rows = await reader.listAiUsage({ tenantId });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: nativeId,
        operation: 'external-agent',
        className: 'Native',
        usage: { totalTokens: 10 },
      });
    });
    it('keeps the native custom operation in native summaries', async () => {
      const summary = await reader.summarizeAiUsage({
        tenantId,
        groupBy: 'operation',
      });
      expect(summary['external-agent']).toMatchObject({
        callCount: 1,
        promptTokens: 7,
        completionTokens: 3,
        totalTokens: 10,
        estimatedCost: 0.25,
      });
    });
    it('never parses native null or ordinary tags as external receipt metadata', async () => {
      await expect(
        summarizeExternalAgentUsage(db, {
          tenantId,
          workspaceId: 'workspace',
          projectId: 'project',
        }),
      ).resolves.toEqual([]);
    });
    it.each([
      'age',
      'rows',
    ] as const)('keeps native custom-operation telemetry eligible for %s retention', async (mode) => {
      const result = await pruneAiUsage(db, {
        tenantId,
        ...(mode === 'age'
          ? { maxAgeMs: 0, now: new Date('2027-01-01') }
          : { maxRows: 0 }),
      });
      expect(result.pruned).toBe(1);
      expect(await db.get('_smrt_ai_usage', { id: nativeId })).toBeNull();
    });
  });
});
