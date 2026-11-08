import { randomUUID } from 'node:crypto';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import {
  getPendingSchemaStatements,
  migrateSmrtSchemas,
} from '@happyvertical/smrt-core/migrations';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_INFERENCE_SCOPE_ID, InferenceSettingsService } from '../server.js';

const TABLE = '_smrt_inference_overrides';

/** Narrow the registry to this table (the smrt-preferences precedent). */
function onlyThisTable(): void {
  const own = ObjectRegistry.getAllSchemasAsDefinitions()[TABLE];
  if (!own) throw new Error(`${TABLE} is not a registered schema`);
  vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue({
    [TABLE]: own,
  });
}

describe.each(['sqlite', 'duckdb'] as const)('override table (%s)', (type) => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    // Start empty, as a production database does before `smrt db:migrate`.
    db = await getDatabase({
      type,
      url: ':memory:',
      __smrtSkipVitestSchemaPreparation: true,
    } as Parameters<typeof getDatabase>[0]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close?.();
  });

  it('declares the table with closed generated surfaces', () => {
    const schema = ObjectRegistry.getAllSchemasAsDefinitions()[TABLE];
    expect(schema?.tableName).toBe(TABLE);
    expect(Object.keys(schema?.columns ?? {})).toEqual(
      expect.arrayContaining([
        'binding',
        'tenant_id',
        'target',
        'tenant_allow_list',
        'context',
      ]),
    );
    expect(
      (schema?.indexes ?? [])
        .filter((index) => index.unique)
        .map((index) => index.columns),
    ).toContainEqual(['binding', 'context']);
    expect(ObjectRegistry.getConfig('InferenceOverride')).toMatchObject({
      api: false,
      cli: false,
      mcp: false,
    });
  });

  it('is created by migrateSmrtSchemas, then reports parity and serves writes', async () => {
    onlyThisTable();
    const before = await getPendingSchemaStatements(db);
    expect(before.statements.join('\n')).toContain(TABLE);
    const result = await migrateSmrtSchemas({
      db,
      packageName: '@happyvertical/smrt-inference',
    });
    expect(result.applied).toBe(true);
    expect(result.hasManualDrift).toBe(false);
    const after = await getPendingSchemaStatements(db);
    expect(after.hasChanges).toBe(false);

    const admin = await InferenceSettingsService.create(
      { db },
      { config: () => ({}), authorize: () => true },
    );
    await admin.setTierOverride({
      tier: 'good',
      scopeType: 'app',
      scopeId: APP_INFERENCE_SCOPE_ID,
      target: { model: 'mini' },
    });
    // Updating the same scope reuses the row (unique on binding + context).
    await admin.setTierOverride({
      tier: 'good',
      scopeType: 'app',
      scopeId: APP_INFERENCE_SCOPE_ID,
      target: { model: 'mini-2' },
    });
    // A tenant row on a native-UUID engine is updated in place too.
    const tenantId = randomUUID();
    await admin.setTenantAllowList({ binding: 'tier:good', allowList: ['*'] });
    for (const model of ['t-1', 't-2']) {
      await admin.setTierOverride({
        tier: 'good',
        scopeType: 'tenant',
        scopeId: tenantId,
        target: { model },
      });
    }
    const [row] = await admin.listInferenceSettings({ tenantId });
    expect(row?.tier).toBe('cheap');
    const good = (await admin.listInferenceSettings({ tenantId })).find(
      (entry) => entry.tier === 'good',
    );
    expect(good?.tenantTarget).toEqual({ model: 't-2' });
    await admin.setTierOverride({
      tier: 'good',
      scopeType: 'tenant',
      scopeId: tenantId,
      target: null,
    });
    const { rows } = (await db.query(
      `SELECT binding, target FROM ${TABLE}`,
      [],
    )) as { rows: unknown[] };
    expect(rows).toEqual([
      { binding: 'tier:good', target: JSON.stringify({ model: 'mini-2' }) },
    ]);
  });

  it('never creates the table at runtime', async () => {
    const admin = await InferenceSettingsService.create(
      { db },
      { config: () => ({}) },
    );
    await expect(admin.listInferenceSettings()).rejects.toThrow();
  });
});
