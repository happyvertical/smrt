import { getTestDatabase } from '@happyvertical/smrt-core';
import { describe } from 'vitest';
import { nominationCases } from './nomination-cases.js';

describe('referral nominations on SQLite', () => {
  nominationCases(async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    return {
      db,
      close: async () => {
        await db.close?.();
      },
    };
  });
});
