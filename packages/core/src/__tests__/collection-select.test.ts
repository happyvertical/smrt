import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { foreignKey, SmrtObject, smrt } from '../index.js';
import { GlobalInterceptors } from '../interceptors.js';
import { getTestDatabase } from '../testing/database.js';

@smrt()
class ProjectionAccount extends SmrtObject {
  name: string = '';
}

class ProjectionAccountCollection extends SmrtCollection<ProjectionAccount> {
  static readonly _itemClass = ProjectionAccount;
}

@smrt()
class ProjectionOpportunity extends SmrtObject {
  title: string = '';
  status: string = '';
  priority: number = 0;

  @foreignKey('ProjectionAccount')
  accountId: string = '';
}

class ProjectionOpportunityCollection extends SmrtCollection<ProjectionOpportunity> {
  static readonly _itemClass = ProjectionOpportunity;
}

const adapterConfigs = [
  {
    name: 'SQLite',
    type: 'sqlite' as const,
    makeUrl: () => ':memory:',
    cleanup: async () => {},
  },
  {
    name: 'DuckDB',
    type: 'duckdb' as const,
    makeUrl: () => ':memory:',
    cleanup: async () => {},
  },
  {
    name: 'JSON (DuckDB)',
    type: 'json' as const,
    makeUrl: () =>
      join(tmpdir(), `test-collection-select-json-${randomUUID().slice(0, 8)}`),
    cleanup: async (url: string) => {
      if (existsSync(url)) {
        rmSync(url, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'SQLite (file)',
    type: 'sqlite' as const,
    makeUrl: () =>
      join(tmpdir(), `test-collection-select-${randomUUID().slice(0, 8)}.db`),
    cleanup: async (url: string) => {
      if (existsSync(url)) {
        unlinkSync(url);
      }
    },
  },
];

describe('SmrtCollection.list({ select })', () => {
  adapterConfigs.forEach((adapterConfig) => {
    describe(adapterConfig.name, () => {
      let db: DatabaseInterface;
      let dbUrl: string;
      let accounts: ProjectionAccountCollection;
      let opportunities: ProjectionOpportunityCollection;

      beforeEach(async () => {
        dbUrl = adapterConfig.makeUrl();
        db = await getTestDatabase({
          type: adapterConfig.type,
          url: dbUrl,
          classes: ['ProjectionAccount', 'ProjectionOpportunity'],
        });
        accounts = await ProjectionAccountCollection.create({ db });
        opportunities = await ProjectionOpportunityCollection.create({ db });
      });

      afterEach(async () => {
        if (db && typeof db.close === 'function') {
          await db.close();
        }
        await adapterConfig.cleanup(dbUrl);
      });

      async function seedOpportunities() {
        const account = await accounts.create({ name: 'Acme' });
        const otherAccount = await accounts.create({ name: 'Globex' });

        await opportunities.create({
          title: 'Low priority',
          status: 'open',
          priority: 10,
          accountId: account.id,
        });
        await opportunities.create({
          title: 'Closed priority',
          status: 'closed',
          priority: 40,
          accountId: otherAccount.id,
        });
        await opportunities.create({
          title: 'High priority',
          status: 'open',
          priority: 30,
          accountId: account.id,
        });
        await opportunities.create({
          title: 'Medium priority',
          status: 'open',
          priority: 20,
          accountId: otherAccount.id,
        });

        return { account, otherAccount };
      }

      it('returns selected SMRT field names without hydrating objects', async () => {
        const { account, otherAccount } = await seedOpportunities();
        const queries: string[] = [];
        const originalQuery = db.query.bind(db);
        db.query = (async (sql: string, ...params: unknown[]) => {
          queries.push(sql);
          return originalQuery(sql, ...params);
        }) as DatabaseInterface['query'];

        const rows = await opportunities.list({
          select: ['id', 'title', 'accountId'] as const,
          where: { status: 'open' },
          orderBy: 'priority DESC',
          offset: 1,
          limit: 2,
        });

        expect(rows).toHaveLength(2);
        expect(rows[0]).not.toBeInstanceOf(ProjectionOpportunity);
        expect(Object.keys(rows[0]).sort()).toEqual([
          'accountId',
          'id',
          'title',
        ]);
        expect(rows.map((row) => row.title)).toEqual([
          'Medium priority',
          'Low priority',
        ]);
        expect(rows.map((row) => row.accountId)).toEqual([
          otherAccount.id,
          account.id,
        ]);

        const projectionSql = queries.find((sql) =>
          sql.includes(`FROM ${opportunities.tableName}`),
        );
        expect(projectionSql).toContain(
          'SELECT "id" AS "id", "title" AS "title", "account_id" AS "accountId"',
        );
        expect(projectionSql).not.toContain('SELECT *');
      });

      it('supports id-only page key rows', async () => {
        await seedOpportunities();

        const rows = await opportunities.list({
          select: ['id'] as const,
          where: { status: 'open' },
          orderBy: 'priority ASC',
          limit: 1,
        });

        expect(rows).toHaveLength(1);
        expect(Object.keys(rows[0])).toEqual(['id']);
        expect(rows[0].id).toEqual(expect.any(String));
        expect(rows[0]).not.toBeInstanceOf(ProjectionOpportunity);
      });

      it('still applies beforeList interceptors before projecting rows', async () => {
        await seedOpportunities();
        GlobalInterceptors.register({
          name: 'collection-select-test',
          beforeList(_className, options) {
            return {
              ...options,
              where: {
                ...options.where,
                status: 'closed',
              },
            };
          },
        });

        try {
          const rows = await opportunities.list({
            select: ['title'] as const,
            where: { status: 'open' },
          });

          expect(rows).toEqual([{ title: 'Closed priority' }]);
        } finally {
          GlobalInterceptors.unregister('collection-select-test');
        }
      });

      it('rejects unknown projection fields clearly', async () => {
        await expect(
          opportunities.list({
            select: ['missingField'] as any,
          }),
        ).rejects.toThrow("Invalid select field: 'missingField'");
      });

      it('rejects relationship eager loading on projection rows', async () => {
        await expect(
          opportunities.list({
            select: ['id'] as const,
            include: ['accountId'] as never,
          }),
        ).rejects.toThrow('cannot eager-load relationships');
      });
    });
  });
});
