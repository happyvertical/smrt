/** Synthetic library request acceptance; see docs/development/query-layer-acceptance.md. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  disableTenancy,
  enableTenancy,
  withSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  getTestAdapter,
} from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { expect, it } from 'vitest';
import { FactCollection } from '../facts.js';

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tenantA = uuid(9001);
const tenantB = uuid(9002);

/** Observe the public SDK client so adapter metadata SQL is included. */
function observeStatements(db: DatabaseInterface) {
  const statements: string[] = [];
  const restore: Array<() => void> = [];
  const client = db.client;
  const record = (input: unknown) => {
    const sql =
      typeof input === 'string'
        ? input
        : (input as { text?: string; sql?: string });
    const text = typeof sql === 'string' ? sql : (sql?.text ?? sql?.sql);
    if (!text) throw new Error('Unrecognized driver statement');
    statements.push(text.replace(/\s+/g, ' ').trim());
  };
  const wrap = (
    target: any,
    key: string,
    transform: (original: (...args: any[]) => any) => (...args: any[]) => any,
  ) => {
    const original = target[key];
    target[key] = transform(original.bind(target));
    restore.push(() => {
      target[key] = original;
    });
  };
  if (typeof client.query === 'function') {
    wrap(client, 'query', (original) => (...args) => {
      record(args[0]);
      return original(...args);
    });
  } else if (typeof client.execute === 'function') {
    wrap(client, 'execute', (original) => (...args) => {
      record(args[0]);
      return original(...args);
    });
    for (const key of ['batch', 'executeMultiple']) {
      if (typeof client[key] === 'function') {
        wrap(client, key, () => () => {
          throw new Error(`Unexpected ${key} in read-only measured request`);
        });
      }
    }
  } else if (typeof client.prepare === 'function') {
    wrap(client, 'prepare', (original) => (...args) => {
      const statement = original(...args);
      return new Proxy(statement, {
        get(target, key) {
          const value = Reflect.get(target, key, target);
          if (typeof value !== 'function') return value;
          return (...bindings: unknown[]) => {
            if (['all', 'get', 'run', 'iterate'].includes(String(key)))
              record(args[0]);
            return value.apply(target, bindings);
          };
        },
      });
    });
    if (typeof client.exec === 'function') {
      wrap(client, 'exec', () => () => {
        throw new Error('Unexpected exec in read-only measured request');
      });
    }
  } else {
    throw new Error(
      'Unsupported SQL driver: cannot count every executed statement',
    );
  }
  return {
    statements,
    restore: () => {
      for (const undo of restore.reverse()) undo();
    },
  };
}

