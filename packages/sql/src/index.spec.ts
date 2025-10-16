import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { buildWhere, getDatabase, syncSchema } from './index';

const _TMP_DIR = path.resolve(`${tmpdir()}/kissd`);

it.skip('should be able to get the adapter for a postgres database', async () => {
  const db = await getDatabase({
    type: 'postgres',
    database: process.env.SQLOO_NAME || 'sqloo',
    host: process.env.SQLOO_HOST || 'localhost',
    user: process.env.SQLOO_USER || 'sqloo',
    password: process.env.SQLOO_PASS || 'sqloo',
    port: Number(process.env.SQLOO_PORT) || 5432,
  });
  expect(db.client).toBeDefined();
});

it('should be able to get the adapter for a sqlite database', async () => {
  const db = await getDatabase({
    type: 'sqlite',
  });
  expect(db.client).toBeDefined();
});

it('should be able to get the adapter for an in memory sqlite database', async () => {
  const db = await getDatabase({
    type: 'sqlite',
    url: ':memory:',
  });
  expect(db.client).toBeDefined();
});

it('should be able to sync a table schema', async () => {
  const db = await getDatabase({
    type: 'sqlite',
    url: ':memory:',
  });
  // console.log({ db });
  await syncSchema({
    db,
    schema: `
        CREATE TABLE test (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT
        )
      `,
  });
});

it('should handle basic usage with different operators', () => {
  const result = buildWhere({
    status: 'active',
    'price >': 100,
    'stock <=': 5,
    'category in': ['A', 'B'],
    'name like': '%shirt%',
  });

  expect(result.sql).toBe(
    'WHERE status = $1 AND price > $2 AND stock <= $3 AND category IN ($4, $5) AND name LIKE $6',
  );
  expect(result.values).toEqual(['active', 100, 5, 'A', 'B', '%shirt%']);
});

it('should handle NULL values correctly', () => {
  const result = buildWhere({
    deleted_at: null,
    'updated_at !=': null,
    status: 'active',
  });

  expect(result.sql).toBe(
    'WHERE deleted_at IS NULL AND updated_at IS NOT NULL AND status = $1',
  );
  expect(result.values).toEqual(['active']);
});

it('should handle price range conditions', () => {
  const result = buildWhere({
    'price >=': 10,
    'price <': 100,
  });

  expect(result.sql).toBe('WHERE price >= $1 AND price < $2');
  expect(result.values).toEqual([10, 100]);
});

it('should handle date filtering with null check', () => {
  const startDate = new Date('2024-01-01');
  const endDate = new Date('2024-12-31');

  const result = buildWhere({
    'created_at >': startDate,
    'created_at <=': endDate,
    deleted_at: null,
  });

  expect(result.sql).toBe(
    'WHERE created_at > $1 AND created_at <= $2 AND deleted_at IS NULL',
  );
  expect(result.values).toEqual([startDate, endDate]);
});

it('should handle LIKE operators for search', () => {
  const result = buildWhere({
    'title like': '%search%',
    'description like': '%search%',
    status: 'published',
  });

  expect(result.sql).toBe(
    'WHERE title LIKE $1 AND description LIKE $2 AND status = $3',
  );
  expect(result.values).toEqual(['%search%', '%search%', 'published']);
});

it('should handle IN clauses with arrays', () => {
  const result = buildWhere({
    'role in': ['admin', 'editor'],
    active: true,
    'last_login !=': null,
  });

  expect(result.sql).toBe(
    'WHERE role IN ($1, $2) AND active = $3 AND last_login IS NOT NULL',
  );
  expect(result.values).toEqual(['admin', 'editor', true]);
});
