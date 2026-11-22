/**
 * Embedding keyset paging (#5451).
 *
 * `semanticSearchIds()` pages `_smrt_embeddings` 64 rows at a time, seeking
 * past the last id of the previous page within one `(object_class,
 * field_name, model)`. On SQLite and PostgreSQL
 * `idx_smrt_embeddings_class_field_model_id` lets each page seek and read in
 * index order instead of re-sorting every remaining row of the model, so a
 * whole scan reads each row once and costs O(N). DuckDB does not use the index
 * for this ordered range (each page stays a scan plus top-N), so the plan test
 * skips it; its results are still checked below.
 *
 * These tests pin that the index is used, that a scan returns every row of the
 * partition exactly once, and that ranked, tenant-scoped results are the same
 * with and without the index and equal an exact brute-force ranking.
 *
 * Real in-memory SQLite and DuckDB; PGlite joins when the lane sets
 * `SMRT_TEST_PGLITE=1` (`pnpm test:pglite`). Only registry and embedding
 * provider initialization is stubbed; collection scoping, SQL and ranking run.
 */

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
import { getTestDatabase } from '../testing/database';

type Engine = 'sqlite' | 'duckdb' | 'pglite';

const engines: Engine[] = [
  'sqlite',
  'duckdb',
  ...(process.env.SMRT_TEST_PGLITE === '1' ? (['pglite'] as const) : []),
];

const INDEX_NAME = 'idx_smrt_embeddings_class_field_model_id';
const CLASS = 'PagedEmbeddingProbe';
const FIELD = 'content';
const MODEL = 'paging-model';
const TABLE = 'paged_embedding_probe_rows';
const TENANTS = ['tenant-a', 'tenant-b', 'tenant-c'] as const;
const QUERY_VECTOR = [0.6, 0.8, 0.1];

class PagedEmbeddingProbe extends SmrtObject {}
class PagedEmbeddingProbes extends SmrtCollection<PagedEmbeddingProbe> {
  static readonly _itemClass = PagedEmbeddingProbe;
}

