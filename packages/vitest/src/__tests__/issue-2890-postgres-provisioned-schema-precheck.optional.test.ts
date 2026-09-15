/**
 * PostgreSQL automatic-schema-preparation precheck for issue #2890.
 *
 * `setup.ts`'s mocked `getDatabase()` used to hand `syncSchema` one batch
 * per registered `@smrt()` class on every NEW database handle, and
 * `@happyvertical/sql`'s PostgreSQL `syncSchema` issues one `SELECT EXISTS`
 * round trip per declared column for a table that already exists. A test
 * database cloned from an already-provisioned template (a per-test database
 * name defeats the connection-URL-keyed `preparedSchemasByConfig` cache) paid
 * that full per-column probe cost on every single `getDatabase()` call.
 *
 * This file imports `../setup.js` directly (rather than relying on this
 * package's own `vitest.config.ts`, which does not wire `setup.ts` in as a
 * `setupFiles` entry for its own suite) so the `vi.mock('@happyvertical/sql')`
 * it declares is registered for this test file's module graph, exactly as it
 * would be for a real consumer that lists `@happyvertical/smrt-vitest/setup`.
 *
 * @see https://github.com/happyvertical/smrt/issues/2890
 */

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import '../setup.js';
import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, describe, expect, it } from 'vitest';

const postgresDescribe = process.env.SMRT_TEST_POSTGRES_URL
  ? describe.sequential
  : describe.skip;

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const wideTableName = `issue_2890_wide_${suffix}`;
const alphaTableName = `issue_2890_alpha_${suffix}`;
const betaTableName = `issue_2890_beta_${suffix}`;
const gammaTableName = `issue_2890_gamma_${suffix}`;

// Called as plain functions (not `@decorator` syntax): this package's own
// `tsconfig.json` does not enable `experimentalDecorators` (unlike the root
// tsconfig every other consumer builds against via `smrtVitestPlugin`'s oxc
// config), matching the pattern the sibling #2429/#2427 optional tests use
// for `smrt()`.
//
// One table carries a large number of explicitly declared columns, and
// three more small tables are registered alongside it, so the assertions
// below are discriminating: the pre-#2890 implementation issues at least one
// `SELECT EXISTS` probe against `information_schema.columns` per declared
// column per table on every `getDatabase()` call, so a handful of columns on
// a single class would stay well under any reasonable statement-count
// threshold on BOTH the old and new code paths and prove nothing. This
// registers `WIDE_COLUMN_COUNT` (30) columns on one class alone, so the
// pre-fix statement count for a second, already-provisioned handle must be
// at least 30 -- the post-fix assertions below require it to be strictly
// less than that.
const WIDE_COLUMN_COUNT = 30;
const wideColumnNames = Array.from(
  { length: WIDE_COLUMN_COUNT },
  (_, i) => `w${i}`,
);

class Issue2890WideWidget extends SmrtObject {}
for (const columnName of wideColumnNames) {
  field({ type: 'text' })(Issue2890WideWidget.prototype, columnName);
}
smrt({ tableName: wideTableName })(Issue2890WideWidget);

class Issue2890Alpha extends SmrtObject {}
field({ type: 'text' })(Issue2890Alpha.prototype, 'label');
field({ type: 'integer' })(Issue2890Alpha.prototype, 'count');
smrt({ tableName: alphaTableName })(Issue2890Alpha);

class Issue2890Beta extends SmrtObject {}
field({ type: 'text' })(Issue2890Beta.prototype, 'label');
field({ type: 'boolean' })(Issue2890Beta.prototype, 'active');
smrt({ tableName: betaTableName })(Issue2890Beta);

class Issue2890Gamma extends SmrtObject {}
field({ type: 'text' })(Issue2890Gamma.prototype, 'label');
smrt({ tableName: gammaTableName })(Issue2890Gamma);

const allTableNames = [
  wideTableName,
  alphaTableName,
  betaTableName,
  gammaTableName,
];

/**
 * Counts every query the real `pg` driver issues, by wrapping
 * `pg.Client.prototype.query`, and records each statement's SQL text so
 * callers can assert on *which* statements ran, not just how many.
 *
 * `pg` is not a declared dependency of `@happyvertical/smrt-vitest` (this
 * package only depends on `@happyvertical/sql`, which depends on `pg`
 * itself), and under pnpm's strict isolation neither
 * `packages/vitest/node_modules/pg` nor the workspace root's `node_modules/pg`
 * is guaranteed to exist for this package to `require`/`import` directly —
 * confirmed with `node -e "console.log(require.resolve('pg'))"` from
 * `packages/vitest`, which fails with `MODULE_NOT_FOUND`. Resolving through
 * `@happyvertical/sql`'s own resolved location instead walks pnpm's sibling
 * `node_modules` the same way `@happyvertical/sql`'s internal `import('pg')`
 * does, so this reaches the exact module instance
 * `actual.getDatabase()`/`actual.syncSchema()` use. `@happyvertical/sql`'s
 * `package.json` `exports` map has no `./package.json` entry and no
 * CJS-resolvable bare `main`, so this resolves its real entry file via the
 * ESM-only `import.meta.resolve()` first (verified with the same `node -e`
 * probe: `await import.meta.resolve('@happyvertical/sql')` from
 * `packages/vitest`, then `createRequire(<that file>)('pg')`), and then
 * `createRequire()`s `pg` from that file's location.
 */
