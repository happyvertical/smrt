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

const tableSuffix = randomUUID().replaceAll('-', '').slice(0, 12);
const tableName = `issue_2890_widget_${tableSuffix}`;

// Called as plain functions (not `@decorator` syntax): this package's own
// `tsconfig.json` does not enable `experimentalDecorators` (unlike the root
// tsconfig every other consumer builds against via `smrtVitestPlugin`'s oxc
// config), matching the pattern the sibling #2429/#2427 optional tests use
// for `smrt()`.
class Issue2890Widget extends SmrtObject {
  name: string = '';
  quantity: number = 0;
}
field({ type: 'text' })(Issue2890Widget.prototype, 'name');
field({ type: 'integer' })(Issue2890Widget.prototype, 'quantity');
smrt({ tableName })(Issue2890Widget);

/**
 * Counts every query the real `pg` driver issues, by wrapping
 * `pg.Client.prototype.query`.
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
  restore: () => void;
}> {
  const sqlEntry = await import.meta.resolve('@happyvertical/sql');
  const require = createRequire(sqlEntry);
  const pg = require('pg') as {
    Client: { prototype: { query: (...args: unknown[]) => unknown } };
  };
  const original = pg.Client.prototype.query;
  let count = 0;
  pg.Client.prototype.query = function patchedQuery(
    this: unknown,
    ...args: unknown[]
  ) {
    count += 1;
    return original.apply(this, args as never);
  };
  return {
    count: () => count,
    restore: () => {
      pg.Client.prototype.query = original;
    },
  };
}

postgresDescribe(
  'PostgreSQL vitest auto-schema precheck skips fully-provisioned tables (#2890)',
  () => {
    afterAll(async () => {
      const admin = await getDatabase({
        type: 'postgres',
        url: process.env.DATABASE_URL as string,
        __smrtSkipVitestSchemaPreparation: true,
      } as Parameters<typeof getDatabase>[0] & {
        __smrtSkipVitestSchemaPreparation: boolean;
      });
      try {
        await admin.query(`DROP TABLE IF EXISTS "${tableName}"`);
      } finally {
        await admin.close();
      }
    });

    it('issues a small, constant number of statements against an already-provisioned table, and still repairs a dropped column', async () => {
      const baseUrl = process.env.DATABASE_URL as string;

      // First handle: provisions the table (goes through the full
      // `syncSchema` path since the table does not exist yet).
      const first = await getDatabase({ type: 'postgres', url: baseUrl });
      expect(await first.tableExists(tableName)).toBe(true);

      // Second handle: a distinct `dbid` against the SAME already-provisioned
      // database bypasses both `preparedSchemasByDb` (a fresh connection
      // object) and `preparedSchemasByConfig` (a different cache key), so the
      // precheck itself -- not the pre-existing cache -- is what is under
      // test here.
      const counter = await countPgQueries();
      const second = await getDatabase({
        type: 'postgres',
        url: baseUrl,
        dbid: `issue-2890-second-${tableSuffix}`,
      } as Parameters<typeof getDatabase>[0] & { dbid: string });
      const statementsForProvisionedHandle = counter.count();
      counter.restore();

      expect(await second.tableExists(tableName)).toBe(true);
      // Two precheck round trips (columns + indexes) plus a handful of
      // framework-owned system-table checks/opens the mocked getDatabase
      // performs regardless -- nowhere near one probe per declared column
      // across every registered class, which is what reproduced #2890.
      expect(statementsForProvisionedHandle).toBeGreaterThan(0);
      expect(statementsForProvisionedHandle).toBeLessThan(40);

      // Drift is still repaired: drop a column with raw SQL, then obtain
      // another fresh handle and confirm the column comes back.
      await first.query(`ALTER TABLE "${tableName}" DROP COLUMN "quantity"`);

      const third = await getDatabase({
        type: 'postgres',
        url: baseUrl,
        dbid: `issue-2890-third-${tableSuffix}`,
      } as Parameters<typeof getDatabase>[0] & { dbid: string });
      const columnRows = await third.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = $1 AND column_name = 'quantity'`,
        [tableName],
      );
      const rows = Array.isArray(columnRows)
        ? columnRows
        : ((columnRows as { rows?: unknown[] }).rows ?? []);
      expect(rows).toHaveLength(1);
    });
  },
);
