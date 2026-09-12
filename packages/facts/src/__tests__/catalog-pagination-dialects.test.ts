import { randomUUID } from 'node:crypto';
import {
  EmbeddingProvider,
  EmbeddingStorage,
  getTestDatabase,
  ObjectRegistry,
  smrt,
} from '@happyvertical/smrt-core';
import {
  generateSchemaDiff,
  getSQLFromDiff,
} from '@happyvertical/smrt-core/migrations';
import { getDDLStrategy } from '@happyvertical/smrt-core/schema';
import {
  disableTenancy,
  enableTenancy,
  withSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeCatalogSearch } from '../catalog-search';
import { Fact } from '../fact';
import { FactCollection } from '../facts';

@smrt({ embeddings: { fields: ['textRefined'], autoGenerate: false } })
class CatalogSpecialFact extends Fact {}

class CatalogSpecialFacts extends FactCollection {
  static readonly _itemClass = CatalogSpecialFact;
}

for (const dialect of ['sqlite', 'duckdb', 'postgres'] as const) {
  describe.skipIf(dialect === 'postgres' && !isPostgresAvailable())(
    `catalog pagination on ${dialect}${dialect === 'duckdb' ? ' (SQL-only fixture; canonical self-FK blocked)' : ''}`,
    () => {
      let db: DatabaseInterface;
      let migrationDb: DatabaseInterface;
      let facts: FactCollection;
      let cleanup: () => Promise<void>;
      beforeEach(async () => {
        if (dialect === 'postgres') {
          const isolated = await createIsolatedTestDbFromManifest({
            includeObjects: ['Fact'],
          });
          db = isolated.db;
          migrationDb = isolated.baseDb;
          cleanup = isolated.cleanup;
        } else {
          // DuckDB cannot create Fact's canonical self-FK. This fixture proves
          // query dialect behavior only; it is not canonical persistence parity.
          db = await getTestDatabase({
            type: dialect,
            url: ':memory:',
            classes: ['Fact'],
            omitForeignKeyConstraints: dialect === 'duckdb',
          });
          migrationDb = db;
          cleanup = async () => {
            await db.close?.();
          };
        }
        facts = await FactCollection.create({ db });
      });
      afterEach(async () => {
        disableTenancy();
        vi.restoreAllMocks();
        await cleanup?.();
      });

      it('migrates historical search storage and safely resumes bounded backfill', async () => {
        const first = await facts.create({
          textRefined: 'K  É',
          textRaw: 'raw',
          status: 'active',
        });
        const second = await facts.create({
          textRefined: 'second',
          status: 'active',
        });
        first.catalogSearch = 'caller supplied derived value';
        await first.save();
        expect(first.catalogSearch).toBe(encodeCatalogSearch('K  É raw'));
        expect(JSON.stringify(first.toPublicJSON())).not.toMatch(
          /catalogSearch|catalog_search/,
        );
        const { rows: beforeBackfill } = await db.query(
          'SELECT updated_at FROM facts WHERE id = ?',
          first.id,
        );
        const schemas = ObjectRegistry.getAllSchemasAsDefinitions();
        // PostgreSQL metadata introspection uses the base connection. Probe
        // migration DDL on its own table outside the DML rollback transaction.
        const migrationTable =
          dialect === 'postgres'
            ? `catalog_migration_${randomUUID().replaceAll('-', '')}`
            : 'facts';
        const expectedSchema = {
          ...schemas.facts,
          tableName: migrationTable,
          columns: Object.fromEntries(
            Object.entries(schemas.facts.columns).map(([name, column]) => [
              name,
              {
                ...column,
                ...(column.foreignKey
                  ? {
                      foreignKey: {
                        ...column.foreignKey,
                        table:
                          column.foreignKey.table === 'facts'
                            ? migrationTable
                            : column.foreignKey.table,
                      },
                    }
                  : {}),
              },
            ]),
          ),
          foreignKeys: schemas.facts.foreignKeys?.map((foreignKey) => ({
            ...foreignKey,
            referencesTable:
              foreignKey.referencesTable === 'facts'
                ? migrationTable
                : foreignKey.referencesTable,
          })),
        };
        if (dialect === 'postgres') {
          const columns = Object.fromEntries(
            Object.entries(expectedSchema.columns).filter(
              ([name]) => name !== 'catalog_search',
            ),
          );
          await migrationDb.query(
            getDDLStrategy('postgres').generateCreateTable({
              ...expectedSchema,
              columns,
            }),
          );
          await migrationDb.query(
            `INSERT INTO ${migrationTable} (id, slug, _meta_type, text_refined, text_raw) VALUES (?, ?, ?, ?, ?)`,
            randomUUID(),
            'historical',
            '@happyvertical/smrt-facts:Fact',
            'K  É',
            'raw',
          );
          await db.query('UPDATE facts SET catalog_search = NULL');
        } else if (dialect === 'duckdb') {
          // Recreate this SQL-only fixture's historical schema: DuckDB cannot
          // drop an interior column when later columns have constraint indexes.
          const strategy = getDDLStrategy('duckdb');
          const columns = Object.fromEntries(
            Object.entries(schemas.facts.columns)
              .filter(([name]) => name !== 'catalog_search')
              .map(([name, column]) => [
                name,
                { ...column, foreignKey: undefined },
              ]),
          );
          const historical = { ...schemas.facts, columns, foreignKeys: [] };
          await db.query(
            'CREATE TABLE historical_facts AS SELECT * EXCLUDE(catalog_search) FROM facts',
          );
          await db.query('DROP TABLE facts');
          await db.query(strategy.generateCreateTable(historical));
          const names = Object.keys(columns)
            .map((name) => `"${name}"`)
            .join(', ');
          await db.query(
            `INSERT INTO facts (${names}) SELECT ${names} FROM historical_facts`,
          );
          for (const sql of strategy.generateIndexes(historical))
            await db.query(sql);
          await db.query('DROP TABLE historical_facts');
        } else {
          await db.query('ALTER TABLE facts DROP COLUMN catalog_search');
        }
        vi.spyOn(facts, 'semanticSearchIds').mockRejectedValue(
          new Error('offline'),
        );
        await expect(facts.browseCatalog('k')).rejects.toThrow(
          'backfillCatalogSearch',
        );
        const diff = await generateSchemaDiff(
          migrationDb,
          { [migrationTable]: expectedSchema },
          { engineHint: dialect },
        );
        const statements = getSQLFromDiff(diff).filter((sql) =>
          /ADD COLUMN.*catalog_search/i.test(sql),
        );
        expect(statements).toHaveLength(1);
        await migrationDb.query(statements[0]);
        const migratedDiff = await generateSchemaDiff(
          migrationDb,
          { [migrationTable]: expectedSchema },
          { engineHint: dialect },
        );
        expect(
          getSQLFromDiff(migratedDiff).filter((sql) =>
            /ADD COLUMN.*catalog_search/i.test(sql),
          ),
        ).toEqual([]);
        if (dialect === 'postgres') {
          const { rows } = await migrationDb.query(
            `SELECT text_refined, catalog_search FROM ${migrationTable}`,
          );
          expect(rows).toEqual([
            { text_refined: 'K  É', catalog_search: null },
          ]);
          await migrationDb.query(`DROP TABLE ${migrationTable}`);
        }
        vi.spyOn(facts, 'semanticSearchIds').mockRejectedValue(
          new Error('offline'),
        );
        await expect(facts.browseCatalog('k')).rejects.toThrow(
          'backfillCatalogSearch',
        );
        await expect(facts.backfillCatalogSearch()).rejects.toThrow(
          'withSystemContext',
        );
        await withSystemContext(async () => {
          expect(await facts.backfillCatalogSearch(1)).toEqual({
            remaining: 1,
          });
          expect(await facts.backfillCatalogSearch(1)).toEqual({
            remaining: 0,
          });
          expect(await facts.backfillCatalogSearch(1)).toEqual({
            remaining: 0,
          });
          await expect(facts.backfillCatalogSearch(0)).rejects.toThrow(
            'batchSize',
          );
        });
        expect(
          (await facts.browseCatalog('k  é raw', { latestOnly: false })).map(
            (f) => f.id,
          ),
        ).toEqual([first.id]);
        const { rows: afterBackfill } = await db.query(
          'SELECT updated_at FROM facts WHERE id = ?',
          first.id,
        );
        expect(afterBackfill).toEqual(beforeBackfill);
        const loaded = await facts.get({ id: second.id }, { cache: false });
        loaded!.textRefined = 'İ changed';
        await loaded?.save();
        expect(
          (
            await facts.browseCatalog('i\u0307 changed', { latestOnly: false })
          ).map((f) => f.id),
        ).toEqual([second.id]);
        await facts.getOrUpsert({ id: second.id, textRaw: 'É updated' });
        expect(
          (await facts.browseCatalog('é updated', { latestOnly: false })).map(
            (f) => f.id,
          ),
        ).toEqual([second.id]);
      });

      it.each([
        true,
        false,
      ])('backfill handles concurrent source changes (maintained: %s)', async (maintained) => {
        const fact = await facts.create({
          textRefined: 'old',
          status: 'active',
        });
        await db.query(
          'UPDATE facts SET catalog_search = NULL WHERE id = ?',
          fact.id,
        );
        const originalQuery = db.query.bind(db);
        let raced = false;
        vi.spyOn(db, 'query').mockImplementation(async (sql, ...params) => {
          if (
            !raced &&
            /UPDATE facts SET catalog_search = \?/.test(String(sql))
          ) {
            raced = true;
            await originalQuery(
              'UPDATE facts SET text_refined = ?, catalog_search = ? WHERE id = ?',
              'new',
              maintained ? encodeCatalogSearch('new ') : null,
              fact.id,
            );
          }
          return originalQuery(sql, ...params);
        });
        await withSystemContext(async () => {
          expect(await facts.backfillCatalogSearch(1)).toEqual({
            remaining: maintained ? 0 : 1,
          });
          expect(await facts.backfillCatalogSearch(1)).toEqual({
            remaining: 0,
          });
        });
        vi.spyOn(facts, 'semanticSearchIds').mockRejectedValue(
          new Error('offline'),
        );
        expect(
          (await facts.browseCatalog('new', { latestOnly: false })).map(
            (f) => f.id,
          ),
        ).toEqual([fact.id]);
        expect(await facts.browseCatalog('old', { latestOnly: false })).toEqual(
          [],
        );
      });

      it('scopes readiness and subtype backfill without widening active tenancy', async () => {
        const tenantA = randomUUID();
        const tenantB = randomUUID();
        const special = await CatalogSpecialFacts.create({ db });
        const own = await special.create({
          tenantId: tenantA,
          textRefined: 'own',
          status: 'active',
        });
        const foreign = await special.create({
          tenantId: tenantB,
          textRefined: 'foreign',
          status: 'active',
        });
        const otherType = await facts.create({
          tenantId: tenantA,
          textRefined: 'base',
          status: 'active',
        });
        await db.query(
          'UPDATE facts SET catalog_search = NULL WHERE id IN (?, ?)',
          foreign.id,
          otherType.id,
        );
        vi.spyOn(special, 'semanticSearchIds').mockRejectedValue(
          new Error('offline'),
        );
        enableTenancy();
        await withTenant({ tenantId: tenantA }, async () => {
          expect(
            (await special.browseCatalog('own', { tenantId: tenantA })).map(
              (fact) => fact.id,
            ),
          ).toEqual([own.id]);
          await expect(special.backfillCatalogSearch()).rejects.toThrow(
            'withSystemContext',
          );
          await expect(
            special.browseCatalog('foreign', { tenantId: tenantB }),
          ).rejects.toThrow();
        });
        await withSystemContext(async () => {
          expect(await special.backfillCatalogSearch()).toEqual({
            remaining: 0,
          });
          const { rows } = await db.query(
            'SELECT COUNT(*) AS pending FROM facts WHERE catalog_search IS NULL',
          );
          expect(Number(rows[0].pending)).toBe(1);
          expect(await facts.backfillCatalogSearch()).toEqual({ remaining: 0 });
        });
      });

      it('pages recursive terminal results with one data query and excludes foreign tenant successors', async () => {
        const tenantA = randomUUID();
        const tenantB = randomUUID();
        const root = await facts.create({
          tenantId: tenantA,
          textRefined: 'root',
          status: 'active',
          confidence: 0.1,
        });
        const leaf = await facts.create({
          tenantId: tenantA,
          previousFactId: root.id,
          textRefined: 'leaf',
          status: 'pending',
          confidence: 0.8,
        });
        const foreign = await facts.create({
          tenantId: tenantB,
          previousFactId: root.id,
          textRefined: 'foreign',
          status: 'active',
          confidence: 0.99,
        });
        const global = await facts.create({
          textRefined: 'global',
          status: 'active',
        });
        enableTenancy();
        await withTenant({ tenantId: tenantA }, async () => {
          const query = vi.spyOn(db, 'query');
          const first = await facts.browseCatalog('', {
            tenantId: tenantA,
            limit: 1,
          });
          expect(
            query.mock.calls.filter(([sql]) =>
              String(sql).includes('WITH RECURSIVE'),
            ),
          ).toHaveLength(dialect === 'duckdb' ? 2 : 1);
          expect(first).toHaveLength(1);
          for (const [index, [sql]] of query.mock.calls.entries()) {
            if (
              String(sql).includes('WITH RECURSIVE') &&
              !String(sql).startsWith('DESCRIBE')
            ) {
              expect((await query.mock.results[index].value).rows).toHaveLength(
                1,
              );
            }
          }
          const second = await facts.browseCatalog('', {
            tenantId: tenantA,
            limit: 1,
            offset: 1,
          });
          expect(new Set([...first, ...second].map((f) => f.id))).toEqual(
            new Set([leaf.id, global.id]),
          );
          expect([...first, ...second].map((f) => f.id)).not.toContain(
            foreign.id,
          );
          await expect(
            facts.browseCatalog('', { tenantId: tenantB }),
          ).rejects.toThrow();
          const implicit = await facts.browseCatalog('', { latestOnly: false });
          expect(implicit.map((f) => f.id)).toEqual([root.id]);
        });
      });

      it('preserves the newest successor on implicit-scope confidence ties', async () => {
        const root = await facts.create({
          textRefined: 'root',
          status: 'active',
        });
        const older = await facts.create({
          textRefined: 'older',
          status: 'pending',
          previousFactId: root.id,
          confidence: 0.8,
        });
        const newer = await facts.create({
          textRefined: 'newer',
          status: 'pending',
          previousFactId: root.id,
          confidence: 0.8,
        });
        await db.query(
          'UPDATE facts SET updated_at = ? WHERE id = ?',
          '2026-01-01T00:00:00.000Z',
          older.id,
        );
        await db.query(
          'UPDATE facts SET updated_at = ? WHERE id = ?',
          '2026-02-01T00:00:00.000Z',
          newer.id,
        );
        const page = await facts.browseCatalog('', { limit: 1 });
        expect(page.map((f) => f.id)).toEqual([newer.id]);
        vi.spyOn(facts, 'semanticSearchIds').mockRejectedValue(
          new Error('Embeddings unavailable'),
        );
        expect(
          (await facts.browseCatalog('root', { limit: 1 })).map((f) => f.id),
        ).toEqual([newer.id]);
      });

      it('terminates recursive cycles and returns each repeated candidate once', async () => {
        const root = await facts.create({
          textRefined: 'cycle root',
          status: 'active',
        });
        const leaf = await facts.create({
          textRefined: 'cycle leaf',
          status: 'active',
          previousFactId: root.id,
        });
        await db.query(
          'UPDATE facts SET previous_fact_id = ? WHERE id = ?',
          leaf.id,
          root.id,
        );
        const page = await facts.browseCatalog('', { limit: 5 });
        expect(page).toHaveLength(2);
        expect(new Set(page.map((f) => f.id))).toEqual(
          new Set([root.id, leaf.id]),
        );
        vi.spyOn(facts, 'semanticSearchIds').mockRejectedValue(
          new Error('Embeddings unavailable'),
        );
        const fallback = await facts.browseCatalog('cycle', { limit: 5 });
        expect(fallback).toHaveLength(2);
        expect(new Set(fallback.map((f) => f.id))).toEqual(
          new Set([root.id, leaf.id]),
        );
      });

      it('keeps STI child candidates and successors inside their discriminator', async () => {
        const tenant = randomUUID();
        const special = await CatalogSpecialFacts.create({ db });
        const root = await special.create({
          tenantId: tenant,
          textRefined: 'special root',
          status: 'active',
        });
        const other = await facts.create({
          tenantId: tenant,
          textRefined: 'base successor',
          status: 'active',
          previousFactId: root.id,
          confidence: 0.9,
        });
        enableTenancy();
        await withTenant({ tenantId: tenant }, async () => {
          for (const latestOnly of [false, true]) {
            expect(
              (await special.browseCatalog('', { latestOnly })).map(
                (f) => f.id,
              ),
            ).toEqual([root.id]);
            expect(
              (
                await special.browseCatalog('', {
                  tenantId: tenant,
                  latestOnly,
                })
              ).map((f) => f.id),
            ).toEqual([root.id]);
          }
          vi.spyOn(special, 'semanticSearchIds').mockResolvedValue(
            [other, root].map((fact) => ({ id: fact.id!, similarity: 0.9 })),
          );
          expect(
            (
              await special.browseCatalog('special', {
                tenantId: tenant,
                latestOnly: false,
              })
            ).map((f) => f.id),
          ).toEqual([root.id]);
        });
      });

      it.each([
        false,
        true,
      ])('keeps Unicode fallback traversal on its tenant/global STI graph (active ambient: %s)', async (activeAmbient) => {
        const tenantA = randomUUID();
        const tenantB = randomUUID();
        const special = await CatalogSpecialFacts.create({ db });
        const root = await special.create({
          tenantId: tenantA,
          textRefined: '300K root',
          status: 'active',
          confidence: 0.1,
        });
        const global = await special.create({
          textRefined: 'Café global',
          status: 'active',
          confidence: 0.8,
        });
        const allowed = await special.create({
          tenantId: tenantA,
          textRefined: 'allowed leaf',
          status: 'pending',
          previousFactId: root.id,
          confidence: 0.5,
        });
        const foreign = await special.create({
          tenantId: tenantB,
          textRefined: 'foreign leaf',
          status: 'active',
          previousFactId: root.id,
          confidence: 0.99,
        });
        await facts.create({
          tenantId: tenantA,
          textRefined: 'wrong subtype',
          status: 'active',
          previousFactId: root.id,
          confidence: 1,
        });
        vi.spyOn(special, 'semanticSearchIds').mockRejectedValue(
          new Error('Embeddings unavailable'),
        );
        enableTenancy();
        const query = vi.spyOn(db, 'query');
        if (activeAmbient) {
          await withTenant({ tenantId: tenantA }, async () => {
            expect(
              (await special.browseCatalog('É', { tenantId: tenantA })).map(
                (f) => f.id,
              ),
            ).toEqual([global.id]);
          });
        } else {
          const results = await special.browseCatalog('k', {
            tenantId: tenantA,
          });
          expect(results.map((f) => f.id)).toEqual([allowed.id]);
          expect(results.map((f) => f.id)).not.toContain(foreign.id);
        }
        const dataReads = query.mock.calls.filter(
          ([sql]) =>
            String(sql).includes('FROM facts') &&
            !String(sql).startsWith('DESCRIBE'),
        );
        expect(dataReads).toHaveLength(2); // readiness aggregate + bounded page
        await withTenant({ tenantId: tenantA }, async () => {
          await expect(
            special.browseCatalog('k', { tenantId: tenantB }),
          ).rejects.toThrow();
        });
      });

      it('keeps the full implicit fallback graph despite collection list defaults', async () => {
        const special = await CatalogSpecialFacts.create({
          db,
          defaultListLimit: 1,
        });
        const root = await special.create({
          textRefined: '300K root',
          status: 'active',
        });
        const leaf = await special.create({
          textRefined: 'old successor',
          status: 'pending',
          previousFactId: root.id,
        });
        await db.query(
          'UPDATE facts SET updated_at = ? WHERE id = ?',
          '2026-01-01T00:00:00.000Z',
          leaf.id,
        );
        await db.query(
          'UPDATE facts SET updated_at = ? WHERE id = ?',
          '2026-02-01T00:00:00.000Z',
          root.id,
        );
        vi.spyOn(special, 'semanticSearchIds').mockRejectedValue(
          new Error('Embeddings unavailable'),
        );
        expect((await special.browseCatalog('k')).map((f) => f.id)).toEqual([
          leaf.id,
        ]);
      });

      it('fetches only one Fact row for a real scoped semantic page at a large offset', async () => {
        vi.spyOn(EmbeddingProvider.prototype, 'embed').mockResolvedValue([
          [1, 0],
        ]);
        vi.spyOn(EmbeddingProvider.prototype, 'getModelName').mockReturnValue(
          'catalog-test',
        );
        const tenantA = randomUUID();
        const tenantB = randomUUID();
        const special = await CatalogSpecialFacts.create({ db });
        const ranked: Fact[] = [];
        for (let index = 0; index < 75; index++) {
          const fact = await special.create({
            tenantId: index === 0 ? null : tenantA,
            textRefined: `ranked ${index}`,
            status: index === 0 ? 'pending' : 'active',
          });
          ranked.push(fact);
          await EmbeddingStorage.upsert(special.systemDb, {
            objectClass: 'CatalogSpecialFact',
            objectId: fact.id!,
            fieldName: 'textRefined',
            contentHash: `rank-${index}`,
            embedding: [1, index / 200],
            model: 'catalog-test',
            dimensions: 2,
          });
        }
        const foreign = await special.create({
          tenantId: tenantB,
          textRefined: 'foreign',
          status: 'active',
        });
        await EmbeddingStorage.upsert(special.systemDb, {
          objectClass: 'CatalogSpecialFact',
          objectId: foreign.id!,
          fieldName: 'textRefined',
          contentHash: 'foreign',
          embedding: [1, 0],
          model: 'catalog-test',
          dimensions: 2,
        });
        const probe = await withSystemContext(() =>
          special.semanticSearchIds('semantic', {
            limit: 70,
            where: [[{ tenantId: tenantA }], [{ tenantId: null }]],
          }),
        );
        expect(probe).toHaveLength(70);
        enableTenancy();
        await withTenant({ tenantId: tenantA }, async () => {
          const query = vi.spyOn(db, 'query');
          const page = await special.browseCatalog('semantic', {
            tenantId: tenantA,
            latestOnly: false,
            offset: 69,
            limit: 1,
          });
          expect(page.map((fact) => fact.id)).toEqual([ranked[69].id]);
          expect(
            (page[0] as Fact & { _similarity: number })._similarity,
          ).toBeGreaterThan(0.8);
          let fetchedFacts = 0;
          for (let index = 0; index < query.mock.calls.length; index++) {
            const sql = String(query.mock.calls[index][0]);
            if (!sql.includes('FROM facts') || sql.startsWith('DESCRIBE'))
              continue;
            const result = await query.mock.results[index].value;
            // Eligibility masks and readiness aggregates are scalar metadata;
            // no source Fact ID or Fact field may escape in those responses.
            fetchedFacts += result.rows.filter(
              (row: Record<string, unknown>) => 'id' in row,
            ).length;
          }
          expect(fetchedFacts).toBe(1);
          query.mockRestore();
          expect(
            (
              await special.browseCatalog('semantic', {
                tenantId: tenantA,
                latestOnly: false,
                limit: 1,
              })
            ).map((fact) => fact.id),
          ).toEqual([ranked[0].id]);
          await expect(
            special.browseCatalog('semantic', { tenantId: tenantB }),
          ).rejects.toThrow();
        });
      });

      it('orders double-digit semantic ranks numerically', async () => {
        const ranked = [];
        for (let index = 0; index < 12; index++) {
          ranked.push(
            await facts.create({
              textRefined: `rank ${index}`,
              status: 'active',
            }),
          );
        }
        vi.spyOn(facts, 'semanticSearchIds').mockResolvedValue(
          ranked.map((fact) => ({ id: fact.id!, similarity: 0.9 })),
        );
        const page = await facts.browseCatalog('ranked', {
          latestOnly: false,
          limit: 12,
        });
        expect(page.map((f) => f.id)).toEqual(ranked.map((f) => f.id));
      });

      it('preserves ranked semantic pages and filters candidates before hydration', async () => {
        const tenantA = randomUUID();
        const tenantB = randomUUID();
        const a = await facts.create({
          tenantId: tenantA,
          textRefined: 'a',
          status: 'active',
        });
        const b = await facts.create({
          tenantId: tenantA,
          textRefined: 'b',
          status: 'active',
        });
        const foreign = await facts.create({
          tenantId: tenantB,
          textRefined: 'foreign',
          status: 'active',
        });
        vi.spyOn(facts, 'semanticSearchIds').mockResolvedValue(
          [a, foreign, b].map((fact) => ({ id: fact.id!, similarity: 0.9 })),
        );
        enableTenancy();
        await withTenant({ tenantId: tenantA }, async () => {
          const query = vi.spyOn(db, 'query');
          const page = await facts.browseCatalog('match', {
            tenantId: tenantA,
            latestOnly: false,
            limit: 1,
            offset: 1,
          });
          for (const result of query.mock.results) {
            if (result.type === 'return') {
              await result.value;
            }
          }
          expect(page.map((f) => f.id)).toEqual([b.id]);
          const calls = query.mock.calls.filter(([sql]) =>
            String(sql).includes('catalog_candidates'),
          );
          // DuckDB's canonical hydration adds DESCRIBE before the data query.
          expect(calls).toHaveLength(dialect === 'duckdb' ? 2 : 1);
          expect(calls[0][0]).toContain('LIMIT ? OFFSET ?');
          for (const [index, [sql]] of query.mock.calls.entries()) {
            if (
              String(sql).includes('catalog_candidates') &&
              !String(sql).startsWith('DESCRIBE')
            ) {
              expect((await query.mock.results[index].value).rows).toHaveLength(
                1,
              );
            }
          }
          const latest = await facts.browseCatalog('match', {
            tenantId: tenantA,
            limit: 1,
            offset: 1,
          });
          expect(latest.map((f) => f.id)).toEqual([b.id]);
        });
      });
    },
  );
}
