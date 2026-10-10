import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { preferenceKindsSuite } from './kinds-suite.js';

for (const type of ['sqlite', 'duckdb'] as const) {
  let db: DatabaseInterface | undefined;
  preferenceKindsSuite(
    `preference kinds (${type})`,
    async () => {
      // DuckDB cannot create smrt-users' ON UPDATE CASCADE foreign keys, so
      // that engine builds only this package's table (the store authorizes
      // from the principal's permission set and never reads the RBAC tables).
      db = await getTestDatabase({
        type,
        url: ':memory:',
        ...(type === 'duckdb' ? { classes: ['UiPreferenceRecord'] } : {}),
      });
      return db;
    },
    async () => {
      await db?.close?.();
      db = undefined;
    },
  );
}
