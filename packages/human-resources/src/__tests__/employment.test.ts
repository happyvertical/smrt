import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { employmentSuite } from './employment-suite.js';

let db: DatabaseInterface;
employmentSuite(
  'employment (sqlite)',
  async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    return db;
  },
  async () => {
    await db.close?.();
  },
);
