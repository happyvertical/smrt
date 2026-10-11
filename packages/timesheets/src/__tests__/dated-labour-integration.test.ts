import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { datedLabourSuite } from './dated-labour-suite.js';

let db: DatabaseInterface;
datedLabourSuite(
  'dated labour (SQLite)',
  async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    return db;
  },
  async () => {
    await db?.close?.();
  },
);
