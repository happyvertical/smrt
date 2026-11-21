/**
 * A confirmed destructive change is on the migrate ledger if and only if it
 * committed (#5435). The confirmation row is written in the batch that drops
 * the table, so a run whose record step fails after the batch still leaves
 * exactly one confirmation, and the rerun completes the record without adding
 * another; a batch that rolls back leaves neither the drop nor the row.
 * SQLite.
 */

import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectRegistry } from '../../registry.js';
import { ensureSystemTables } from '../../system/bootstrap.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import { readConfirmedRetirements } from '../migrate-record.js';
import { migrateSmrtSchemas } from '../orchestrate.js';
import {
  type RetiredTable,
  registerRetiredTables,
  snapshotRegisteredRetiredTables,
} from '../retired-tables.js';

const failNextRecord = vi.hoisted(() => ({ armed: false }));
vi.mock('../migrate-record.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../migrate-record.js')>();
  return {
    ...original,
    recordSuccessfulMigrate: async (
      ...args: Parameters<typeof original.recordSuccessfulMigrate>
    ) => {
      if (failNextRecord.armed) {
        failNextRecord.armed = false;
        throw new Error('record step failed');
      }
      return original.recordSuccessfulMigrate(...args);
    },
  };
});

const PKG = '@ledger-confirm/fixture';
const TABLE = 'ledger_confirm_gone';

const retired = (): RetiredTable => ({
  table: TABLE,
  lastOwner: `${PKG}:Gone`,
  since: '1.0.0',
  reason: 'moved onto the order',
  rows: 'discard',
  // Differs from the live table, so the retirement needs confirming.
  definitions: [
    {
      release: '0.9.0',
      columns: { id: { type: 'TEXT' }, v: { type: 'TEXT' } },
    },
  ],
  packageName: PKG,
});

describe('confirmed retirement on the migrate ledger (SQLite)', () => {
  let restoreRegistry: () => void;
  let restoreRetired: () => void;
  let db: Awaited<ReturnType<typeof getDatabase>>;
  let runs = 0;

  beforeEach(async () => {
    restoreRegistry = snapshotObjectRegistryState();
    restoreRetired = snapshotRegisteredRetiredTables();
    ObjectRegistry.clear();
    failNextRecord.armed = false;
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    await db.query(
      `CREATE TABLE "${TABLE}" (id TEXT PRIMARY KEY, payload TEXT)`,
    );
    await db.query(`INSERT INTO "${TABLE}" VALUES ('1', 'x')`);
    registerRetiredTables(PKG, [retired()]);
  });
  afterEach(async () => {
    await db.close?.();
    restoreRetired();
    restoreRegistry();
  });

  const migrate = (confirm: boolean) =>
    migrateSmrtSchemas({
      db,
      packageName: '@ledger-confirm/app',
      name: `ledger_confirm_${++runs}`,
      engineHint: 'sqlite',
      ...(confirm ? { confirmRetireTables: [TABLE] } : {}),
    });
  const exists = async () =>
    (
      await db.query(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '${TABLE}'`,
      )
    ).rows.length > 0;
  const ledger = async () =>
    (
      await db.query(
        'SELECT release, packages, fingerprint, confirmed_retirements FROM _smrt_migrate_runs ORDER BY created_at, id',
      )
    ).rows;

  it('keeps the confirmation once when the record step fails after the batch, and the rerun completes the record', async () => {
    failNextRecord.armed = true;
    await expect(migrate(true)).rejects.toThrow('record step failed');
    expect(await exists()).toBe(false);

    const afterFailure = await ledger();
    expect(afterFailure).toHaveLength(1);
    expect(afterFailure[0].confirmed_retirements).not.toBeNull();
    const confirmations = await readConfirmedRetirements(db, {
      engineHint: 'sqlite',
    });
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0].retirements.map((r) => r.table)).toEqual([TABLE]);

    const rerun = await migrate(false);
    expect(rerun.refused).toBe(false);
    const afterRerun = await ledger();
    expect(afterRerun).toHaveLength(2);
    expect(afterRerun[0]).toEqual(afterFailure[0]);
    expect(afterRerun[1].confirmed_retirements).toBeNull();
    expect(afterRerun[1].fingerprint).not.toBe(afterRerun[0].fingerprint);
    expect(
      await readConfirmedRetirements(db, { engineHint: 'sqlite' }),
    ).toHaveLength(1);
  });

  it('writes no ledger row and keeps the table when the batch rolls back', async () => {
    await ensureSystemTables(db, 'sqlite');
    // Any insert into the ledger now fails, so the batch's last statement fails.
    await db.query(
      `CREATE TRIGGER ledger_confirm_refuse BEFORE INSERT ON _smrt_migrate_runs BEGIN SELECT RAISE(ABORT, 'ledger refused'); END`,
    );
    const before = await ledger();
    await expect(migrate(true)).rejects.toThrow();
    expect(await exists()).toBe(true);
    expect(await ledger()).toEqual(before);
  });
});
