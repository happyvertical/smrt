import { randomUUID } from 'node:crypto';
import {
  EmbeddingProvider,
  getTestDatabase,
  ObjectRegistry,
} from '@happyvertical/smrt-core';
import {
  generateSchemaDiff,
  getSQLFromDiff,
} from '@happyvertical/smrt-core/migrations';
import { getDDLStrategy } from '@happyvertical/smrt-core/schema';
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
import { FactSourceCollection } from '../fact-sources';
import { FactCollection } from '../facts';

let tenantId: string;
const otherTenant = '10000000-0000-4000-8000-000000000002';

for (const dialect of ['sqlite', 'postgres'] as const) {
  describe.skipIf(dialect === 'postgres' && !isPostgresAvailable())(
    `reconciliation scope on ${dialect} (#3496)`,
    () => {
      let db: DatabaseInterface;
      let cleanup: () => Promise<void>;
      let facts: FactCollection;
      beforeEach(async () => {
        tenantId = randomUUID();
        if (dialect === 'postgres') {
          const isolated = await createIsolatedTestDbFromManifest({
            includeObjects: ['Fact', 'FactSource'],
          });
          db = isolated.baseDb;
          cleanup = isolated.cleanup;
        } else {
          db = await getTestDatabase({
            type: 'sqlite',
            url: ':memory:',
            classes: ['Fact', 'FactSource'],
          });
          cleanup = async () => {
            await db.close?.();
          };
        }
        vi.spyOn(EmbeddingProvider.prototype, 'embed').mockImplementation(
          async (input) =>
            (Array.isArray(input) ? input : [input]).map((text) =>
              text.includes('eligible') ? [0.8, 0.6] : [1, 0],
            ),
        );
        vi.spyOn(EmbeddingProvider.prototype, 'getModelName').mockReturnValue(
          'scope-test',
        );
        vi.spyOn(EmbeddingProvider.prototype, 'getDimensions').mockReturnValue(
          2,
        );
        facts = await FactCollection.create({ db });
      });
      afterEach(async () => {
        disableTenancy();
        vi.restoreAllMocks();
        await cleanup?.();
      });

      it('separates identical claims by scope and tenant; repeats converge with isolated provenance', async () => {
        const privateResult = await facts.reconcile({
          rawInput: 'Council approved the plan',
          tenantId,
          accessScope: 'private',
          source: { sourceTitle: 'private memo' },
        });
        const publicResult = await facts.reconcile({
          rawInput: 'Council approved the plan',
          tenantId,
          accessScope: 'public',
          source: { sourceTitle: 'public minutes' },
        });
        const repeat = await facts.reconcile({
          rawInput: ' council APPROVED the plan ',
          tenantId,
          accessScope: 'public',
        });
        const other = await facts.reconcile({
          rawInput: 'Council approved the plan',
          tenantId: otherTenant,
          accessScope: 'public',
        });
        expect(publicResult.action).toBe('created');
        expect(publicResult.fact.id).not.toBe(privateResult.fact.id);
        expect(repeat.fact.id).toBe(publicResult.fact.id);
        expect(other.fact.id).not.toBe(publicResult.fact.id);
        const sources = await FactSourceCollection.create({ db });
        expect(
          (await sources.list({ where: { factId: publicResult.fact.id } })).map(
            (s) => s.sourceTitle,
          ),
        ).toEqual(['public minutes']);
        expect(
          (
            await facts.list({ where: { tenantId, accessScope: 'public' } })
          ).map((f) => f.id),
        ).toEqual([publicResult.fact.id]);
      });

      it('filters private high scores before ranking and before AI sees candidate text', async () => {
        for (let index = 0; index < 6; index++) {
          const hidden = await facts.create({
            textRefined: `secret ${index}`,
            tenantId,
            accessScope: 'private',
            status: 'active',
          });
          await hidden.generateEmbeddings();
        }
        const eligible = await facts.create({
          textRefined: 'eligible public statement',
          tenantId,
          accessScope: 'public',
          status: 'active',
        });
        await eligible.generateEmbeddings();
        const disambiguate = vi
          .spyOn(FactCollection.prototype as any, '_disambiguateWithAI')
          .mockResolvedValue('merge');
        const result = await facts.reconcile({
          rawInput: 'new wording',
          tenantId,
          accessScope: 'public',
        });
        expect(result.action).toBe('merged');
        expect(result.fact.id).toBe(eligible.id);
        expect(disambiguate).toHaveBeenCalledTimes(1);
        expect(disambiguate.mock.calls[0][1].textRefined).toBe(
          'eligible public statement',
        );
      });

      it('keeps legacy NULL separate in both directions, without classifying old metadata', async () => {
        const legacy = await facts.reconcile({
          rawInput: 'A legacy assertion',
          tenantId,
          source: { metadata: { accessScope: 'public' } },
        });
        const scoped = await facts.reconcile({
          rawInput: 'A legacy assertion',
          tenantId,
          accessScope: 'public',
        });
        const omitted = await facts.reconcile({
          rawInput: 'A legacy assertion',
          tenantId,
        });
        const explicitNull = await facts.reconcile({
          rawInput: 'A legacy assertion',
          tenantId,
          accessScope: null,
        });
        expect(scoped.fact.id).not.toBe(legacy.fact.id);
        expect(omitted.fact.id).toBe(legacy.fact.id);
        expect(explicitNull.fact.id).toBe(legacy.fact.id);
        expect(legacy.fact.accessScope).toBeNull();
      });

      it('propagates scope through branches and rejects a cross-scope branch', async () => {
        const original = await facts.create({
          textRefined: 'eligible prior assertion',
          tenantId,
          accessScope: 'public',
          status: 'active',
        });
        await original.generateEmbeddings();
        vi.spyOn(
          FactCollection.prototype as any,
          '_disambiguateWithAI',
        ).mockResolvedValue('branch');
        const result = await facts.reconcile({
          rawInput: 'corrected assertion',
          tenantId,
          accessScope: 'public',
        });
        expect(result.action).toBe('branched');
        expect(result.fact.accessScope).toBe('public');
        expect(result.fact.previousFactId).toBe(original.id);
        await expect(
          facts.branch(result.fact.id as string, {
            textRefined: 'private successor',
            accessScope: 'private',
          }),
        ).rejects.toThrow('accessScope');
        const inherited = await facts.branch(result.fact.id as string, {
          textRefined: 'public successor',
          tenantId,
        });
        expect(inherited.accessScope).toBe('public');
      });

      it('preserves PostgreSQL rollback and SQLite convergent retry after source failure', async () => {
        const create = vi
          .spyOn(FactSourceCollection.prototype, 'create')
          .mockRejectedValueOnce(new Error('source failure'));
        const input = {
          rawInput: 'Retry assertion',
          tenantId,
          accessScope: 'public',
          source: { sourceTitle: 'minutes' },
        };
        await expect(facts.reconcile(input)).rejects.toThrow('source failure');
        expect(
          await facts.list({ where: { tenantId, accessScope: 'public' } }),
        ).toHaveLength(dialect === 'postgres' ? 0 : 1);
        create.mockRestore();
        const result = await facts.reconcile(input);
        expect(result.action).toBe(
          dialect === 'postgres' ? 'created' : 'merged',
        );
        expect(
          await facts.list({ where: { tenantId, accessScope: 'public' } }),
        ).toHaveLength(1);
      });

      it('respects active tenant context and rejects foreign tenant requests', async () => {
        enableTenancy();
        await withTenant({ tenantId }, async () => {
          const result = await facts.reconcile({
            rawInput: 'Authorized assertion',
            accessScope: 'public',
          });
          expect(result.fact.tenantId).toBe(tenantId);
          await expect(
            facts.reconcile({
              rawInput: 'Forbidden assertion',
              tenantId: otherTenant,
              accessScope: 'public',
            }),
          ).rejects.toThrow();
        });
      });

      it('converges concurrent same-scope retries without joining different scopes', async () => {
        const input = {
          rawInput: 'Concurrent scoped assertion',
          tenantId,
          accessScope: 'public',
        };
        const [first, second, privateResult] = await Promise.all([
          facts.reconcile(input),
          facts.reconcile(input),
          facts.reconcile({ ...input, accessScope: 'private' }),
        ]);
        expect(first.fact.id).toBe(second.fact.id);
        expect(privateResult.fact.id).not.toBe(first.fact.id);
        expect(await facts.count({ where: { tenantId } })).toBe(2);
      });

      it('migrates historical rows to NULL without inferring public visibility', async () => {
        const tableName = `scope_migration_${randomUUID().replaceAll('-', '')}`;
        const definition = ObjectRegistry.getAllSchemasAsDefinitions().facts;
        const expected = {
          ...definition,
          tableName,
          indexes: [],
          foreignKeys: [],
          columns: Object.fromEntries(
            Object.entries(definition.columns).map(([name, column]) => [
              name,
              { ...column, foreignKey: undefined },
            ]),
          ),
        };
        const historical = {
          ...expected,
          columns: Object.fromEntries(
            Object.entries(expected.columns).filter(
              ([name]) => name !== 'access_scope',
            ),
          ),
        };
        await db.query(getDDLStrategy(dialect).generateCreateTable(historical));
        try {
          await db.query(
            `INSERT INTO ${tableName} (id, slug, _meta_type, text_refined, text_raw) VALUES (?, ?, ?, ?, ?)`,
            randomUUID(),
            'legacy',
            '@happyvertical/smrt-facts:Fact',
            'legacy private text',
            'legacy private text',
          );
          const diff = await generateSchemaDiff(
            db,
            { [tableName]: expected },
            { engineHint: dialect },
          );
          const additions = getSQLFromDiff(diff).filter((sql) =>
            /ADD COLUMN.*access_scope/i.test(sql),
          );
          expect(additions).toHaveLength(1);
          await db.query(additions[0]);
          const { rows } = await db.query(
            `SELECT text_refined, access_scope FROM ${tableName}`,
          );
          expect(rows).toEqual([
            { text_refined: 'legacy private text', access_scope: null },
          ]);
        } finally {
          await db.query(`DROP TABLE ${tableName}`);
        }
      });

      it('rejects malformed scope before provider calls or writes', async () => {
        const embed = vi.mocked(EmbeddingProvider.prototype.embed);
        for (const accessScope of [
          '',
          ' ',
          'bad\u0000scope',
          '\ud800',
          'x'.repeat(257),
          42,
        ]) {
          await expect(
            facts.reconcile({
              rawInput: 'assertion',
              tenantId,
              accessScope: accessScope as string,
            }),
          ).rejects.toThrow('accessScope');
        }
        expect(embed).not.toHaveBeenCalled();
        expect(await facts.count({ where: { tenantId } })).toBe(0);
      });
    },
  );
}