async function countPgQueries(): Promise<{
  count: () => number;
  statements: () => string[];
  restore: () => void;
}> {
  const sqlEntry = await import.meta.resolve('@happyvertical/sql');
  const require = createRequire(sqlEntry);
  const pg = require('pg') as {
    Client: { prototype: { query: (...args: unknown[]) => unknown } };
  };
  const original = pg.Client.prototype.query;
  const statements: string[] = [];
  pg.Client.prototype.query = function patchedQuery(
    this: unknown,
    ...args: unknown[]
  ) {
    const first = args[0];
    const text =
      typeof first === 'string'
        ? first
        : typeof first === 'object' && first !== null && 'text' in first
          ? String((first as { text: unknown }).text)
          : '';
    statements.push(text);
    return original.apply(this, args as never);
  };
  return {
    count: () => statements.length,
    statements: () => statements.slice(),
    restore: () => {
      pg.Client.prototype.query = original;
    },
  };
}

postgresDescribe(
  'PostgreSQL vitest auto-schema precheck skips fully-provisioned tables (#2890)',
  () => {
    const openHandles: Array<{ close: () => Promise<void> }> = [];

    async function openDb(
      options: Record<string, unknown>,
    ): Promise<Awaited<ReturnType<typeof getDatabase>>> {
      const db = await getDatabase(
        options as Parameters<typeof getDatabase>[0],
      );
      openHandles.push(db as unknown as { close: () => Promise<void> });
      return db;
    }

    afterAll(async () => {
      for (const handle of openHandles.splice(0)) {
        await handle.close();
      }

      const admin = await getDatabase({
        type: 'postgres',
        url: process.env.DATABASE_URL as string,
        __smrtSkipVitestSchemaPreparation: true,
      } as Parameters<typeof getDatabase>[0] & {
        __smrtSkipVitestSchemaPreparation: boolean;
      });
      try {
        for (const table of allTableNames) {
          await admin.query(`DROP TABLE IF EXISTS "${table}"`);
        }
      } finally {
        await admin.close();
      }
    });

    it('issues a small, constant number of statements against already-provisioned tables, and still repairs a dropped column', async () => {
      const baseUrl = process.env.DATABASE_URL as string;

      // First handle: provisions every table (goes through the full
      // `syncSchema` path since none of them exist yet).
      const first = await openDb({ type: 'postgres', url: baseUrl });
      for (const table of allTableNames) {
        expect(await first.tableExists(table)).toBe(true);
      }

      // Second handle: a distinct `dbid` against the SAME already-provisioned
      // database bypasses both `preparedSchemasByDb` (a fresh connection
      // object) and `preparedSchemasByConfig` (a different cache key), so the
      // precheck itself -- not the pre-existing cache -- is what is under
      // test here.
      const counter = await countPgQueries();
      const second = await openDb({
        type: 'postgres',
        url: baseUrl,
        dbid: `issue-2890-second-${suffix}`,
      });
      const statementCount = counter.count();
      const statements = counter.statements();
      counter.restore();

      for (const table of allTableNames) {
        expect(await second.tableExists(table)).toBe(true);
      }

      // Discriminating vs. the pre-#2890 implementation: `Issue2890WideWidget`
      // alone declares `WIDE_COLUMN_COUNT` (30) columns, so the old
      // per-column-per-table `SELECT EXISTS` probe would issue at least 30
      // statements for that one table alone on this second, already-
      // provisioned handle. The fixed precheck issues a small, table-count-
      // scaled number of statements (two round trips, batched across all
      // four tables) regardless of how many columns each table declares.
      expect(statementCount).toBeGreaterThan(0);
      expect(statementCount).toBeLessThan(WIDE_COLUMN_COUNT);
      expect(
        statements.some((sql) =>
          /SELECT\s+EXISTS[\s\S]*information_schema\.columns/i.test(sql),
        ),
      ).toBe(false);

      // Drift is still repaired: drop a column with raw SQL, then obtain
      // another fresh handle and confirm the column comes back.
      await first.query(`ALTER TABLE "${wideTableName}" DROP COLUMN "w0"`);

      const third = await openDb({
        type: 'postgres',
        url: baseUrl,
        dbid: `issue-2890-third-${suffix}`,
      });
      const columnRows = await third.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = $1 AND column_name = 'w0'`,
        [wideTableName],
      );
      const rows = Array.isArray(columnRows)
        ? columnRows
        : ((columnRows as { rows?: unknown[] }).rows ?? []);
      expect(rows).toHaveLength(1);
    });
  },
);
