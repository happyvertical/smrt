import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  type DatabaseInterface,
  getDatabase,
  NestedTransactionError,
} from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import { EmploymentService, type HrEvent } from '../index.js';
import { employmentSuite } from './employment-suite.js';

let db: DatabaseInterface;
employmentSuite(
  'employment (sqlite)',
  async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    return db;
  },
  async () => {
    await db.close?.();
  },
);

/**
 * The SDK's native-capabilities SQLite adapter (opened for `vector` or
 * `notifications`) hands out transaction-scoped handles that still expose
 * `beginTransaction` (it throws) and a `transaction` that opens a savepoint,
 * so "has no beginTransaction" does not recognise them.
 */
describe('employment (sqlite, native-capabilities adapter)', () => {
  it('refuses every transaction-scoped handle and still commits on the root handle', async (context) => {
    let native: DatabaseInterface;
    try {
      native = await getDatabase({
        type: 'sqlite',
        url: ':memory:',
        capabilities: { vector: true },
      });
    } catch {
      // The vector extension is an optional native module.
      context.skip();
      return;
    }
    try {
      await getTestDatabase({ db: native });
      const actor = {
        tenantId: crypto.randomUUID(),
        profileId: crypto.randomUUID(),
      };
      const delivered: HrEvent[] = [];
      const on = (handle: DatabaseInterface) =>
        new EmploymentService(handle, actor, {
          onEvent: (event) => void delivered.push(event),
        });
      const hire = (handle: DatabaseInterface, employeeNumber: string) =>
        on(handle)
          .hire({
            profileId: crypto.randomUUID(),
            employeeNumber,
            startedOn: '2026-01-05',
          })
          .catch((error: unknown) => error);
      if (!native.transaction || !native.beginTransaction)
        throw new Error('The native adapter must support transactions.');

      const refused: unknown[] = [];
      await expect(
        native.transaction(async (tx) => {
          expect(typeof tx.beginTransaction).toBe('function');
          refused.push(await hire(tx, 'in-callback'));
          await tx.transaction?.(async (savepoint) => {
            refused.push(await hire(savepoint, 'in-savepoint'));
          });
          throw new Error('outer work failed');
        }),
      ).rejects.toThrow('outer work failed');
      const handle = await native.beginTransaction();
      try {
        refused.push(await hire(handle, 'in-handle'));
      } finally {
        await handle.rollback();
      }
      expect(refused).toHaveLength(3);
      for (const error of refused)
        expect(error).toMatchObject({ code: 'HR_TRANSACTION_UNSUPPORTED' });
      expect(delivered).toEqual([]);

      const root = on(native);
      for (const employeeNumber of ['in-callback', 'in-savepoint', 'in-handle'])
        expect(await root.findByEmployeeNumber(employeeNumber)).toBeNull();
      expect(await hire(native, 'on-root')).toMatchObject({
        employeeNumber: 'on-root',
        status: 'active',
      });
      expect(delivered.map((event) => event.type)).toEqual([
        'employment.hired',
      ]);
      expect(await root.findByEmployeeNumber('on-root')).not.toBeNull();
    } finally {
      await native.close?.();
    }
  });
});

/**
 * Always runs, unlike the native-adapter test above (whose vector module is
 * optional): a handle whose `beginTransaction` refuses with
 * `NestedTransactionError` is treated as transaction-scoped.
 */
describe('employment (handle that refuses to begin a transaction)', () => {
  it('refuses a mutation when beginTransaction reports a nested transaction, and writes nothing', async () => {
    const root = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    try {
      const scoped = new Proxy(root, {
        get(target, property, receiver) {
          if (property === 'beginTransaction')
            return async () => {
              throw new NestedTransactionError();
            };
          return Reflect.get(target, property, receiver);
        },
      });
      const actor = {
        tenantId: crypto.randomUUID(),
        profileId: crypto.randomUUID(),
      };
      const delivered: HrEvent[] = [];
      const refused = await new EmploymentService(scoped, actor, {
        onEvent: (event) => void delivered.push(event),
      })
        .hire({
          profileId: crypto.randomUUID(),
          employeeNumber: 'E-1',
          startedOn: '2026-01-05',
        })
        .catch((error: unknown) => error);
      expect(refused).toMatchObject({ code: 'HR_TRANSACTION_UNSUPPORTED' });
      expect(delivered).toEqual([]);
      expect(
        await new EmploymentService(root, actor).findByEmployeeNumber('E-1'),
      ).toBeNull();
    } finally {
      await root.close?.();
    }
  });
});
