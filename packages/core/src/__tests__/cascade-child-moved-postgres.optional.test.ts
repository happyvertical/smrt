/**
 * PostgreSQL: a CASCADE delete never removes a child that another connection
 * moved to a different parent. The cascade locks the children it selects
 * (`FOR UPDATE`), so a move already in flight is waited for and re-checked,
 * and the delete keeps the parent predicate. SQLite serializes writers and is
 * covered deterministically by `cascade-child-moved.test.ts`.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { field, foreignKey } from '../decorators/index';
import { SmrtObject } from '../object';
import { smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;

const BILLS = 'pg_cascade_moved_bills';
const STEPS = 'pg_cascade_moved_steps';

@smrt({ tableName: 'pg_cascade_moved_bills' })
class PgCascadeMovedBill extends SmrtObject {
  @field() title = '';
}
class PgCascadeMovedBillCollection extends SmrtCollection<PgCascadeMovedBill> {
  static readonly _itemClass = PgCascadeMovedBill;
}

@smrt({ tableName: 'pg_cascade_moved_steps' })
class PgCascadeMovedStep extends SmrtObject {
  @foreignKey('PgCascadeMovedBill', { required: true, onDelete: 'CASCADE' })
  billId = '';
  @field() label = '';
}
class PgCascadeMovedStepCollection extends SmrtCollection<PgCascadeMovedStep> {
  static readonly _itemClass = PgCascadeMovedStep;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!pgUrl)(
  'cascade delete of a concurrently moved child [postgres]',
  () => {
    let db: DatabaseInterface;
    let mover: DatabaseInterface;
    let observer: DatabaseInterface;
    let bills: PgCascadeMovedBillCollection;
    let steps: PgCascadeMovedStepCollection;

    beforeAll(async () => {
      const open = (tag: string, max: number) =>
        getDatabase({
          type: 'postgres',
          url: pgUrl,
          dbid: `cascade-moved-${tag}-${randomUUID()}`,
          max,
        } as Parameters<typeof getDatabase>[0]) as Promise<DatabaseInterface>;
      db = await open('a', 4);
      mover = await open('b', 1);
      observer = await open('o', 1);
      for (const table of [STEPS, BILLS]) {
        await db.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
      }
      await getTestDatabase({
        type: 'postgres',
        db,
        classes: ['PgCascadeMovedBill', 'PgCascadeMovedStep'],
      });
    }, 60_000);

    afterAll(async () => {
      for (const table of [STEPS, BILLS]) {
        await db?.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
      }
      await db?.close?.();
      await mover?.close?.();
      await observer?.close?.();
    });

    beforeEach(async () => {
      await db.query(`TRUNCATE "${STEPS}", "${BILLS}"`);
      bills = await PgCascadeMovedBillCollection.create({ db });
      steps = await PgCascadeMovedStepCollection.create({ db });
    });

    it('keeps a child whose move commits while the cascade waits for it', async () => {
      const billA = await bills.create({ title: 'A' } as never);
      const billB = await bills.create({ title: 'B' } as never);
      const step = await steps.create({
        billId: billA.id,
        label: 'moved',
      } as never);

      let commitMove!: () => void;
      const moveGate = new Promise<void>((resolve) => {
        commitMove = resolve;
      });
      let moveStarted!: () => void;
      const moveStartedSignal = new Promise<void>((resolve) => {
        moveStarted = resolve;
      });

      // The mover holds an uncommitted move of the step to bill B.
      const move = (mover as any).transaction(async (tx: DatabaseInterface) => {
        await tx.query(
          `UPDATE "${STEPS}" SET bill_id = $1 WHERE id = $2`,
          billB.id,
          step.id,
        );
        moveStarted();
        await moveGate;
      });
      await moveStartedSignal;

      const cascade = billA.delete().then(
        () => 'ok',
        (error: unknown) => `error: ${(error as Error).message}`,
      );

      // The cascade's child select waits on the mover's row lock.
      let blockedSql = '';
      for (let attempt = 0; attempt < 100 && !blockedSql; attempt++) {
        await sleep(50);
        const result = await observer.query(
          `SELECT query FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND datname = current_database()`,
        );
        blockedSql = String(result.rows[0]?.query ?? '');
      }
      expect(blockedSql).toContain(STEPS);
      expect(blockedSql).toContain('FOR UPDATE');

      commitMove();
      await move;
      expect(await cascade).toBe('ok');

      const stepRows = await observer.query(
        `SELECT CAST(bill_id AS VARCHAR) AS bill_id FROM "${STEPS}" WHERE id = $1`,
        step.id,
      );
      expect(stepRows.rows).toEqual([{ bill_id: billB.id }]);
      const billRows = await observer.query(
        `SELECT CAST(id AS VARCHAR) AS id FROM "${BILLS}"`,
      );
      expect(billRows.rows).toEqual([{ id: billB.id }]);
    }, 30_000);

    it('control: deletes a child that still references the deleted parent', async () => {
      const billA = await bills.create({ title: 'A' } as never);
      const step = await steps.create({
        billId: billA.id,
        label: 's',
      } as never);

      await billA.delete();

      const stepRows = await observer.query(
        `SELECT id FROM "${STEPS}" WHERE id = $1`,
        step.id,
      );
      expect(stepRows.rows).toEqual([]);
    });
  },
);
