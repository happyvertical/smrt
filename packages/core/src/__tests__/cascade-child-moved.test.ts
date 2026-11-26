/**
 * A CASCADE delete removes only the child rows that still reference the
 * deleted parent when the delete runs (#5592). A child that moved to another
 * parent after the cascade selected it survives, and so does everything under
 * it. The move is simulated deterministically with a trigger on the
 * framework-owned row cleanup that runs between the child select and the child
 * delete. Runs on SQLite by default and on PGlite under `pnpm test:pglite`;
 * the concurrent PostgreSQL case is `cascade-child-moved-postgres.optional.test.ts`.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cascadeReferencesTo, runCascadeDelete } from '../cascade';
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

@smrt({ tableName: 'cascade_moved_notes' })
class CascadeMovedNote extends SmrtObject {
  @foreignKey('CascadeMovedStep', { required: true, onDelete: 'CASCADE' })
  stepId = '';
  @field() body = '';
}
class CascadeMovedNoteCollection extends SmrtCollection<CascadeMovedNote> {
  static readonly _itemClass = CascadeMovedNote;
}

type Engine = 'sqlite' | 'pglite';
const engines: Engine[] =
  process.env.SMRT_TEST_PGLITE === '1' ? ['pglite'] : ['sqlite'];

/** Wrap a handle (and every transaction handle it opens) to record bind counts. */
function recordBinds(
  db: DatabaseInterface,
  binds: number[],
): DatabaseInterface {
  return new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      if (property === 'query') {
        return (sql: string, ...params: unknown[]) => {
          binds.push(params.length);
          return value.call(target, sql, ...params);
        };
      }
      if (property === 'transaction') {
        return (callback: (tx: DatabaseInterface) => Promise<unknown>) =>
          value.call(target, (tx: DatabaseInterface) =>
            callback(recordBinds(tx, binds)),
          );
      }
      return value.bind(target);
    },
  });
}

