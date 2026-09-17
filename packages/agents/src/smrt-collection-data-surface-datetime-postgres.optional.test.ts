/**
 * PostgreSQL lane for #2933.
 *
 * The SQLite regression lives in
 * `smrt-collection-data-surface.datetime.integration.test.ts`. This file proves
 * the same boundary on a real PostgreSQL database, where the driver hands back
 * `timestamptz` columns as `Date` objects and ids as native UUIDs — the shape
 * the reported anytown failure actually ran on.
 *
 * Skipped unless `SMRT_TEST_POSTGRES_URL` is set; run it through
 * `pnpm --filter @happyvertical/smrt-agents test:postgres`.
 */

import { randomUUID } from 'node:crypto';
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
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSurfaceExecutionContext } from './data-surface.js';
import {
  clearSmrtCollectionQuerySchemaCache,
  createSmrtCollectionDataSurfaceDefinition,
} from './smrt-collection-data-surface.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const postgresDescribe = pgUrl ? describe.sequential : describe.skip;

// PostgreSQL keeps tenant ids in a native `uuid` column, so the fixture tenant
// has to be a real UUID rather than a readable label.
const TENANT_ID = '5f1d4b2e-0a3c-4f7b-9c21-8d6e0f4a1b33';

const RFC_3339_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

@smrt({ tenantScoped: { mode: 'required' } })
class SmrtSurfacePgTemporalMeeting extends SmrtObject {
  @field({ type: 'text' })
  tenantId = '';

  @field({ type: 'text' })
  title = '';

  @field({ type: 'datetime', nullable: true })
  startsAt: Date | null = null;

  @field({ type: 'datetime', nullable: true })
  cancelledAt: Date | null = null;

  @field({ type: 'json' })
  agenda: Record<string, unknown> = {};

  constructor(options: Record<string, unknown> = {}) {
    super(options as any);
    for (const key of [
      'tenantId',
      'title',
      'startsAt',
      'cancelledAt',
      'agenda',
    ] as const) {
      if (options[key] !== undefined) {
        (this as Record<string, unknown>)[key] = options[key];
      }
    }
  }
}

class SmrtSurfacePgTemporalMeetingCollection extends SmrtCollection<SmrtSurfacePgTemporalMeeting> {
  static readonly _itemClass = SmrtSurfacePgTemporalMeeting;
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

postgresDescribe(
  'createSmrtCollectionDataSurfaceDefinition datetime serialization (#2933, PostgreSQL)',
  () => {
    let db: Awaited<ReturnType<typeof getDatabase>>;
    let meetings: SmrtSurfacePgTemporalMeetingCollection;

    beforeAll(async () => {
      db = await getDatabase({
        type: 'postgres',
        url: pgUrl,
        dbid: `smrt-test-2933-${randomUUID()}`,
        // The shared vitest schema preparation targets the whole registry;
        // this lane creates only the one class it queries.
        __smrtSkipVitestSchemaPreparation: true,
      } as Parameters<typeof getDatabase>[0]);
      await getTestDatabase({
        db: db as never,
        classes: ['SmrtSurfacePgTemporalMeeting'],
      });
      enableTenancy();
      meetings = await SmrtSurfacePgTemporalMeetingCollection.create({
        db: db as never,
      });
      await withTenant({ tenantId: TENANT_ID }, async () => {
        const scheduled = await meetings.create({
          tenantId: TENANT_ID,
          title: 'Council session',
          startsAt: new Date('2026-09-17T18:00:00.000Z'),
          agenda: { items: 3 },
        });
        await scheduled.save();
        const cancelled = await meetings.create({
          tenantId: TENANT_ID,
          title: 'Zoning hearing',
          startsAt: new Date('2026-09-18T18:00:00.000Z'),
          cancelledAt: new Date('2026-09-16T09:30:00.000Z'),
          agenda: { items: 0 },
        });
        await cancelled.save();
      });
    });

    afterAll(async () => {
      disableTenancy();
      ObjectRegistry.clear();
      clearSmrtCollectionQuerySchemaCache();
      await db?.close?.();
    });

    it('serializes populated timestamptz columns to ISO-8601 UTC instants', async () => {
      const definition = await createSmrtCollectionDataSurfaceDefinition({
        qualifiedName: 'SmrtSurfacePgTemporalMeeting',
        collectionName: 'meetings',
        exclude: ['context', 'slug'],
        collection: () => meetings,
        scope: (execution) => ({ tenantId: execution.principal.tenantId }),
      });

      const result = (await definition.execute?.(
        definition,
        {
          version: 1,
          requestId: 'pg-populated-datetimes',
          mode: 'rows',
          projection: [
            'id',
            'title',
            'startsAt',
            'cancelledAt',
            'created_at',
            'updated_at',
            'agenda',
          ],
          sort: [{ field: 'startsAt', direction: 'asc' }],
          page: { kind: 'offset', offset: 0, limit: 10 },
        },
        context(TENANT_ID),
      )) as { rows: Record<string, unknown>[]; total: { value: number } };

      expect(result.total.value).toBe(2);
      expect(result.rows[0]?.startsAt).toBe('2026-09-17T18:00:00.000Z');
      expect(result.rows[0]?.cancelledAt).toBeNull();
      expect(result.rows[1]?.cancelledAt).toBe('2026-09-16T09:30:00.000Z');
      for (const row of result.rows) {
        // Native UUID ids must survive as strings, not stringified objects.
        expect(typeof row.id).toBe('string');
        for (const key of ['created_at', 'updated_at']) {
          expect(String(row[key]), key).toMatch(RFC_3339_INSTANT);
        }
      }
      expect(result.rows[0]?.agenda).toMatchObject({ items: 3 });
    });
  },
);
