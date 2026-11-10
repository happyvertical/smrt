import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  type DatabaseInterface,
  migrateSmrtSchemas,
} from '@happyvertical/smrt-core/migrations';
import { isPostgresAvailable } from '@happyvertical/smrt-vitest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExpenseCollection } from '../collections/ExpenseCollection.js';
import { createWorld } from './helpers/expense-suite.js';
import { defineSupplierPayableSuite } from './helpers/supplier-payable-suite.js';

const pg = isPostgresAvailable() ? describe : describe.skip;
pg('Expense supplier payable authority (managed PostgreSQL)', () => {
  let db: DatabaseInterface;
  let admin: DatabaseInterface | undefined;
  let databaseName = '';
  beforeAll(async () => {
    const baseUrl = process.env.DATABASE_URL ?? '';
    admin = await getTestDatabase({
      type: 'postgres',
      url: baseUrl,
      classes: [],
      includeSystemTables: false,
    });
    databaseName = `smrt_supplier_payable_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const url = new URL(baseUrl);
    url.pathname = `/${databaseName}`;
    db = await getTestDatabase({
      type: 'postgres',
      url: String(url),
      classes: [],
    });
    await migrateSmrtSchemas({
      db,
      packageName: '@happyvertical/smrt-expenses',
      name: `supplier_payable_${randomUUID().replaceAll('-', '')}`,
      postgresSafe: false,
    });
  });
  afterAll(async () => {
    await (db as { close?: () => Promise<void> })?.close?.();
    if (databaseName)
      await admin?.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await (admin as { close?: () => Promise<void> } | undefined)?.close?.();
  });
  it('migrates the command-owned nullable authority with native money and tenant types', async () => {
    const rows = (
      await db.query(
        "SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='expenses'",
      )
    ).rows as Array<{ column_name: string; data_type: string }>;
    const types = Object.fromEntries(
      rows.map((row) => [row.column_name, row.data_type]),
    );
    expect(types).toMatchObject({
      supplier_payable_json: 'text',
      amount: 'bigint',
      tenant_id: 'uuid',
    });
  });
  it('refuses a settlement decided from a stale snapshot after a competing refund claims the source', async () => {
    const world = await createWorld(db);
    await world.inTenant(async () => {
      const expense = await world.expense({ amount: 1000 });
      await expense.recordSupplierPayable({
        requestId: randomUUID(),
        currency: 'USD',
        source: {
          namespace: 'synthetic',
          key: 'original',
          version: '1',
          author: 'original supplier',
        },
        payableBasisMinor: 1000,
        events: [],
        recordedByProfileId: randomUUID(),
        evidenceRef: 'explicit original payable',
      });
      let ready!: () => void, resume!: () => void;
      const pinned = new Promise<void>((resolve) => {
          ready = resolve;
        }),
        gate = new Promise<void>((resolve) => {
          resume = resolve;
        });
      const writer = db.transaction!(async (tx) => {
        await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        const expenses = await ExpenseCollection.create({ db: tx });
        const stale = await expenses.get(expense.id, { cache: false });
        ready();
        await gate;
        await stale!.recordSupplierPayableEvent({
          requestId: randomUUID(),
          currency: 'USD',
          recordedByProfileId: randomUUID(),
          evidenceRef: 'stale settlement',
          event: {
            kind: 'settlement',
            amountMinor: 1000,
            effectiveOn: '2026-09-17',
            sequence: 0,
            evidenceRef: 'payment evidence',
          },
        });
      }).then(
        () => null,
        (cause) => {
          ready();
          return cause;
        },
      );
      try {
        await pinned;
        await world.expense({
          amount: -100,
          refundOfId: expense.id,
          incurredOn: '2026-09-16',
        });
      } finally {
        resume();
      }
      expect(String(await writer)).toMatch(
        /could not serialize|concurrent update/i,
      );
      expect(await expense.getSupplierPayablePosition()).toMatchObject({
        settledMinor: 0,
        remainingPayableMinor: null,
        unknownReasons: ['refund-interpretation-required'],
      });
    });
  });
  defineSupplierPayableSuite(() => db);
});