it.runIf(process.env.SMRT_QUERY_ACCEPTANCE === '1')(
  'measures a representative tenant library request with exact result parity (#2815)',
  async () => {
    if (
      getTestAdapter() === 'postgres' &&
      process.env.CI_POSTGRES_MANAGED !== '1'
    ) {
      throw new Error(
        'PostgreSQL acceptance requires a disposable database from run-with-ci-postgres.mjs',
      );
    }
    const isolated = await createIsolatedTestDbFromManifest({
      includeObjects: ['Fact'],
    });
    // End the bootstrap transaction: this representative page uses the normal
    // base connection on both revisions, rather than a transaction-bound handle.
    await isolated.db.rollback();
    const db = isolated.baseDb;
    let observer: ReturnType<typeof observeStatements> | undefined;
    enableTenancy();
    try {
      if (isolated.config.type === 'postgres') {
        const version = await db.query('SHOW server_version_num');
        expect(
          Math.floor(Number(version.rows[0].server_version_num) / 10_000),
        ).toBe(17);
      }
      const facts = await FactCollection.create({ db });
      await withSystemContext(async () => {
        for (let chain = 0; chain < 25; chain++) {
          for (let revision = 0; revision < 3; revision++) {
            const id = uuid(1 + chain * 3 + revision);
            await facts.create({
              id,
              slug: `library-${chain}-${revision}`,
              tenantId: tenantA,
              textRefined: `Library fact ${chain}, revision ${revision}`,
              status: revision === 2 ? 'active' : 'superseded',
              previousFactId: revision === 0 ? '' : uuid(chain * 3 + revision),
              confidence: 0.8 + revision * 0.05,
            });
            // Persisted revision timestamps are owned by save(); fix fixture
            // ordering explicitly after setup, outside the request window.
            await db.update(
              'facts',
              { id },
              {
                updated_at: new Date(
                  Date.UTC(2026, 0, 1, 0, chain, revision),
                ).toISOString(),
              },
            );
          }
        }
        await facts.create({
          id: uuid(8001),
          slug: 'foreign-library-fact',
          tenantId: tenantB,
          textRefined: 'Private tenant B fact',
          status: 'active',
          updatedAt: new Date('2026-02-01T00:00:00Z'),
        });
        await facts.create({
          id: uuid(8002),
          slug: 'global-library-fact',
          tenantId: null,
          textRefined: 'Global reference fact',
          status: 'active',
          updatedAt: new Date('2025-01-01T00:00:00Z'),
        });
      });
      // Both baseline and final expose ordered tenant-only browsing when the
      // active context supplies scope. Explicit findWithGlobals has no baseline order.
      const withGlobals = await withTenant({ tenantId: tenantA }, () =>
        facts.findWithGlobals(tenantA),
      );
      expect(withGlobals.some((row) => row.id === uuid(8002))).toBe(true);
      expect(withGlobals.some((row) => row.id === uuid(8001))).toBe(false);
      const observed = observeStatements(db);
      observer = observed;
      const measure = async <T>(operation: () => Promise<T>) => {
        const start = observed.statements.length;
        const result = await operation();
        const sql = observed.statements.slice(start);
        return { result, statementCount: sql.length, statements: sql };
      };
      const catalog = await measure(() =>
        withTenant({ tenantId: tenantA }, async () => {
          const rows = await facts.browseCatalog('', {
            limit: 25,
            latestOnly: true,
          });
          return rows.map((row) => ({
            id: row.id,
            textRefined: row.textRefined,
            tenantId: row.tenantId,
          }));
        }),
      );
      const expectedIds = Array.from({ length: 25 }, (_, index) =>
        uuid((25 - index) * 3),
      );
      expect(catalog.result.map((row) => row.id)).toEqual(expectedIds);
      expect(catalog.result.every((row) => row.tenantId === tenantA)).toBe(
        true,
      );
      const panels = await measure(() =>
        withTenant({ tenantId: tenantA }, () =>
          Promise.all(
            Array.from({ length: 3 }, () =>
              facts.list({
                select: ['id', 'textRefined', 'tenantId'],
                where: { status: 'active' },
                orderBy: 'updated_at DESC',
                limit: 25,
                cache: { ttl: 60_000 },
              }),
            ),
          ),
        ),
      );
      expect(panels.result[0]).toEqual(panels.result[1]);
      expect(panels.result[1]).toEqual(panels.result[2]);
      expect(panels.result[0].every((row) => row.tenantId === tenantA)).toBe(
        true,
      );
      expect(panels.result[0]).toHaveLength(25);
      const warmPanels = await measure(() =>
        withTenant({ tenantId: tenantA }, () =>
          facts.list({
            select: ['id', 'textRefined', 'tenantId'],
            where: { status: 'active' },
            orderBy: 'updated_at DESC',
            limit: 25,
            cache: { ttl: 60_000 },
          }),
        ),
      );
      expect(warmPanels.result).toEqual(panels.result[0]);
      expect(warmPanels.statementCount).toBe(0);
      await expect(
        withTenant({ tenantId: tenantA }, () =>
          facts.browseCatalog('', { tenantId: tenantB }),
        ),
      ).rejects.toThrow();
      expect(catalog.statementCount).toBeGreaterThan(0);
      expect(panels.statementCount).toBeGreaterThan(0);
      const report = {
        fixture: 'library-25-chains-v1',
        harnessSha256: createHash('sha256')
          .update(
            readFileSync(
              new URL('./query-layer-acceptance.test.ts', import.meta.url),
            ),
          )
          .digest('hex'),
        revision: execFileSync('git', ['rev-parse', 'HEAD'], {
          encoding: 'utf8',
        }).trim(),
        dialect: isolated.config.type,
        catalog,
        panels,
        warmPanels,
        totalRequestStatements: catalog.statementCount + panels.statementCount,
      };
      if (process.env.SMRT_QUERY_ACCEPTANCE_OUTPUT) {
        writeFileSync(
          process.env.SMRT_QUERY_ACCEPTANCE_OUTPUT,
          `${JSON.stringify(report, null, 2)}\n`,
        );
      }
      console.info(
        `QUERY_ACCEPTANCE ${JSON.stringify({ dialect: report.dialect, catalog: catalog.statementCount, panels: panels.statementCount, warmPanels: warmPanels.statementCount, total: report.totalRequestStatements })}`,
      );
    } finally {
      observer?.restore();
      disableTenancy();
      await isolated.cleanup();
    }
  },
  120_000,
);
