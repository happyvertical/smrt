/**
 * PostgreSQL run of the create control-key cases. Runs only in the dedicated
 * disposable PostgreSQL shard (`SMRT_TEST_POSTGRES_URL`).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { describe } from 'vitest';
import { getTestDatabase } from '../testing/database.js';
import {
  CREATE_FLAG_CLASSES,
  CREATE_FLAG_TABLES,
  createControlFlagSuite,
} from './create-control-flags.cases.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;

describe.skipIf(!pgUrl)('create control keys on PostgreSQL', () => {
  createControlFlagSuite('postgres', async () => {
    const db = (await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: `smrt-test-create-control-flags-${crypto.randomUUID()}`,
      max: 4,
    } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
    for (const table of CREATE_FLAG_TABLES) {
      await db.query(`DROP TABLE IF EXISTS "${table}"`);
    }
    await getTestDatabase({
      db,
      type: 'postgres',
      classes: CREATE_FLAG_CLASSES,
    });
    return {
      db,
      close: async () => {
        try {
          for (const table of CREATE_FLAG_TABLES) {
            await db.query(`DROP TABLE IF EXISTS "${table}"`);
          }
        } finally {
          await db.close?.();
        }
      },
    };
  });
});
