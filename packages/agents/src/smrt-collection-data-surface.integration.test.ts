/**
 * Real-SQLite integration test for the generic SmrtObject collection ->
 * DataSurface adapter (#2905), following the pattern in
 * `packages/smrt-svelte/src/web/__tests__/data-surface-conformance.integration.svelte.test.ts`:
 * a real registered `@smrt()` class, a real `SmrtCollection`, and a real
 * in-memory SQLite database — only the schema is derived from the registry
 * rather than hand-authored.
 */

import {
  field,
  getTestDatabase,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSurfaceExecutionContext } from './data-surface.js';
import {
  clearSmrtCollectionQuerySchemaCache,
  createSmrtCollectionDataSurfaceDefinition,
} from './smrt-collection-data-surface.js';

@smrt({ tenantScoped: { mode: 'required' } })
class SmrtSurfaceIntegrationTask extends SmrtObject {
  @field({ type: 'text' })
  tenantId = '';

  @field({ type: 'text' })
  title = '';

  @field({ type: 'text' })
  status = 'open';

  @field({ type: 'text', sensitive: true })
  internalCost = '';

  constructor(
    options: { tenantId?: string; title?: string; status?: string } = {},
  ) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.title !== undefined) this.title = options.title;
    if (options.status !== undefined) this.status = options.status;
  }
}

class SmrtSurfaceIntegrationTaskCollection extends SmrtCollection<SmrtSurfaceIntegrationTask> {
  static readonly _itemClass = SmrtSurfaceIntegrationTask;
}

function context(tenantId: string): DataSurfaceExecutionContext {
  return {
    run: {
      context: { userId: 'user-a', tenantId },
    } as DataSurfaceExecutionContext['run'],
    principal: { userId: 'user-a', tenantId },
    signal: new AbortController().signal,
  };
}

describe('createSmrtCollectionDataSurfaceDefinition (real SQLite)', () => {
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  let tasks: SmrtSurfaceIntegrationTaskCollection;

  beforeAll(async () => {
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['SmrtSurfaceIntegrationTask'],
    });
    enableTenancy();
    tasks = await SmrtSurfaceIntegrationTaskCollection.create({ db });
    await withTenant({ tenantId: 'tenant-a' }, async () => {
      const a = await tasks.create({
        tenantId: 'tenant-a',
        title: 'Ship the report',
        status: 'open',
      });
      a.internalCost = '4200';
      await a.save();
      const b = await tasks.create({
        tenantId: 'tenant-a',
        title: 'Review the PR',
        status: 'closed',
      });
      b.internalCost = '1500';
      await b.save();
    });
    await withTenant({ tenantId: 'tenant-b' }, async () => {
      const hidden = await tasks.create({
        tenantId: 'tenant-b',
        title: 'Hidden tenant task',
        status: 'open',
      });
      hidden.internalCost = '9999';
      await hidden.save();
    });
  });

  afterAll(async () => {
    disableTenancy();
    ObjectRegistry.clear();
    clearSmrtCollectionQuerySchemaCache();
    await db?.close?.();
  });

  it('builds a registry-derived schema, enforces tenant scope, and redacts the sensitive field', async () => {
    const definition = await createSmrtCollectionDataSurfaceDefinition({
      qualifiedName: 'SmrtSurfaceIntegrationTask',
      collectionName: 'tasks',
      exclude: ['context', 'created_at', 'updated_at', 'slug'],
      collection: () => tasks,
      scope: (execution) => ({ tenantId: execution.principal.tenantId }),
    });

    const declaredIds = definition.schema.fields.map((field_) => field_.id);
    expect(declaredIds.sort()).toEqual(['id', 'status', 'title']);
    expect(declaredIds).not.toContain('internalCost');
    expect(declaredIds).not.toContain('tenantId');

    const result = await definition.execute?.(
      definition,
      {
        version: 1,
        requestId: 'tenant-a-rows',
        mode: 'rows',
        projection: ['id', 'title', 'status'],
        sort: [{ field: 'title', direction: 'asc' }],
        page: { kind: 'offset', offset: 0, limit: 10 },
      },
      context('tenant-a'),
    );

    expect(result).toMatchObject({ total: { kind: 'exact', value: 2 } });
    const rows = (result as { rows: Record<string, unknown>[] }).rows;
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.title).sort()).toEqual([
      'Review the PR',
      'Ship the report',
    ]);
    // Never returned, whatever the caller asks for: excluded at the schema
    // boundary, so it is not even a legal projection field.
    for (const row of rows) {
      expect(row).not.toHaveProperty('internalCost');
      expect(row).not.toHaveProperty('tenantId');
    }
    expect(JSON.stringify(result)).not.toContain('9999');
    expect(JSON.stringify(result)).not.toContain('4200');

    // The other tenant's row never crosses the boundary, even under a wide
    // page limit.
    const other = await definition.execute?.(
      definition,
      {
        version: 1,
        requestId: 'tenant-b-rows',
        mode: 'rows',
        projection: ['id', 'title'],
        page: { kind: 'offset', offset: 0, limit: 10 },
      },
      context('tenant-b'),
    );
    const otherRows = (other as { rows: Record<string, unknown>[] }).rows;
    expect(otherRows).toHaveLength(1);
    expect(otherRows[0]?.title).toBe('Hidden tenant task');
  });

  it('rejects a request naming the sensitive field before the collection is queried', async () => {
    const definition = await createSmrtCollectionDataSurfaceDefinition({
      qualifiedName: 'SmrtSurfaceIntegrationTask',
      collectionName: 'tasks',
      exclude: ['context', 'created_at', 'updated_at', 'slug'],
      collection: () => tasks,
      scope: (execution) => ({ tenantId: execution.principal.tenantId }),
    });

    await expect(
      definition.execute?.(
        definition,
        {
          version: 1,
          requestId: 'hostile-projection',
          mode: 'rows',
          projection: ['id', 'internalCost'],
          page: { kind: 'offset', offset: 0, limit: 10 },
        },
        context('tenant-a'),
      ),
    ).rejects.toThrow(/projection field is not allowed: internalCost/);
  });

  it('filters and facets rows through the real collection within declared capabilities', async () => {
    const definition = await createSmrtCollectionDataSurfaceDefinition({
      qualifiedName: 'SmrtSurfaceIntegrationTask',
      collectionName: 'tasks',
      exclude: ['context', 'created_at', 'updated_at', 'slug'],
      collection: () => tasks,
      scope: (execution) => ({ tenantId: execution.principal.tenantId }),
    });

    const filtered = await definition.execute?.(
      definition,
      {
        version: 1,
        requestId: 'filtered-rows',
        mode: 'rows',
        projection: ['id', 'title'],
        filter: {
          kind: 'condition',
          field: 'status',
          operator: 'eq',
          value: 'open',
        },
        page: { kind: 'offset', offset: 0, limit: 10 },
      },
      context('tenant-a'),
    );
    const filteredRows = (filtered as { rows: Record<string, unknown>[] }).rows;
    expect(filteredRows).toHaveLength(1);
    expect(filteredRows[0]?.title).toBe('Ship the report');

    const facets = await definition.execute?.(
      definition,
      {
        version: 1,
        requestId: 'status-facets',
        mode: 'facets',
        facets: [{ field: 'status', limit: 10 }],
      },
      context('tenant-a'),
    );
    expect(facets).toMatchObject({
      facets: [
        {
          field: 'status',
          values: expect.arrayContaining([
            expect.objectContaining({ value: 'open', count: 1 }),
            expect.objectContaining({ value: 'closed', count: 1 }),
          ]),
        },
      ],
    });
  });
});
