import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import { qualificationsSuite } from './qualifications-suite.js';

let db: DatabaseInterface;
qualificationsSuite(
  'qualifications (sqlite)',
  async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    return db;
  },
  async () => {
    await db.close?.();
  },
);

describe('qualifications (sqlite schema)', () => {
  it('indexes the columns held qualifications are looked up by', async () => {
    const schema = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    try {
      const { rows } = await schema.query(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'held_qualifications' AND sql IS NOT NULL",
      );
      const indexed = (rows as { sql: string }[]).map((row) =>
        row.sql.slice(row.sql.indexOf('(')),
      );
      // Every lookup filters by one of these with the tenant; the generated
      // foreign-key index on the column itself serves it.
      for (const column of [
        'renewal_of_id',
        'employment_id',
        'qualification_id',
      ])
        expect(indexed).toContain(`("${column}")`);
      expect(indexed).toContain(
        '("tenant_id", "profile_id", "qualification_id")',
      );
    } finally {
      await schema.close?.();
    }
  });
});
