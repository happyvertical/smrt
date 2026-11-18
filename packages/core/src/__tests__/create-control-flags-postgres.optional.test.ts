/**
 * PostgreSQL run of the create control-key cases. Runs only in the dedicated
 * disposable PostgreSQL shard (`SMRT_TEST_POSTGRES_URL`).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { describe } from 'vitest';
import { getTestDatabase } from '../testing/database.js';
import {
  CREATE_FLAG_TABLE,
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
    await db.query(`DROP TABLE IF EXISTS "${CREATE_FLAG_TABLE}"`);
    await getTestDatabase({
      db,
      type: 'postgres',
      classes: ['CreateControlFlagPart'],
    });
    return {
      db,
      close: async () => {
        try {
          await db.query(`DROP TABLE IF EXISTS "${CREATE_FLAG_TABLE}"`);
        } finally {
          await db.close?.();
        }
      },
    };
  });
});
