import type { DatabaseInterface } from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import { DispatchCollection } from './Dispatches.js';

describe('DispatchCollection countByStatus', () => {
  it.each([
    ['PostgreSQL', '2'],
    ['DuckDB', 2n],
  ])('hydrates %s COUNT(*) results', async (_driver, count) => {
    const db = {
      single: async () => ({ count }),
    } as unknown as DatabaseInterface;

    await expect(DispatchCollection.countByStatus(db, 'pending')).resolves.toBe(
      2,
    );
  });
});
