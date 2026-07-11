import { randomUUID } from 'node:crypto';
import { syncSchema } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createIsolatedTestDb } from '../test-db.js';

vi.mock('@happyvertical/sql', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happyvertical/sql')>();

  return {
    ...actual,
    syncSchema: vi.fn(actual.syncSchema),
  };
});

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalTestDbAdapter = process.env.TEST_DB_ADAPTER;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe('SQLite isolated test database schema templates', () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    process.env.TEST_DB_ADAPTER = 'sqlite';
    vi.mocked(syncSchema).mockClear();
  });

  afterEach(() => {
    restoreEnv('DATABASE_URL', originalDatabaseUrl);
    restoreEnv('TEST_DB_ADAPTER', originalTestDbAdapter);
  });

  it('builds identical schema once while returning isolated databases', async () => {
    const suffix = randomUUID().replaceAll('-', '');
    const tableName = `schema_template_${suffix}`;
    const schema = `CREATE TABLE "${tableName}" ("id" TEXT PRIMARY KEY, "value" TEXT);`;

    const first = await createIsolatedTestDb({ schema, prefix: 'template-a' });
    try {
      await first.db.insert(tableName, { id: 'first', value: 'persisted' });
      expect(await first.db.list(tableName, {})).toHaveLength(1);
    } finally {
      await first.cleanup();
    }

    const second = await createIsolatedTestDb({
      schema,
      prefix: 'template-b',
    });
    try {
      expect(await second.db.list(tableName, {})).toHaveLength(0);
    } finally {
      await second.cleanup();
    }

    expect(syncSchema).toHaveBeenCalledTimes(1);
  });

  it('coordinates concurrent template creation for the same schema', async () => {
    const suffix = randomUUID().replaceAll('-', '');
    const tableName = `schema_template_concurrent_${suffix}`;
    const schema = `CREATE TABLE "${tableName}" ("id" TEXT PRIMARY KEY, "value" TEXT);`;

    const databases = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        createIsolatedTestDb({
          schema,
          prefix: `template-concurrent-${index}`,
        }),
      ),
    );

    try {
      expect(new Set(databases.map(({ config }) => config.url)).size).toBe(4);

      await Promise.all(
        databases.map(async ({ db }, index) => {
          await db.insert(tableName, {
            id: `database-${index}`,
            value: `value-${index}`,
          });
          expect(await db.list(tableName, {})).toEqual([
            expect.objectContaining({ id: `database-${index}` }),
          ]);
        }),
      );
    } finally {
      await Promise.all(databases.map(({ cleanup }) => cleanup()));
    }

    expect(syncSchema).toHaveBeenCalledTimes(1);
  });

  it('uses separate templates when schema content differs', async () => {
    const suffix = randomUUID().replaceAll('-', '');
    const firstTable = `schema_template_first_${suffix}`;
    const secondTable = `schema_template_second_${suffix}`;

    const first = await createIsolatedTestDb({
      schema: `CREATE TABLE "${firstTable}" ("id" TEXT PRIMARY KEY);`,
      prefix: 'template-first-schema',
    });
    const second = await createIsolatedTestDb({
      schema: `CREATE TABLE "${secondTable}" ("id" TEXT PRIMARY KEY);`,
      prefix: 'template-second-schema',
    });

    try {
      expect(await first.db.list(firstTable, {})).toEqual([]);
      expect(await second.db.list(secondTable, {})).toEqual([]);
    } finally {
      await Promise.all([first.cleanup(), second.cleanup()]);
    }

    expect(syncSchema).toHaveBeenCalledTimes(2);
  });
});
