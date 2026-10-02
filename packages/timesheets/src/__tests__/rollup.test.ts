import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { rollupSuite } from './rollup-suite.js';

let db: DatabaseInterface;
rollupSuite(
  'period rollup (sqlite)',
  async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    return db;
  },
  async () => {
    await db.close?.();
  },
);
