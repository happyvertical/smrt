/**
 * Embedded engines take no migration lock (#5435): SQLite in the default
 * lane, PGlite under `pnpm test:pglite`. Their handles and transactions run
 * the work as they are, no lock statement is issued, the order guards do not
 * fire where no lock exists, and a transaction migrating beside a run on the
 * database handle does not hang.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withRuntimeSchemaActivation } from '../../activation.js';
import { field } from '../../decorators/index.js';
import { SmrtObject } from '../../object.js';
import { ObjectRegistry } from '../../registry.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import { getTestDatabase } from '../../testing/database.js';
import { acquireMigrationLock, withMigrationLock } from '../migration-lock.js';
import { migrateSmrtSchemas } from '../orchestrate.js';

const pglite = process.env.SMRT_TEST_PGLITE === '1';
const type = pglite ? 'pglite' : 'sqlite';
const hint = pglite ? 'postgres' : 'sqlite';
const options = pglite
  ? { atomic: true, postgresSafe: false, useConcurrentIndexes: false }
  : {};

class EmbeddedLockThing extends SmrtObject {
  title = '';
}
field({ type: 'text' })(EmbeddedLockThing.prototype, 'title');

describe(`migration lock on ${type}`, () => {
  let restore: () => void;
  let db: DatabaseInterface;
  let runs = 0;

  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.clear();
    ObjectRegistry.register(EmbeddedLockThing, {
      packageName: '@embedded-lock/fixture',
      tableName: 'embedded_lock_things',
    });
    db = (await getTestDatabase({
      type,
      classes: [],
      includeSystemTables: false,
    })) as DatabaseInterface;
  });
  afterEach(async () => {
    await db.close?.();
    restore();
  });

  const migrate = (handle: DatabaseInterface) =>
    migrateSmrtSchemas({
      db: handle,
      packageName: '@embedded-lock/app',
      name: `embedded_lock_${++runs}`,
      engineHint: hint,
      ...options,
    });
  const lockStatements = (spy: ReturnType<typeof vi.spyOn>) =>
    spy.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => /advisory|pg_locks|pg_postmaster/i.test(sql));

  it('runs the work on the handle itself with no lock and no lock statement', async () => {
    const spy = vi.spyOn(db, 'query');
    await withMigrationLock(db, async (lock) => {
      expect(lock).toMatchObject({ held: false, kind: 'none' });
      expect(lock.db).toBe(db);
      await expect(
        withRuntimeSchemaActivation(async () => 'not refused'),
      ).resolves.toBe('not refused');
      await expect(migrate(lock.db)).resolves.toMatchObject({
        refused: false,
      });
    });
    const explicit = await acquireMigrationLock(db);
    expect(explicit).toMatchObject({ held: false, kind: 'none' });
    expect(explicit.db).toBe(db);
    await explicit.release();
    expect(lockStatements(spy)).toEqual([]);
  });

  it('runs a transaction handle with no lock and no lock statement', async () => {
    await db.transaction?.(async (tx) => {
      const spy = vi.spyOn(tx, 'query');
      await withMigrationLock(tx as DatabaseInterface, async (lock) => {
        expect(lock).toMatchObject({ held: false, kind: 'none' });
        expect(lock.db).toBe(tx);
        await expect(
          withRuntimeSchemaActivation(async () => 'not refused'),
        ).resolves.toBe('not refused');
      });
      expect(lockStatements(spy)).toEqual([]);
    });
  });

  it.runIf(pglite)(
    'migrates on a transaction while a run on the database handle is in flight, without hanging',
    async () => {
      const tx = await db.beginTransaction!();
      const onDatabase = migrate(db);
      const onTransaction = await migrate(tx as DatabaseInterface);
      expect(onTransaction.refused).toBe(false);
      await tx.commit();
      await expect(onDatabase).resolves.toMatchObject({ refused: false });
    },
    30_000,
  );
});
