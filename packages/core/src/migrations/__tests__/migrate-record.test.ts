import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectRegistry } from '../../registry.js';
import type { SchemaDefinition } from '../../schema/types.js';
import { ensureSystemTables } from '../../system/bootstrap.js';
import { runRetentionSweep } from '../../system/retention.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import {
  collectMigrateRecordInput,
  readLastMigrateRecord,
  recordSuccessfulMigrate,
} from '../migrate-record.js';
import { migrateSmrtSchemas } from '../orchestrate.js';
import { MigrationTracker } from '../tracker.js';

const input = {
  release: '0.60.17',
  packages: ['@fixture/app'],
  fingerprint: 'a'.repeat(64),
};
const definition: SchemaDefinition = {
  tableName: 'migrate_record_entries',
  columns: { id: { type: 'TEXT', primaryKey: true, notNull: true } },
  indexes: [],
  foreignKeys: [],
  triggers: [],
  dependencies: [],
  version: '',
};

describe.each([
  'sqlite',
  'duckdb',
] as const)('migrate record on %s (#4926)', (engine) => {
  let db: DatabaseInterface;
  beforeEach(async () => {
    db = await getDatabase({ type: engine, url: ':memory:' });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close?.();
  });

  async function count() {
    return (await db.query('SELECT COUNT(*) AS count FROM _smrt_migrate_runs'))
      .rows[0].count;
  }

  it('returns none without provisioning and on an empty provisioned table', async () => {
    expect(await readLastMigrateRecord(db, { engineHint: engine })).toEqual({
      state: 'none',
    });
    await ensureSystemTables(db, engine);
    expect(await readLastMigrateRecord(db, { engineHint: engine })).toEqual({
      state: 'none',
    });
  });

  it('provisions on older databases and records all values without a tracker', async () => {
    await db.query(
      'CREATE TABLE _smrt_migrations (id TEXT PRIMARY KEY, version TEXT UNIQUE, description TEXT)',
    );
    await db.query(
      "INSERT INTO _smrt_migrations VALUES ('old', '1.15.0', 'old system schema')",
    );
    const result = await recordSuccessfulMigrate(db, {
      input,
      engineHint: engine,
    });
    expect(result.written).toBe(true);
    const last = await readLastMigrateRecord(db, { engineHint: engine });
    expect(last).toMatchObject({ state: 'recorded', record: input });
    if (last.state === 'recorded')
      expect(Number.isNaN(Date.parse(last.record.createdAt))).toBe(false);
  });

  it('normalizes packages, skips retries and appends when each recorded value changes', async () => {
    const first = await recordSuccessfulMigrate(db, {
      input: { ...input, packages: ['z', 'a', 'z'] },
      engineHint: engine,
    });
    expect(first.record.packages).toEqual(['a', 'z']);
    expect(
      (
        await recordSuccessfulMigrate(db, {
          input: { ...input, packages: ['a', 'z'] },
          engineHint: engine,
        })
      ).written,
    ).toBe(false);
    expect(Number(await count())).toBe(1);
    for (const change of [
      { release: 'next' },
      { packages: ['new'] },
      { fingerprint: 'b'.repeat(64) },
    ]) {
      expect(
        (
          await recordSuccessfulMigrate(db, {
            input: { ...first.record, ...change },
            engineHint: engine,
          })
        ).written,
      ).toBe(true);
    }
    expect(Number(await count())).toBe(4);
    expect(
      await readLastMigrateRecord(db, { engineHint: engine }),
    ).toMatchObject({
      state: 'recorded',
      record: { fingerprint: 'b'.repeat(64) },
    });
    const oldest = await db.query(
      'SELECT release FROM _smrt_migrate_runs ORDER BY created_at, id LIMIT 1',
    );
    expect(oldest.rows[0].release).toBe(input.release);
    await runRetentionSweep(db, {
      changes: { maxAgeDays: 0 },
      aiUsage: { maxAgeDays: 0 },
      aiTranscripts: { maxAgeDays: 0 },
      runOnceClaims: { maxAgeDays: 0 },
    });
    expect(Number(await count())).toBe(4);
  });

  it('serializes concurrent identical calls without a tracker', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        recordSuccessfulMigrate(db, { input, engineHint: engine }),
      ),
    );
    expect(results.filter((result) => result.written)).toHaveLength(1);
    expect(Number(await count())).toBe(1);
  });

  it('writes on the supplied transaction and preserves the previous record on rollback', async () => {
    await recordSuccessfulMigrate(db, { input, engineHint: engine });
    const previous = await readLastMigrateRecord(db, { engineHint: engine });
    if (!db.transaction) throw new Error('Transaction support required');
    await expect(
      db.transaction(async (tx) => {
        await recordSuccessfulMigrate(tx, {
          input: { ...input, release: 'rolled-back' },
          engineHint: engine,
        });
        expect(
          await readLastMigrateRecord(tx, { engineHint: engine }),
        ).toMatchObject({
          state: 'recorded',
          record: { release: 'rolled-back' },
        });
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    expect(await readLastMigrateRecord(db, { engineHint: engine })).toEqual(
      previous,
    );
  });

  it('orders timestamp ties by id', async () => {
    await ensureSystemTables(db, engine);
    const date = '2026-01-01T00:00:00.000Z';
    for (const id of ['a', 'z']) {
      await db.execute`INSERT INTO _smrt_migrate_runs (id, release, packages, fingerprint, created_at) VALUES (${id}, ${id}, ${'[]'}, ${input.fingerprint}, ${date})`;
    }
    expect(
      await readLastMigrateRecord(db, { engineHint: engine }),
    ).toMatchObject({ state: 'recorded', record: { release: 'z' } });
  });

  it('retains the previous row when insertion fails', async () => {
    await recordSuccessfulMigrate(db, { input, engineHint: engine });
    const previous = await readLastMigrateRecord(db, { engineHint: engine });
    vi.spyOn(db, 'execute').mockRejectedValueOnce(
      new Error('injected insert failure'),
    );
    await expect(
      recordSuccessfulMigrate(db, {
        input: { ...input, release: 'next' },
        engineHint: engine,
      }),
    ).rejects.toThrow('injected insert failure');
    expect(await readLastMigrateRecord(db, { engineHint: engine })).toEqual(
      previous,
    );
  });
});

describe('core orchestration records successful runs (#4926)', () => {
  let db: DatabaseInterface;
  let restore: () => void;
  beforeEach(async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    restore = snapshotObjectRegistryState();
    ObjectRegistry.clear();
    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue({
      [definition.tableName]: structuredClone(definition),
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    restore();
    await db.close?.();
  });

  it('records after successful apply and does not append an identical in-sync run', async () => {
    await migrateSmrtSchemas({ db, packageName: '@fixture/app' });
    expect(await readLastMigrateRecord(db)).toMatchObject({
      state: 'recorded',
      record: collectMigrateRecordInput(),
    });
    await migrateSmrtSchemas({ db, packageName: '@fixture/app' });
    expect(
      Number(
        (await db.query('SELECT COUNT(*) AS count FROM _smrt_migrate_runs'))
          .rows[0].count,
      ),
    ).toBe(1);
  });

  it('records the first in-sync run under this scheme', async () => {
    await db.query(
      'CREATE TABLE migrate_record_entries (id TEXT PRIMARY KEY NOT NULL)',
    );
    expect(
      (await migrateSmrtSchemas({ db, packageName: '@fixture/app' })).applied,
    ).toBe(false);
    expect((await readLastMigrateRecord(db)).state).toBe('recorded');
  });

  it('does not stamp when any stop remains, even after other changes apply', async () => {
    await recordSuccessfulMigrate(db, { input: collectMigrateRecordInput() });
    const previous = await readLastMigrateRecord(db);
    await db.query(
      'CREATE TABLE migrate_record_entries (id TEXT PRIMARY KEY NOT NULL)',
    );
    await db.query("INSERT INTO migrate_record_entries VALUES ('existing')");
    const changed = structuredClone(definition);
    changed.columns.score = { type: 'INTEGER', notNull: true };
    changed.columns.title = { type: 'TEXT' };
    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue({
      [changed.tableName]: changed,
    });
    const result = await migrateSmrtSchemas({
      db,
      packageName: '@fixture/app',
    });
    expect(result.hasManualDrift).toBe(true);
    expect(await readLastMigrateRecord(db)).toEqual(previous);
  });

  it('does not stamp after a failed migration', async () => {
    await recordSuccessfulMigrate(db, { input: collectMigrateRecordInput() });
    const previous = await readLastMigrateRecord(db);
    vi.spyOn(MigrationTracker.prototype, 'applyAll').mockRejectedValueOnce(
      new Error('migration failed'),
    );
    await expect(
      migrateSmrtSchemas({ db, packageName: '@fixture/app' }),
    ).rejects.toThrow('migration failed');
    expect(await readLastMigrateRecord(db)).toEqual(previous);
  });
});
