import { randomUUID } from 'node:crypto';
import {
  generateDDLForEngine,
  getTestDatabase,
  ObjectRegistry,
} from '@happyvertical/smrt-core';
import {
  type DatabaseInterface,
  migrateSmrtSchemas,
} from '@happyvertical/smrt-core/migrations';
import { isPostgresAvailable } from '@happyvertical/smrt-vitest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '../models/Expense.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres('Expense runtime timestamps on PostgreSQL (#3940)', () => {
  let admin: DatabaseInterface | undefined;
  let db: DatabaseInterface;
  let databaseName = '';
  let legacyExpenseId = '';

  beforeAll(async () => {
    const baseUrl = process.env.DATABASE_URL ?? '';
    admin = await getTestDatabase({
      type: 'postgres',
      url: baseUrl,
      classes: [],
      includeSystemTables: false,
    });
    databaseName = `smrt_expense_dates_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const url = new URL(baseUrl);
    url.pathname = `/${databaseName}`;
    db = await getTestDatabase({
      type: 'postgres',
      url: String(url),
      classes: [],
    });

    const current = ObjectRegistry.getAllSchemasAsDefinitions().expenses;
    if (!current) throw new Error('Expense schema was not registered.');
    const legacy = structuredClone(current);
    delete legacy.columns.recorded_at;
    delete legacy.columns.reimbursed_at;
    const ddl = generateDDLForEngine(legacy, 'postgres');
    await db.query(ddl.createTable);
    for (const index of ddl.indexes) await db.query(index);
    legacyExpenseId = randomUUID();
    await db.query(
      'INSERT INTO expenses (id, slug, context, amount, currency, incurred_on, paid_by, review_status, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      legacyExpenseId,
      legacyExpenseId,
      '',
      12_500,
      'USD',
      '2026-09-01',
      'company',
      'unreviewed',
      'other',
    );
    await migrateSmrtSchemas({
      db,
      packageName: '@happyvertical/smrt-expenses',
      name: `expense_runtime_dates_${randomUUID().replace(/-/g, '')}`,
      postgresSafe: false,
      engineHint: 'postgres',
    });
  });

  afterAll(async () => {
    await (db as { close?: () => Promise<void> } | undefined)?.close?.();
    if (databaseName)
      await admin?.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await (admin as { close?: () => Promise<void> } | undefined)?.close?.();
  });

  it('adds runtime timestamps without changing legacy expense data', async () => {
    const columns = await db.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'expenses'
          AND column_name IN ('recorded_at', 'reimbursed_at')`,
    );
    expect(columns.rows.map((row) => row.column_name).sort()).toEqual([
      'recorded_at',
      'reimbursed_at',
    ]);
    const legacy = await db.query(
      'SELECT id, amount, currency, incurred_on FROM expenses WHERE id = ?',
      legacyExpenseId,
    );
    expect(legacy.rows).toEqual([
      expect.objectContaining({
        id: legacyExpenseId,
        amount: '12500',
        currency: 'USD',
        incurred_on: '2026-09-01',
      }),
    ]);
  });
});
