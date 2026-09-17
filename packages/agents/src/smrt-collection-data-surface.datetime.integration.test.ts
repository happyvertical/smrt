/**
 * Real-SQLite regression test for #2933: every row the surface returns carries
 * a NON-NULL datetime.
 *
 * `smrt-collection-data-surface.integration.test.ts` excludes `created_at` /
 * `updated_at` and declares no datetime column of its own, so every row it
 * asserts on has all-null datetimes — which is exactly why the original
 * fixture passed while any real collection returned a 502. This file keeps the
 * base timestamps projectable and adds populated `datetime` columns, a
 * date-only column, a nullable one, and a `json` document holding a nested
 * `Date`.
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

const RFC_3339_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

@smrt({ tenantScoped: { mode: 'required' } })
class SmrtSurfaceTemporalMeeting extends SmrtObject {
  @field({ type: 'text' })
  tenantId = '';

  @field({ type: 'text' })
  title = '';

  @field({ type: 'datetime', nullable: true })
  startsAt: Date | null = null;

  @field({ type: 'datetime', nullable: true })
  cancelledAt: Date | null = null;

  @field({ type: 'datetime', nullable: true })
  meetingDate: Date | null = null;

  @field({ type: 'json', sqlType: 'TEXT' })
  agenda: Record<string, unknown> = {};

  constructor(options: Record<string, unknown> = {}) {
    super(options as any);
    for (const key of [
      'tenantId',
      'title',
      'startsAt',
      'cancelledAt',
      'meetingDate',
      'agenda',
    ] as const) {
      if (options[key] !== undefined) {
        (this as Record<string, unknown>)[key] = options[key];
      }
    }
  }
}

class SmrtSurfaceTemporalMeetingCollection extends SmrtCollection<SmrtSurfaceTemporalMeeting> {
  static readonly _itemClass = SmrtSurfaceTemporalMeeting;
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

describe('createSmrtCollectionDataSurfaceDefinition with populated datetimes (#2933, real SQLite)', () => {
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  let meetings: SmrtSurfaceTemporalMeetingCollection;

  beforeAll(async () => {
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['SmrtSurfaceTemporalMeeting'],
    });
    enableTenancy();
    meetings = await SmrtSurfaceTemporalMeetingCollection.create({ db });
    await withTenant({ tenantId: 'tenant-a' }, async () => {
      const scheduled = await meetings.create({
        tenantId: 'tenant-a',
        title: 'Council session',
        startsAt: new Date('2026-09-17T18:00:00.000Z'),
        meetingDate: new Date('2026-09-17T00:00:00.000Z'),
        agenda: { items: 3, postedAt: new Date('2026-09-10T00:00:00.000Z') },
      });
      await scheduled.save();
      const cancelled = await meetings.create({
        tenantId: 'tenant-a',
        title: 'Zoning hearing',
        startsAt: new Date('2026-09-18T18:00:00.000Z'),
        cancelledAt: new Date('2026-09-16T09:30:00.000Z'),
        meetingDate: new Date('2026-09-18T00:00:00.000Z'),
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

  async function surface() {
    return createSmrtCollectionDataSurfaceDefinition({
      qualifiedName: 'SmrtSurfaceTemporalMeeting',
      collectionName: 'meetings',
      exclude: ['context', 'slug'],
      collection: () => meetings,
      scope: (execution) => ({ tenantId: execution.principal.tenantId }),
    });
  }

  it('advertises the datetime columns as datetime descriptors', async () => {
    const definition = await surface();
    const byId = new Map(
      definition.schema.fields.map((entry) => [entry.id, entry]),
    );
    for (const id of [
      'startsAt',
      'cancelledAt',
      'meetingDate',
      'created_at',
      'updated_at',
    ]) {
      expect(byId.get(id)?.type, id).toBe('datetime');
    }
    expect(byId.get('agenda')?.type).toBe('json');
  });

  it('returns rows whose populated datetimes are ISO-8601 UTC instants', async () => {
    const definition = await surface();
    const result = (await definition.execute?.(
      definition,
      {
        version: 1,
        requestId: 'populated-datetimes',
        mode: 'rows',
        projection: [
          'id',
          'title',
          'startsAt',
          'cancelledAt',
          'meetingDate',
          'created_at',
          'updated_at',
        ],
        sort: [{ field: 'title', direction: 'asc' }],
        page: { kind: 'offset', offset: 0, limit: 10 },
      },
      context('tenant-a'),
    )) as { rows: Record<string, unknown>[]; total: { value: number } };

    expect(result.total.value).toBe(2);
    expect(result.rows).toHaveLength(2);
    const [council, zoning] = result.rows;

    expect(council?.title).toBe('Council session');
    expect(council?.startsAt).toBe('2026-09-17T18:00:00.000Z');
    expect(council?.meetingDate).toBe('2026-09-17T00:00:00.000Z');
    // A nullable datetime that is actually null stays null.
    expect(council?.cancelledAt).toBeNull();

    expect(zoning?.cancelledAt).toBe('2026-09-16T09:30:00.000Z');

    // The base object's own timestamps — the columns that made this fail for
    // essentially every registered class — are populated and serialized.
    for (const row of result.rows) {
      for (const key of ['created_at', 'updated_at']) {
        expect(typeof row[key], key).toBe('string');
        expect(String(row[key])).toMatch(RFC_3339_INSTANT);
      }
      expect(row.startsAt).toMatch(RFC_3339_INSTANT);
    }
  });

  it('serializes datetimes on the default projection and the cursor path', async () => {
    const definition = await surface();
    const first = (await definition.execute?.(
      definition,
      {
        version: 1,
        requestId: 'cursor-page-1',
        mode: 'rows',
        projection: ['id', 'startsAt', 'created_at'],
        sort: [{ field: 'startsAt', direction: 'asc' }],
        page: { kind: 'cursor', limit: 1 },
      },
      context('tenant-a'),
    )) as {
      rows: Record<string, unknown>[];
      page: { hasMore: boolean; nextCursor?: string };
    };
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]?.startsAt).toBe('2026-09-17T18:00:00.000Z');
    expect(first.page.hasMore).toBe(true);

    const second = (await definition.execute?.(
      definition,
      {
        version: 1,
        requestId: 'cursor-page-2',
        mode: 'rows',
        projection: ['id', 'startsAt', 'created_at'],
        sort: [{ field: 'startsAt', direction: 'asc' }],
        page: { kind: 'cursor', limit: 1, after: first.page.nextCursor },
      },
      context('tenant-a'),
    )) as { rows: Record<string, unknown>[] };
    expect(second.rows[0]?.startsAt).toBe('2026-09-18T18:00:00.000Z');
    expect(String(second.rows[0]?.created_at)).toMatch(RFC_3339_INSTANT);
  });

  it('filters on a datetime column and returns a serialized json document', async () => {
    const definition = await surface();
    const result = (await definition.execute?.(
      definition,
      {
        version: 1,
        requestId: 'datetime-filter',
        mode: 'rows',
        projection: ['id', 'title', 'startsAt', 'agenda'],
        filter: {
          kind: 'condition',
          field: 'startsAt',
          operator: 'gte',
          value: '2026-09-18T00:00:00.000Z',
        },
        page: { kind: 'offset', offset: 0, limit: 10 },
      },
      context('tenant-a'),
    )) as { rows: Record<string, unknown>[] };
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.title).toBe('Zoning hearing');
    expect(result.rows[0]?.startsAt).toBe('2026-09-18T18:00:00.000Z');
    expect(result.rows[0]?.agenda).toMatchObject({ items: 0 });
  });
});
