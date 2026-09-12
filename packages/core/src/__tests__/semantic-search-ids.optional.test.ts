/** SQL-boundary tests: registry/storage initialization is supplied by the harness;
 * the real collection scoping, SQL generation, batched ranking and adapters run.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmrtCollection } from '../collection';
import { EmbeddingProvider } from '../embeddings/provider';
import { GlobalInterceptors } from '../interceptors';
import { SmrtObject } from '../object';
import { ObjectRegistry } from '../registry';
import {
  CREATE_SMRT_EMBEDDINGS_TABLE,
  getSystemTableDDLForEngine,
} from '../system/schema';

class SemanticIdProbe extends SmrtObject {}
class SemanticIdProbes extends SmrtCollection<SemanticIdProbe> {
  static readonly _itemClass = SemanticIdProbe;
}
const qualifiedName = '@test:SemanticIdProbe';
const idFor = (index: number) =>
  `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

for (const dialect of ['sqlite', 'duckdb', 'postgres'] as const) {
  describe.skipIf(
    dialect === 'postgres' && !process.env.SMRT_TEST_POSTGRES_URL,
  )(`semantic IDs (${dialect})`, () => {
    let appDb: DatabaseInterface;
    let systemDb: DatabaseInterface;
    let collection: SemanticIdProbes;
    let tempDir: string;
    let appQuery: ReturnType<typeof vi.spyOn>;
    let systemQuery: ReturnType<typeof vi.spyOn>;
    let originalAppQuery: DatabaseInterface['query'];
    const tableName = 'semantic_id_probe_rows';

    beforeEach(async () => {
      tempDir = mkdtempSync(join(tmpdir(), 'semantic-id-probe-'));
      const url = process.env.SMRT_TEST_POSTGRES_URL;
      appDb = await getDatabase({
        type: dialect,
        url: dialect === 'postgres' ? url : join(tempDir, 'app.db'),
        dbid: `semantic-app-${randomUUID()}`,
      });
      systemDb =
        dialect === 'postgres'
          ? appDb
          : await getDatabase({
              type: dialect,
              url: join(tempDir, 'system.db'),
              dbid: `semantic-system-${randomUUID()}`,
            });
      const idType = dialect === 'sqlite' ? 'TEXT' : 'UUID';
      await appDb.query(`DROP TABLE IF EXISTS ${tableName}`);
      await systemDb.query(
        getSystemTableDDLForEngine(CREATE_SMRT_EMBEDDINGS_TABLE, dialect),
      );
      await systemDb.query(
        "DELETE FROM _smrt_embeddings WHERE object_class = 'SemanticIdProbe'",
      );
      await appDb.query(
        `CREATE TABLE ${tableName} (id ${idType} PRIMARY KEY, group_key TEXT, category TEXT, _meta_type TEXT)`,
      );
      // Bypass only initialization; exercise the actual scope, identifier
      // conversion and ranking methods on the owning public collection API.
      collection = Object.create(SemanticIdProbes.prototype);
      Object.defineProperties(collection, {
        db: { value: appDb },
        systemDb: { value: systemDb },
        ai: { value: {} },
        tableName: { value: tableName },
        ensureStorageReady: { value: async () => {} },
        _cachedFields: { value: { groupKey: {}, category: {} } },
      });
      vi.spyOn(ObjectRegistry, 'getClassByConstructor').mockReturnValue({
        name: 'SemanticIdProbe',
        qualifiedName,
      } as any);
      vi.spyOn(ObjectRegistry, 'getTableStrategy').mockReturnValue('sti');
      vi.spyOn(ObjectRegistry, 'getSTIBase').mockReturnValue('@test:Base');
      vi.spyOn(ObjectRegistry, 'resolveEmbeddingConfig').mockReturnValue({
        fields: ['content'],
        combinedField: { name: 'combined', template: '{content}' },
      });
      vi.spyOn(EmbeddingProvider.prototype, 'getModelName').mockReturnValue(
        'test-model',
      );
      vi.spyOn(EmbeddingProvider.prototype, 'embed').mockResolvedValue([
        [1, 0],
      ]);
      originalAppQuery = appDb.query.bind(appDb);
      appQuery = vi.spyOn(appDb, 'query');
      systemQuery = systemDb === appDb ? appQuery : vi.spyOn(systemDb, 'query');
    });
    afterEach(async () => {
      GlobalInterceptors.unregister('semantic-id-scope');
      vi.restoreAllMocks();
      await systemDb?.query(
        "DELETE FROM _smrt_embeddings WHERE object_class = 'SemanticIdProbe'",
      );
      await appDb?.query(`DROP TABLE IF EXISTS ${tableName}`);
      await appDb?.close();
      if (systemDb !== appDb) await systemDb?.close();
      rmSync(tempDir, { recursive: true, force: true });
    });
    async function seed(count: number) {
      for (let index = 1; index <= count; index++) {
        await appDb.query(
          `INSERT INTO ${tableName} VALUES (?, ?, ?, ?)`,
          idFor(index),
          index === 1 ? 'foreign' : 'owned',
          index === 2 ? 'other' : 'wanted',
          index === 3 ? '@test:Sibling' : qualifiedName,
        );
        await systemDb.query(
          "INSERT INTO _smrt_embeddings (id, object_id, object_class, field_name, model, embedding, content_hash, dimensions) VALUES (?, ?, ?, ?, ?, ?, 'test', 2)",
          idFor(index),
          idFor(index),
          'SemanticIdProbe',
          'content',
          'test-model',
          JSON.stringify(index <= 3 ? [1, 0] : [index / count, 0.1]),
        );
      }
      appQuery.mockClear();
      systemQuery.mockClear();
    }
    it('ranks all eligible batches without fetching application rows or hydrating', async () => {
      await seed(135);
      GlobalInterceptors.register({
        name: 'semantic-id-scope',
        beforeList: (_name, options) => ({
          ...options,
          where: { ...options.where, groupKey: 'owned' },
        }),
      });
      const list = vi
        .spyOn(collection, 'list')
        .mockRejectedValue(new Error('must not hydrate'));
      const result = await collection.semanticSearchIds('query', {
        limit: 2,
        where: { category: 'wanted' },
      });
      expect(result.map((row) => row.id)).toEqual([idFor(135), idFor(134)]);
      expect(result[0].similarity).toBeCloseTo(1 / Math.sqrt(1.01));
      expect(list).not.toHaveBeenCalled();
      const applicationCalls = appQuery.mock.calls.filter(([sql]) =>
        String(sql).includes(tableName),
      );
      expect(applicationCalls).toHaveLength(3);
      for (const [sql] of applicationCalls) {
        expect(sql).toMatch(/^SELECT CASE WHEN EXISTS/);
        expect(sql).toContain('AS eligibility');
        expect(sql).not.toMatch(/SELECT (?:\*|id) FROM/);
        expect(
          (String(sql).match(/SELECT 1 FROM/g) || []).length,
        ).toBeLessThanOrEqual(64);
      }
      const embeddingCalls = systemQuery.mock.calls.filter(([sql]) =>
        String(sql).includes('FROM _smrt_embeddings'),
      );
      expect(embeddingCalls).toHaveLength(3);
      expect(
        embeddingCalls.every(([sql]) => String(sql).includes('LIMIT 64')),
      ).toBe(true);
    });
    it('honors OR predicates, candidate IDs and child scope, with stable ties', async () => {
      await seed(6);
      await systemDb.query(
        "UPDATE _smrt_embeddings SET embedding = ? WHERE object_class = 'SemanticIdProbe'",
        '[1,0]',
      );
      const result = await collection.findSimilarIdsToEmbedding([1, 0], {
        limit: 4,
        where: [[{ id: idFor(3) }], [{ 'id in': [idFor(5), idFor(6)] }]],
      });
      expect(result.map((row) => row.id)).toEqual([idFor(5), idFor(6)]);
      expect(
        await collection.findSimilarIdsToEmbedding([1, 0], {
          where: { category: 'absent' },
        }),
      ).toEqual([]);
    });
    it('fails closed on scope errors and malformed options or masks', async () => {
      await seed(1);
      await expect(
        collection.findSimilarIdsToEmbedding([1, 0], { limit: -1 }),
      ).rejects.toThrow('nonnegative');
      await expect(
        collection.findSimilarIdsToEmbedding([1, 0], { minSimilarity: NaN }),
      ).rejects.toThrow('between');
      await expect(
        collection.findSimilarIdsToEmbedding([1, 0], { field: 'absent' }),
      ).rejects.toThrow('not configured');
      GlobalInterceptors.register({
        name: 'semantic-id-scope',
        beforeList: () => {
          throw new Error('tenant required');
        },
      });
      await expect(
        collection.findSimilarIdsToEmbedding([1, 0]),
      ).rejects.toThrow('tenant required');
      GlobalInterceptors.unregister('semantic-id-scope');
      appQuery.mockImplementation(async (sql: string, ...values: unknown[]) =>
        sql.includes('AS eligibility')
          ? { rows: [{ eligibility: 'garbage' }], rowCount: 1 }
          : originalAppQuery(sql, ...values),
      );
      await expect(
        collection.findSimilarIdsToEmbedding([1, 0]),
      ).rejects.toThrow('eligibility');
    });
  });
}
