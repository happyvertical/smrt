/** Real legacy-schema upgrade fixture shared by the SQLite and PostgreSQL lanes. */
import { randomUUID } from 'node:crypto';
import { generateDDLForEngine, ObjectRegistry } from '@happyvertical/smrt-core';
import {
  type DatabaseInterface,
  migrateSmrtSchemas,
} from '@happyvertical/smrt-core/migrations';
import { expect } from 'vitest';
import { ExpenseCollection } from '../../collections/ExpenseCollection.js';

/** Create the preceding expense schema, seed a real row, then run public migration. */
export async function proveFinancialFactsMigration(
  db: DatabaseInterface,
  engine: 'sqlite' | 'postgres',
): Promise<void> {
  const current = ObjectRegistry.getAllSchemasAsDefinitions().expenses;
  const legacy = structuredClone(current);
  const additions = [
    'supplier_payable_json',
    'financial_breakdown',
    'paid_by_name',
    'refund_of_id',
    'refund_recipient',
    'reimbursed_amount',
  ];
  for (const column of additions) delete legacy.columns[column];
  legacy.foreignKeys = legacy.foreignKeys.filter(
    (key) => !additions.includes(key.column),
  );
  legacy.indexes = legacy.indexes.filter(
    (index) => !index.columns.some((column) => additions.includes(column)),
  );
  const ddl = generateDDLForEngine(legacy, engine);
  await db.query(ddl.createTable);
  for (const index of ddl.indexes) await db.query(index);
  const id = randomUUID();
  await db.query(
    'INSERT INTO expenses (id, slug, context, amount, currency, incurred_on, paid_by, review_status, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    id,
    '',
    12500,
    'USD',
    '2026-10-01',
    'company',
    'unreviewed',
    'other',
  );
  const migrate = () =>
    migrateSmrtSchemas({
      db,
      packageName: '@happyvertical/smrt-expenses',
      name: `expense_facts_${randomUUID().replace(/-/g, '')}`,
      postgresSafe: false,
      engineHint: engine,
    });
  const result = await migrate();
  expect(result.applied).toBe(true);
  expect(result.unactionableChanges).toEqual([]);
  expect(result.hasManualDrift).toBe(false);
  const expenses = await ExpenseCollection.create({ db });
  const loaded = await expenses.get({ id });
  expect(loaded?.amount).toBe(12500);
  expect(loaded?.supplierPayableJson).toBeNull();
  expect(loaded?.getFinancialBreakdown()).toBeNull();
  expect(loaded?.getCostBasis()).toBeNull();
  expect(loaded?.refundOfId).toBeNull();
  expect(loaded?.paidByName).toBeNull();
  expect(loaded?.getRefundRecipient()).toBeNull();
  expect(loaded?.reimbursedAmount).toBeNull();
  // Both the existing legacy row and a newly explicit fact can be saved.
  await loaded!.save();
  loaded!.setFinancialBreakdown({
    currency: 'USD',
    subtotal: 12500,
    taxes: [],
    total: 12500,
  });
  await loaded!.save();
  expect((await expenses.get({ id }))?.getCostBasis()?.costBasis).toBe(12500);
  const refund = await expenses.create({
    amount: -100,
    currency: 'USD',
    incurredOn: '2026-10-02',
    refundOfId: id,
  });
  await refund.save();
  await expect(
    (await expenses.get({ id }, { cache: false }))!.delete(),
  ).rejects.toThrow();
  expect(await expenses.get({ id })).not.toBeNull();
  expect((await expenses.get({ id: refund.id! }))?.refundOfId).toBe(id);
  const again = await migrate();
  expect(again.applied).toBe(false);
  expect(again.hasManualDrift).toBe(false);
  expect(again.statements).toEqual([]);
}