const idFor = (index: number) =>
  `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

/** Deterministic vector; every seventh row repeats a vector to force ties. */
function vectorFor(index: number): number[] {
  const seed = index % 7 === 0 ? 7 : index;
  return [
    Math.sin(seed * 12.9898) * 0.5 + 0.5,
    Math.cos(seed * 78.233) * 0.5 + 0.5,
    Math.sin(seed * 4.1234) * 0.25,
  ];
}

const tenantFor = (index: number) => TENANTS[index % TENANTS.length];

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

describe.each(engines)('embedding keyset paging (%s)', (engine) => {
  let db: DatabaseInterface;
  let collection: PagedEmbeddingProbes;
  const dialect = engine === 'pglite' ? 'postgres' : engine;

  beforeEach(async () => {
    db =
      engine === 'pglite'
        ? await getTestDatabase({
            type: 'pglite',
            classes: [],
            includeSystemTables: false,
          })
        : await getDatabase({ type: engine, url: ':memory:' });
    for (const statement of getSystemTableDDLForEngine(
      CREATE_SMRT_EMBEDDINGS_TABLE,
      dialect,
    )
      .split(';')
      .map((value) => value.trim())
      .filter(Boolean)) {
      await db.query(statement);
    }
    await db.query(
      `CREATE TABLE ${TABLE} (id ${engine === 'sqlite' ? 'TEXT' : 'UUID'} PRIMARY KEY, tenant_id TEXT, _meta_type TEXT)`,
    );
    collection = Object.create(PagedEmbeddingProbes.prototype);
    Object.defineProperties(collection, {
      db: { value: db },
      systemDb: { value: db },
      ai: { value: {} },
      tableName: { value: TABLE },
      ensureStorageReady: { value: async () => {} },
      _cachedFields: { value: { tenantId: {} } },
    });
    vi.spyOn(ObjectRegistry, 'getClassByConstructor').mockReturnValue({
      name: CLASS,
      qualifiedName: `@test:${CLASS}`,
    } as never);
    vi.spyOn(ObjectRegistry, 'getTableStrategy').mockReturnValue('cti');
    vi.spyOn(ObjectRegistry, 'resolveEmbeddingConfig').mockReturnValue({
      fields: [FIELD],
      combinedField: { name: 'combined', template: '{content}' },
      dimensions: 3,
      provider: 'local',
      localModel: MODEL,
      aiModel: MODEL,
      fallbackToAI: false,
    } as never);
    vi.spyOn(EmbeddingProvider.prototype, 'getModelName').mockReturnValue(
      MODEL,
    );
    vi.spyOn(EmbeddingProvider.prototype, 'embed').mockResolvedValue([
      QUERY_VECTOR,
    ]);
  });

  afterEach(async () => {
    GlobalInterceptors.unregister('paged-embedding-scope');
    vi.restoreAllMocks();
    await db?.close?.();
  });

  /**
   * `count` application rows with one embedding each, spread over three
   * tenants, plus rows of another field, model and class whose ids interleave
   * with them so a seek that left its partition would be visible.
   */
  async function seed(count: number): Promise<void> {
    for (let index = 1; index <= count; index++) {
      await db.query(
        `INSERT INTO ${TABLE} (id, tenant_id, _meta_type) VALUES (?, ?, ?)`,
        idFor(index),
        tenantFor(index),
        `@test:${CLASS}`,
      );
      await db.query(
        `INSERT INTO _smrt_embeddings
           (id, object_id, object_class, field_name, model, embedding, content_hash, dimensions)
         VALUES (?, ?, ?, ?, ?, ?, 'h', 3)`,
        `${idFor(index)}-a`,
        idFor(index),
        CLASS,
        FIELD,
        MODEL,
        JSON.stringify(vectorFor(index)),
      );
      const [otherClass, otherField, otherModel] =
        index % 3 === 0
          ? ['OtherProbe', FIELD, MODEL]
          : index % 3 === 1
            ? [CLASS, 'title', MODEL]
            : [CLASS, FIELD, 'other-model'];
      await db.query(
        `INSERT INTO _smrt_embeddings
           (id, object_id, object_class, field_name, model, embedding, content_hash, dimensions)
         VALUES (?, ?, ?, ?, ?, ?, 'h', 3)`,
        `${idFor(index)}-b`,
        idFor(index),
        otherClass,
        otherField,
        otherModel,
        JSON.stringify(QUERY_VECTOR),
      );
    }
  }

  function scopeTo(tenant: string): void {
    GlobalInterceptors.register({
      name: 'paged-embedding-scope',
      beforeList: (_name, options) => ({
        ...options,
        where: { ...options.where, tenantId: tenant },
      }),
    });
  }

  function bruteForce(count: number, tenant: string | null, limit: number) {
    const ranked: Array<{ id: string; similarity: number }> = [];
    for (let index = 1; index <= count; index++) {
      if (tenant && tenantFor(index) !== tenant) continue;
      ranked.push({
        id: idFor(index),
        similarity: cosine(QUERY_VECTOR, vectorFor(index)),
      });
    }
    ranked.sort(
      (a, b) =>
        b.similarity - a.similarity || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    return ranked.slice(0, limit);
  }

  /** The page query `searchSimilarBatched()` issues after its first page. */
  function pageQuerySql(params: [string, string, string, string]): string {
    const [cls, field, model, cursor] = params;
    return `SELECT CAST(id AS VARCHAR) AS id, CAST(object_id AS VARCHAR) AS object_id, embedding FROM _smrt_embeddings
         WHERE object_class = ${cls} AND field_name = ${field} AND model = ${model} AND id > ${cursor}
         ORDER BY _smrt_embeddings.id ASC LIMIT 64`;
  }

  it('creates the paging index with the system DDL', async () => {
    const names =
      engine === 'pglite'
        ? rowsOf(
            await db.query(
              `SELECT indexname AS name FROM pg_indexes
                WHERE schemaname = current_schema() AND tablename = '_smrt_embeddings'`,
            ),
          )
        : engine === 'duckdb'
          ? rowsOf(
              await db.query(
                `SELECT index_name AS name FROM duckdb_indexes()
                  WHERE table_name = '_smrt_embeddings'`,
              ),
            )
          : rowsOf(
              await db.query(
                `SELECT name FROM sqlite_master
                  WHERE type = 'index' AND tbl_name = '_smrt_embeddings'`,
              ),
            );
    expect(names.map((row) => row.name)).toContain(INDEX_NAME);
  });

  it.skipIf(engine === 'duckdb')(
    'seeks each page through the index without sorting the rest of the model',
    async () => {
      await seed(130);
      if (engine === 'sqlite') {
        const plan = rowsOf(
          await db.query(
            `EXPLAIN QUERY PLAN ${pageQuerySql(['?', '?', '?', '?'])}`,
            CLASS,
            FIELD,
            MODEL,
            idFor(10),
          ),
        )
          .map((row) => String(row.detail))
          .join('\n');
        expect(plan).toContain(INDEX_NAME);
        expect(plan).not.toContain('TEMP B-TREE');
        return;
      }
      // PostgreSQL chooses by statistics, so give the partition a realistic
      // share of the table: other classes' rows dominate, as they do once an
      // app embeds several classes. Sequential scans are ruled out because a
      // seeded table this small is cheapest to read whole whatever indexes
      // exist; without the paging index the plan filters another index and
      // sorts, or walks the primary key and discards other partitions' rows.
      await db.query(
        `INSERT INTO _smrt_embeddings
           (id, object_id, object_class, field_name, model, embedding, content_hash, dimensions)
         SELECT 'other-' || g, 'other-' || g, 'OtherProbe', $1, $2, '[1,0,0]', 'h', 3
           FROM generate_series(1, 4000) AS g`,
        FIELD,
        MODEL,
      );
      await db.query('ANALYZE _smrt_embeddings');
      await db.query('SET enable_seqscan = off');
      const plan = rowsOf(
        await db.query(
          `EXPLAIN ${pageQuerySql(['$1', '$2', '$3', '$4'])}`,
          CLASS,
          FIELD,
          MODEL,
          idFor(10),
        ),
      )
        .map((row) => String(Object.values(row)[0]))
        .join('\n');
      expect(plan).toContain(INDEX_NAME);
      expect(plan).not.toMatch(/\bSort\b/);
    },
  );

  it('returns every embedding of the partition exactly once across pages', async () => {
    const count = 64 * 3 + 17;
    await seed(count);
    const query = vi.spyOn(db, 'query');

    await collection.semanticSearchIds('query', { limit: 5 });

    const pages = query.mock.results
      .map((result, call) => ({
        sql: String(query.mock.calls[call]?.[0] ?? ''),
        result,
      }))
      .filter(({ sql }) => sql.includes('FROM _smrt_embeddings'));
    const ids: string[] = [];
    for (const page of pages) {
      const value = await page.result.value;
      ids.push(...rowsOf(value).map((row) => String(row.id)));
    }
    expect(pages).toHaveLength(Math.ceil(count / 64));
    expect(ids).toHaveLength(count);
    expect(new Set(ids).size).toBe(count);
    expect(ids.every((id) => id.endsWith('-a'))).toBe(true);
    expect([...ids].sort()).toEqual(ids);
  });

  it('returns the same tenant-scoped ranking with and without the index', async () => {
    const count = 64 * 4 + 9;
    await seed(count);

    for (const tenant of [...TENANTS, null]) {
      GlobalInterceptors.unregister('paged-embedding-scope');
      if (tenant) scopeTo(tenant);

      const indexed = await collection.semanticSearchIds('query', {
        limit: 12,
      });
      await db.query(`DROP INDEX ${INDEX_NAME}`);
      const unindexed = await collection.semanticSearchIds('query', {
        limit: 12,
      });
      await db.query(
        `CREATE INDEX ${INDEX_NAME} ON _smrt_embeddings(object_class, field_name, model, id)`,
      );

      expect(indexed).toEqual(unindexed);
      const expected = bruteForce(count, tenant, 12);
      expect(indexed.map((row) => row.id)).toEqual(
        expected.map((row) => row.id),
      );
      indexed.forEach((row, position) => {
        expect(row.similarity).toBeCloseTo(expected[position].similarity, 10);
      });
      if (tenant) {
        const owned = new Set(
          Array.from({ length: count }, (_, i) => i + 1)
            .filter((index) => tenantFor(index) === tenant)
            .map(idFor),
        );
        expect(indexed.every((row) => owned.has(row.id))).toBe(true);
      }
    }
  });
});
