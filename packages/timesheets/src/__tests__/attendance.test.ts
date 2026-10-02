import { getTestDatabase, ObjectRegistry } from '@happyvertical/smrt-core';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { attendanceSuite } from './attendance-suite.js';

for (const type of ['sqlite'] as const) {
  let db: DatabaseInterface;
  attendanceSuite(
    `attendance (${type})`,
    async () => {
      db = await getTestDatabase({ type, url: ':memory:' });
      return db;
    },
    async () => {
      await db?.close?.();
    },
  );
}

// Entry/correction and attendance FKs require ON UPDATE CASCADE; do not
// omit them in a test and misrepresent DuckDB as a supported deployment.
import { expect, it } from 'vitest';

it('fails closed for unsupported DuckDB foreign-key DDL', async () => {
  const db = await getDatabase({ type: 'duckdb', url: ':memory:' });
  try {
    await expect(getTestDatabase({ db })).rejects.toThrow('ON UPDATE CASCADE');
  } finally {
    await db.close?.();
  }
});

it('exposes only generated reads and keeps replay receipts private', () => {
  for (const name of ['AttendancePunch', 'AttendanceBreak']) {
    const config = ObjectRegistry.getConfig(name);
    for (const surface of ['api', 'cli', 'mcp'] as const)
      expect(config[surface]).toEqual({ include: ['list', 'get'] });
  }
  const config = ObjectRegistry.getConfig('AttendanceReplay');
  expect(config.sensitive).toBe(true);
  for (const surface of ['api', 'cli', 'mcp'] as const)
    expect(config[surface]).toEqual({ include: [] });
});
