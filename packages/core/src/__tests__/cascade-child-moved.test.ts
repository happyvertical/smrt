/**
 * A CASCADE delete removes only the child rows that still reference the
 * deleted parent when the delete runs. A child that moved to another parent
 * after the cascade selected it survives. The move is simulated
 * deterministically with a trigger on the framework-owned row cleanup that
 * runs between the child select and the child delete. Runs on SQLite by
 * default and on PGlite under `pnpm test:pglite`; the concurrent PostgreSQL
 * case is `cascade-child-moved-postgres.optional.test.ts`.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { field, foreignKey } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { snapshotObjectRegistryState } from '../test-utils';
import { getTestDatabase } from '../testing/database';

@smrt({ tableName: 'cascade_moved_bills' })
class CascadeMovedBill extends SmrtObject {
  @field() title = '';
}
class CascadeMovedBillCollection extends SmrtCollection<CascadeMovedBill> {
  static readonly _itemClass = CascadeMovedBill;
}

@smrt({ tableName: 'cascade_moved_steps' })
class CascadeMovedStep extends SmrtObject {
  @foreignKey('CascadeMovedBill', { required: true, onDelete: 'CASCADE' })
  billId = '';
  @field() label = '';
}
class CascadeMovedStepCollection extends SmrtCollection<CascadeMovedStep> {
  static readonly _itemClass = CascadeMovedStep;
}

type Engine = 'sqlite' | 'pglite';
const engines: Engine[] =
  process.env.SMRT_TEST_PGLITE === '1' ? ['pglite'] : ['sqlite'];

describe.each(engines)('cascade delete of a moved child on %s', (engine) => {
  let restore: () => void;
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  let bills: CascadeMovedBillCollection;
  let steps: CascadeMovedStepCollection;

  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.registerCollection(
      'CascadeMovedBill',
      CascadeMovedBillCollection,
    );
    ObjectRegistry.registerCollection(
      'CascadeMovedStep',
      CascadeMovedStepCollection,
    );
    db = await getTestDatabase({
      type: engine,
      ...(engine === 'sqlite' ? { url: ':memory:' } : {}),
      classes: ['CascadeMovedBill', 'CascadeMovedStep'],
    });
    bills = (await CascadeMovedBillCollection.create({ db })) as never;
    steps = (await CascadeMovedStepCollection.create({ db })) as never;
  });

  afterEach(async () => {
    await db?.close?.();
    restore();
  });

  /**
   * Move `stepId` to `targetBillId` when the cascade clears the step's
   * framework-owned context row, i.e. after the step was selected for
   * deletion and before it is deleted.
   */
  async function moveStepDuringCascade(stepId: string, targetBillId: string) {
    await db.query(
      `INSERT INTO _smrt_contexts (id, owner_class, owner_id, scope, key)
       VALUES ('${randomUUID()}', 'CascadeMovedStep', '${stepId}', 's', 'k')`,
    );
    if (engine === 'sqlite') {
      await db.query(
        `CREATE TRIGGER cascade_moved_trigger BEFORE DELETE ON _smrt_contexts
         FOR EACH ROW BEGIN
           UPDATE cascade_moved_steps SET bill_id = '${targetBillId}'
            WHERE id = OLD.owner_id;
         END`,
      );
      return;
    }
    await db.query(
      `CREATE FUNCTION cascade_moved_fn() RETURNS trigger AS '
         BEGIN
           UPDATE cascade_moved_steps SET bill_id = ''${targetBillId}''
            WHERE CAST(id AS TEXT) = OLD.owner_id;
           RETURN OLD;
         END' LANGUAGE plpgsql`,
    );
    await db.query(
      `CREATE TRIGGER cascade_moved_trigger BEFORE DELETE ON _smrt_contexts
       FOR EACH ROW EXECUTE FUNCTION cascade_moved_fn()`,
    );
  }

  async function stepRow(id: string) {
    const result = await db.query(
      'SELECT CAST(bill_id AS VARCHAR) AS bill_id FROM cascade_moved_steps WHERE CAST(id AS VARCHAR) = $1',
      id,
    );
    return result.rows[0] as { bill_id: string } | undefined;
  }

  it('keeps a child that moved to another parent after it was selected', async () => {
    const billA = await bills.create({ title: 'A' } as never);
    const billB = await bills.create({ title: 'B' } as never);
    const step = await steps.create({
      billId: billA.id,
      label: 'moved',
    } as never);
    await moveStepDuringCascade(String(step.id), String(billB.id));

    await billA.delete();

    expect(await stepRow(String(step.id))).toEqual({ bill_id: billB.id });
    expect(await bills.get({ id: String(billA.id) })).toBeNull();
  });

  it('control: deletes a child that still references the deleted parent', async () => {
    const billA = await bills.create({ title: 'A' } as never);
    const other = await bills.create({ title: 'B' } as never);
    const step = await steps.create({ billId: billA.id, label: 's' } as never);
    const kept = await steps.create({ billId: other.id, label: 'k' } as never);

    await billA.delete();

    expect(await stepRow(String(step.id))).toBeUndefined();
    expect(await stepRow(String(kept.id))).toEqual({ bill_id: other.id });
  });
});
