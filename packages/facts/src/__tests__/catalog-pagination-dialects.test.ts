import { randomUUID } from 'node:crypto';
import { getTestDatabase, smrt } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Fact } from '../fact';
import { FactCollection } from '../facts';

@smrt()
class CatalogSpecialFact extends Fact {}

class CatalogSpecialFacts extends FactCollection {
  static readonly _itemClass = CatalogSpecialFact;
}

for (const dialect of ['sqlite', 'duckdb', 'postgres'] as const) {
  describe.skipIf(dialect === 'postgres' && !isPostgresAvailable())(
    `catalog pagination on ${dialect}${dialect === 'duckdb' ? ' (SQL-only fixture; canonical self-FK blocked)' : ''}`,
    () => {
      let db: DatabaseInterface;
      let facts: FactCollection;
      let cleanup: () => Promise<void>;
      beforeEach(async () => {
        if (dialect === 'postgres') {
          const isolated = await createIsolatedTestDbFromManifest({
            includeObjects: ['Fact'],
          });
          db = isolated.db;
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
          vi.spyOn(special, 'semanticSearch').mockResolvedValue([other, root]);
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
        vi.spyOn(facts, 'semanticSearch').mockResolvedValue(ranked);
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
        vi.spyOn(facts, 'semanticSearch').mockResolvedValue([a, foreign, b]);
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