describe.each(engines)('cascade delete of a moved child on %s', (engine) => {
  let restore: () => void;
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  let bills: CascadeMovedBillCollection;
  let steps: CascadeMovedStepCollection;
  let notes: CascadeMovedNoteCollection;

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
    ObjectRegistry.registerCollection(
      'CascadeMovedNote',
      CascadeMovedNoteCollection,
    );
    db = await getTestDatabase({
      type: engine,
      ...(engine === 'sqlite' ? { url: ':memory:' } : {}),
      classes: ['CascadeMovedBill', 'CascadeMovedStep', 'CascadeMovedNote'],
    });
    bills = (await CascadeMovedBillCollection.create({ db })) as never;
    steps = (await CascadeMovedStepCollection.create({ db })) as never;
    notes = (await CascadeMovedNoteCollection.create({ db })) as never;
  });

  afterEach(async () => {
    await db?.close?.();
    restore();
  });

  async function addContext(ownerClass: string, ownerId: string) {
    await db.query(
      `INSERT INTO _smrt_contexts (id, owner_class, owner_id, scope, key)
       VALUES ('${randomUUID()}', '${ownerClass}', '${ownerId}', 's', 'k')`,
    );
  }

  /**
   * Move `stepId` to `targetBillId` when the cascade clears the step's
   * framework-owned context row: after the step was selected for deletion and
   * its notes were removed, before the step itself is deleted. SQLite only: a
   * trigger's write is undone with a rolled-back savepoint, so PostgreSQL uses
   * cascadeWithMove().
   */
  async function moveStepDuringCascade(stepId: string, targetBillId: string) {
    await addContext('CascadeMovedStep', stepId);
    if (engine === 'sqlite') {
      await db.query(
        `CREATE TRIGGER cascade_moved_trigger BEFORE DELETE ON _smrt_contexts
         FOR EACH ROW WHEN OLD.owner_id = '${stepId}' BEGIN
           UPDATE cascade_moved_steps SET bill_id = '${targetBillId}'
            WHERE id = OLD.owner_id;
         END`,
      );
      return;
    }
    throw new Error('PostgreSQL moves the child through cascadeWithMove()');
  }

  /**
   * Delete `billId` through the cascade, moving `stepId` to `targetBillId`
   * right after the cascade selected it: on the same transaction handle, ahead
   * of any savepoint the cascade opens, so the move survives a rolled-back
   * attempt exactly as a move committed by another connection would.
   */
  async function cascadeWithMove(
    billId: string,
    stepId: string,
    targetBillId: string,
    role?: string,
  ) {
    let moved = false;
    const hook = (handle: DatabaseInterface): DatabaseInterface =>
      new Proxy(handle, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (typeof value !== 'function') return value;
          if (property === 'query') {
            return async (sql: string, ...params: unknown[]) => {
              const result = await value.call(target, sql, ...params);
              if (
                !moved &&
                /^SELECT[\s\S]*FROM "cascade_moved_steps"/.test(sql)
              ) {
                moved = true;
                // The mover is another session: it is not the restricted role.
                if (role) await value.call(target, 'RESET ROLE');
                await value.call(
                  target,
                  'UPDATE cascade_moved_steps SET bill_id = $1 WHERE id = $2',
                  targetBillId,
                  stepId,
                );
                if (role) await value.call(target, `SET ROLE ${role}`);
              }
              return result;
            };
          }
          if (property === 'transaction') {
            return (callback: (tx: DatabaseInterface) => Promise<unknown>) =>
              value.call(target, (tx: DatabaseInterface) => callback(hook(tx)));
          }
          return value.bind(target);
        },
      });
    if (role) await db.query(`SET ROLE ${role}`);
    try {
      await runCascadeDelete(
        hook(db),
        ObjectRegistry as never,
        {
          className: 'CascadeMovedBill',
          tableName: 'cascade_moved_bills',
          id: billId,
        },
        async (bound) => {
          await bound.query(
            'DELETE FROM cascade_moved_bills WHERE id = $1',
            billId,
          );
        },
      );
    } finally {
      if (role) await db.query('RESET ROLE');
    }
    expect(moved).toBe(true);
  }

  async function count(table: string, id: string) {
    const result = await db.query(
      `SELECT CAST(id AS VARCHAR) AS id FROM ${table} WHERE CAST(id AS VARCHAR) = $1`,
      id,
    );
    return result.rows.length;
  }

  async function stepBill(id: string) {
    const result = await db.query(
      'SELECT CAST(bill_id AS VARCHAR) AS bill_id FROM cascade_moved_steps WHERE CAST(id AS VARCHAR) = $1',
      id,
    );
    return (result.rows[0] as { bill_id: string } | undefined)?.bill_id;
  }

  async function contextCount(ownerId: string) {
    const result = await db.query(
      `SELECT id FROM _smrt_contexts WHERE owner_id = '${ownerId}'`,
    );
    return result.rows.length;
  }

  it('keeps a child that moved to another parent after it was selected', async () => {
    const billA = await bills.create({ title: 'A' } as never);
    const billB = await bills.create({ title: 'B' } as never);
    const step = await steps.create({
      billId: billA.id,
      label: 'moved',
    } as never);
    if (engine === 'sqlite') {
      await moveStepDuringCascade(String(step.id), String(billB.id));
      await billA.delete();
    } else {
      await cascadeWithMove(
        String(billA.id),
        String(step.id),
        String(billB.id),
      );
    }

    expect(await stepBill(String(step.id))).toBe(billB.id);
    expect(await count('cascade_moved_bills', String(billA.id))).toBe(0);
  });

  it.runIf(engine === 'pglite')(
    'keeps the descendants and framework rows of a moved child',
    async () => {
      const billA = await bills.create({ title: 'A' } as never);
      const billB = await bills.create({ title: 'B' } as never);
      const step = await steps.create({
        billId: billA.id,
        label: 'moved',
      } as never);
      const stay = await steps.create({
        billId: billA.id,
        label: 'stays',
      } as never);
      const note = await notes.create({
        stepId: step.id,
        body: 'under moved',
      } as never);
      const stayNote = await notes.create({
        stepId: stay.id,
        body: 'under stays',
      } as never);
      await addContext('CascadeMovedNote', String(note.id));
      await addContext('CascadeMovedStep', String(step.id));
      await cascadeWithMove(
        String(billA.id),
        String(step.id),
        String(billB.id),
      );

      expect(await stepBill(String(step.id))).toBe(billB.id);
      expect(await count('cascade_moved_notes', String(note.id))).toBe(1);
      expect(await contextCount(String(note.id))).toBe(1);
      expect(await contextCount(String(step.id))).toBe(1);
      // The siblings that stayed are removed with everything under them.
      expect(await count('cascade_moved_steps', String(stay.id))).toBe(0);
      expect(await count('cascade_moved_notes', String(stayNote.id))).toBe(0);
      expect(await count('cascade_moved_bills', String(billA.id))).toBe(0);
    },
  );

  it('control: deletes a child that still references the deleted parent', async () => {
    const billA = await bills.create({ title: 'A' } as never);
    const other = await bills.create({ title: 'B' } as never);
    const step = await steps.create({ billId: billA.id, label: 's' } as never);
    const note = await notes.create({ stepId: step.id, body: 'n' } as never);
    const kept = await steps.create({ billId: other.id, label: 'k' } as never);
    await addContext('CascadeMovedNote', String(note.id));

    await billA.delete();

    expect(await stepBill(String(step.id))).toBeUndefined();
    expect(await count('cascade_moved_notes', String(note.id))).toBe(0);
    expect(await contextCount(String(note.id))).toBe(0);
    expect(await stepBill(String(kept.id))).toBe(other.id);
  });

  /**
   * Row-level security that forces the policies on the table owner too and
   * grants a role only SELECT and DELETE: the cascade must work with exactly
   * the privileges and policies its plain select and delete already needed
   * (no UPDATE grant, no UPDATE policy, no row lock).
   */
  async function restrictToSelectAndDelete(role: string) {
    await db.query(`CREATE ROLE ${role} NOLOGIN`);
    for (const table of [
      'cascade_moved_bills',
      'cascade_moved_steps',
      'cascade_moved_notes',
      '_smrt_contexts',
      '_smrt_embeddings',
    ]) {
      await db.query(`GRANT SELECT, DELETE ON ${table} TO ${role}`);
      await db.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await db.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      await db.query(
        `CREATE POLICY ${table}_sel ON ${table} FOR SELECT TO ${role} USING (true)`,
      );
      await db.query(
        `CREATE POLICY ${table}_del ON ${table} FOR DELETE TO ${role} USING (true)`,
      );
    }
  }

  it.runIf(engine === 'pglite')(
    'cascades under forced row-level security with only SELECT and DELETE',
    async () => {
      const billA = await bills.create({ title: 'A' } as never);
      const step = await steps.create({
        billId: billA.id,
        label: 's',
      } as never);
      const note = await notes.create({ stepId: step.id, body: 'n' } as never);
      await addContext('CascadeMovedNote', String(note.id));
      await restrictToSelectAndDelete('cascade_rls_plain');
      await db.query('SET ROLE cascade_rls_plain');
      try {
        await runCascadeDelete(
          db,
          ObjectRegistry as never,
          {
            className: 'CascadeMovedBill',
            tableName: 'cascade_moved_bills',
            id: String(billA.id),
          },
          async (bound) => {
            await bound.query(
              'DELETE FROM cascade_moved_bills WHERE id = $1',
              String(billA.id),
            );
          },
        );
      } finally {
        await db.query('RESET ROLE');
      }
      expect(await count('cascade_moved_steps', String(step.id))).toBe(0);
      expect(await count('cascade_moved_notes', String(note.id))).toBe(0);
      expect(await contextCount(String(note.id))).toBe(0);
      expect(await count('cascade_moved_bills', String(billA.id))).toBe(0);
    },
  );

  it.runIf(engine === 'pglite')(
    'keeps a moved child under forced row-level security with only SELECT and DELETE',
    async () => {
      const billA = await bills.create({ title: 'A' } as never);
      const billB = await bills.create({ title: 'B' } as never);
      const step = await steps.create({
        billId: billA.id,
        label: 's',
      } as never);
      const note = await notes.create({ stepId: step.id, body: 'n' } as never);
      await restrictToSelectAndDelete('cascade_rls_moved');
      await cascadeWithMove(
        String(billA.id),
        String(step.id),
        String(billB.id),
        'cascade_rls_moved',
      );
      expect(await stepBill(String(step.id))).toBe(billB.id);
      expect(await count('cascade_moved_notes', String(note.id))).toBe(1);
      expect(await count('cascade_moved_bills', String(billA.id))).toBe(0);
    },
  );

  it('keeps every statement within the bind limit across chunked batches', async () => {
    const billA = await bills.create({ title: 'A' } as never);
    const total = 1000;
    const stepIds = Array.from({ length: total }, () => randomUUID());
    const noteIds = stepIds.map(() => randomUUID());
    const now = new Date().toISOString();
    for (let start = 0; start < total; start += 200) {
      const slice = stepIds.slice(start, start + 200);
      const values = slice
        .map(
          (id, i) =>
            `('${id}', '${billA.id}', 'l${start + i}', 's${start + i}', '${now}', '${now}')`,
        )
        .join(',');
      await db.query(
        `INSERT INTO cascade_moved_steps (id, bill_id, label, slug, created_at, updated_at) VALUES ${values}`,
      );
      const noteValues = slice
        .map(
          (id, i) =>
            `('${noteIds[start + i]}', '${id}', 'b', 'n${start + i}', '${now}', '${now}')`,
        )
        .join(',');
      await db.query(
        `INSERT INTO cascade_moved_notes (id, step_id, body, slug, created_at, updated_at) VALUES ${noteValues}`,
      );
    }

    const binds: number[] = [];
    await cascadeReferencesTo(recordBinds(db, binds), ObjectRegistry as never, {
      className: 'CascadeMovedBill',
      tableName: 'cascade_moved_bills',
      ids: [String(billA.id)],
    });

    expect(binds.length).toBeGreaterThan(0);
    expect(Math.max(...binds)).toBeLessThanOrEqual(900);
    const left = await db.query('SELECT id FROM cascade_moved_steps');
    expect(left.rows).toHaveLength(0);
    const leftNotes = await db.query('SELECT id FROM cascade_moved_notes');
    expect(leftNotes.rows).toHaveLength(0);
  }, 60_000);
});
