/**
 * P22 (#4927): a run limited to tables (lazy activation, the run-time model
 * editor) skips the build's package comparison and writes no record, so on a
 * table the build owns it may only add. A decorated model's table counts as
 * the build's; a standalone run-time model's own table stays free. Runs on
 * SQLite, and on PGlite under `pnpm test:pglite`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { field } from '../../decorators/index.js';
import { SmrtObject } from '../../object.js';
import { ObjectRegistry } from '../../registry.js';
import { registerRuntimeModel } from '../../runtime-model.js';
import { inspectTableSchema } from '../../schema/inspection.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import { getTestDatabase } from '../../testing/database.js';
import { migrateSmrtSchemas } from '../orchestrate.js';

const databaseType = process.env.SMRT_TEST_PGLITE === '1' ? 'pglite' : 'sqlite';
const engine = databaseType === 'pglite' ? 'postgres' : 'sqlite';
const postgresOptions =
  engine === 'postgres'
    ? { atomic: true, postgresSafe: false, useConcurrentIndexes: false }
    : {};

describe(`table-limited runs on ${engine} (P22)`, () => {
  let restore: () => void;
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.clear();
    db = await getTestDatabase({
      type: databaseType,
      classes: [],
      includeSystemTables: false,
    });
  });
  afterEach(async () => {
    await db.close?.();
    restore();
  });

  const notNull = async (table: string, column: string) =>
    (await inspectTableSchema(db, table, engine))?.columns[column]?.notNull;

  it('refuses to relax a decorated model column when the class that required it is not loaded', async () => {
    // The full migrate ran with the hardening class loaded: code is NOT NULL.
    class Ticket extends SmrtObject {
      code = '';
    }
    field({ type: 'text', required: true })(Ticket.prototype, 'code');
    ObjectRegistry.register(Ticket, {
      packageName: '@p22/hardening',
      tableName: 'p22_tickets',
    });
    await migrateSmrtSchemas({
      db,
      packageName: '@p22/app',
      name: 'p22_run_1',
      engineHint: engine,
      ...postgresOptions,
    });
    expect(await notNull('p22_tickets', 'code')).toBe(true);

    // A later process loads only a looser declaration of the same table.
    ObjectRegistry.clear();
    class LooseTicket extends SmrtObject {
      code = '';
    }
    field({ type: 'text' })(LooseTicket.prototype, 'code');
    ObjectRegistry.register(LooseTicket, {
      packageName: '@p22/base',
      tableName: 'p22_tickets',
    });
    const result = await migrateSmrtSchemas({
      db,
      packageName: '@p22/app',
      name: 'p22_run_2',
      engineHint: engine,
      ...postgresOptions,
      tables: ['p22_tickets'],
      relaxColumns: true,
    });
    expect(result).toMatchObject({ applied: false, refused: true });
    expect(result.stops[0]).toMatchObject({ reason: 'build-table' });
    expect(result.stops[0].message).toMatch(/smrt db:migrate/);
    expect(await notNull('p22_tickets', 'code')).toBe(true);
  });

  it('lets a run-time list change its own table, which the build does not own', async () => {
    const def = (required: boolean) => ({
      packageName: '@p22/app',
      name: 'Mat',
      fields: { size: { type: 'text' as const, required } },
    });
    registerRuntimeModel(def(true));
    const table = ObjectRegistry.getTableName('@p22/app:Mat')!;
    const created = await migrateSmrtSchemas({
      db,
      packageName: '@p22/app',
      name: 'p22_run_3',
      engineHint: engine,
      ...postgresOptions,
      tables: [table],
    });
    expect(created.refused).toBe(false);
    expect(await notNull(table, 'size')).toBe(true);

    registerRuntimeModel(def(false), { refresh: true });
    const relaxed = await migrateSmrtSchemas({
      db,
      packageName: '@p22/app',
      name: 'p22_run_4',
      engineHint: engine,
      ...postgresOptions,
      tables: [table],
      relaxColumns: true,
    });
    expect(relaxed.refused).toBe(false);
    expect(await notNull(table, 'size')).toBe(false);
  });
});
