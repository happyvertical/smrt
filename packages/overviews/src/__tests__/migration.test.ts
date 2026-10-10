import { randomUUID } from 'node:crypto';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import {
  getPendingSchemaStatements,
  migrateSmrtSchemas,
} from '@happyvertical/smrt-core/migrations';
import {
  resetTenancy,
  setupTestTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CUSTOMIZE_OVERVIEW_PERMISSION,
  createOverviewStore,
} from '../index.js';
import { buildDefinition, buildRegistry } from './store-suite.js';

const TABLE = '_smrt_overview_overrides';

/**
 * The table ships through the manifest-driven migration path (`smrt
 * db:migrate` -> `migrateSmrtSchemas`), never runtime DDL. The registry is
 * narrowed to this package's table, the core orchestrator precedent, because
 * smrt-users' own tables (registered by this package's permission import)
 * carry ON UPDATE CASCADE foreign keys DuckDB cannot create.
 */
function onlyThisTable(): void {
  const all = ObjectRegistry.getAllSchemasAsDefinitions();
  const own = all[TABLE];
  if (!own) throw new Error(`${TABLE} is not a registered schema`);
  vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue({
    [TABLE]: own,
  });
}

describe.each(['sqlite', 'duckdb'] as const)('migration (%s)', (type) => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    setupTestTenancy();
    // Skip smrt-vitest's automatic test schema so the database starts empty,
    // as a production database does before `smrt db:migrate`.
    db = await getDatabase({
      type,
      url: ':memory:',
      __smrtSkipVitestSchemaPreparation: true,
    } as Parameters<typeof getDatabase>[0]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetTenancy();
    await db.close?.();
  });

  it('declares the system table with a total natural key', () => {
    const schema = ObjectRegistry.getAllSchemasAsDefinitions()[TABLE];
    expect(schema?.tableName).toBe(TABLE);
    expect(Object.keys(schema?.columns ?? {})).toEqual(
      expect.arrayContaining([
        'tenant_id',
        'overview_id',
        'scope_type',
        'user_id',
        'scope_key',
        'override_json',
        'format_version',
        'updated_by',
        'updated_at',
      ]),
    );
    const unique = (schema?.indexes ?? []).filter((index) => index.unique);
    expect(unique.map((index) => index.columns)).toContainEqual([
      'tenant_id',
      'overview_id',
      'scope_type',
      'scope_key',
    ]);
    expect(ObjectRegistry.getConfig('OverviewOverrideRecord')).toMatchObject({
      api: { include: [] },
      cli: false,
      mcp: { include: [] },
    });
  });

  it('creates the table through migrateSmrtSchemas and then reports parity', async () => {
    onlyThisTable();
    const before = await getPendingSchemaStatements(db);
    expect(before.hasChanges).toBe(true);
    expect(before.statements.join('\n')).toContain(TABLE);

    const result = await migrateSmrtSchemas({
      db,
      packageName: '@happyvertical/smrt-overviews',
    });
    expect(result.applied).toBe(true);
    expect(result.hasManualDrift).toBe(false);

    // `db:status --parity` is the same diff: nothing left to apply.
    const after = await getPendingSchemaStatements(db);
    expect(after.hasChanges).toBe(false);
    expect(after.statements).toEqual([]);
    expect(after.hasManualDrift).toBe(false);

    // The migrated table serves the store.
    const store = createOverviewStore({ db });
    const tenantId = randomUUID();
    const userId = randomUUID();
    const definition = buildDefinition();
    const registry = buildRegistry();
    const saved = await withTenant(
      {
        tenantId,
        userId,
        permissions: new Set([CUSTOMIZE_OVERVIEW_PERMISSION]),
      },
      () =>
        store.save(definition, registry, {
          scope: 'tenant',
          override: { version: 1, removed: ['w2'] },
          revision: null,
        }),
    );
    expect(saved.ok).toBe(true);

    // The unique index refuses a second row for the same tier.
    const now = new Date().toISOString();
    await expect(
      db.insert(TABLE, {
        id: randomUUID(),
        slug: randomUUID(),
        context: '',
        created_at: now,
        updated_at: now,
        tenant_id: tenantId,
        overview_id: definition.id,
        scope_type: 'tenant',
        scope_key: '__tenant__',
        override_json: '{"version":1}',
        format_version: 1,
      }),
    ).rejects.toThrow();
  });

  it('never creates the table at runtime', async () => {
    const store = createOverviewStore({ db });
    await expect(
      withTenant(
        {
          tenantId: randomUUID(),
          userId: randomUUID(),
          permissions: new Set([CUSTOMIZE_OVERVIEW_PERMISSION]),
        },
        () => store.load(buildDefinition(), buildRegistry()),
      ),
    ).rejects.toThrow();
    onlyThisTable();
    const pending = await getPendingSchemaStatements(db);
    expect(pending.diff.added_tables.map((table) => table.tableName)).toEqual([
      TABLE,
    ]);
  });
});
