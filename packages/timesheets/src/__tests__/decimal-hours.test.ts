import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { decimalHoursSuite } from './decimal-hours-suite.js';

let db: DatabaseInterface;
decimalHoursSuite(
  'decimal hours (SQLite)',
  async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    return db;
  },
  async () => {
    await db?.close?.();
  },
);
