import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SchemaComparer } from '../migrations/differ.js';
import { ObjectRegistry } from '../registry.js';
import { registerRuntimeModel } from '../runtime-model.js';
import { getDDLStrategy } from '../schema/ddl/index.js';
import { checkLiveSchemaParity } from '../schema/live-parity.js';
import { snapshotObjectRegistryState } from '../test-utils.js';

describe('managed generated-column catalog #4972 round5', () => {
  let restore: () => void;
  const databases: DatabaseInterface[] = [];
  beforeEach(() => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.clear();
  });
  afterEach(async () => {
    for (const db of databases.splice(0)) await db.close?.();
    restore();
  });

  it('real DuckDB ignores an unparsable unmanaged table when generated columns are expected', async () => {
    const sql =
      await vi.importActual<typeof import('@happyvertical/sql')>(
        '@happyvertical/sql',
      );
    const db = await sql.getDatabase({ type: 'duckdb', url: ':memory:' });
    databases.push(db);
    const name = registerRuntimeModel({
      name: 'ManagedGenerated',
      packageName: '@test/managed-catalog',
      tableName: 'managed_generated',
      fields: {
        qty: { type: 'integer' },
        total: { type: 'integer', generated: { col: 'qty' } },
      },
    });
    const schema = ObjectRegistry.getSchema(name)!;
    const strategy = getDDLStrategy('duckdb');
    await db.query(strategy.generateCreateTable(schema));
    for (const statement of strategy.generateIndexes(schema))
      await db.query(statement);
    await db.query(
      "CREATE TABLE unmanaged_parser_trap (note VARCHAR DEFAULT 'qty INTEGER GENERATED ALWAYS AS (')",
    );
    const schemas = { managed_generated: schema };
    expect(
      (await new SchemaComparer(db, { engineHint: 'duckdb' }).compare(schemas))
        .changes,
    ).toEqual([]);
    expect(
      (
        await checkLiveSchemaParity({
          db,
          schemas,
          engineHint: 'duckdb',
          includeSystemTables: false,
          reportExtraTables: false,
        })
      ).findings,
    ).toEqual([]);
  });
});
