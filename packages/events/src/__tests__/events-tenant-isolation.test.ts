/**
 * Regression tests for the tenant-global query helpers (#1600) in smrt-events.
 *
 * Event / EventParticipant / EventSeries / EventType are all
 * `@TenantScoped({ mode: 'optional' })`. Their collections used to expose:
 *   findGlobal()         → list({ where: { tenantId: null } })
 *   findWithGlobals(tid)  → raw `WHERE tenant_id = ? OR tenant_id IS NULL`
 * Under an ACTIVE tenant context with tenancy enabled (default `'throw'`
 * policy) BOTH throw: the explicit `tenant_id IS NULL` filter is flagged as an
 * isolation violation, and unflagged raw SQL on a tenant-scoped class is
 * blocked. `findWithGlobals` also trusted its caller-supplied `tenantId`.
 *
 * They now route through the shared `@happyvertical/smrt-tenancy` helpers, which
 * run raw with `{ allowRawOnTenantScoped: true }` and fail closed when an active
 * tenant context requests another tenant's rows (admin/system path keeps the
 * cross-tenant capability). Mirrors
 * `packages/ledgers/src/__tests__/ledgers-tenant-isolation.test.ts`.
 *
 * Real in-memory SQLite, no DB mocking, tenancy enabled under the default
 * `'throw'` policy, per `.claude/rules/testing.md`.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventCollection } from '../collections/EventCollection';
import { EventParticipantCollection } from '../collections/EventParticipantCollection';
import { EventSeriesCollection } from '../collections/EventSeriesCollection';
import { EventTypeCollection } from '../collections/EventTypeCollection';

const sorted = (rows: Array<Record<string, any>>, field: string): string[] =>
  rows.map((r) => String(r[field] ?? '')).sort();

describe('events tenant isolation (#1600)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy(); // default rawQueryPolicy: 'throw'
  });

  afterEach(async () => {
    disableTenancy();
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  it('EventCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const events = await EventCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (await events.create({ name: 't1-event' })).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (await events.create({ name: 't2-event' })).save();
    });
    await withSystemContext(async () => {
      await (await events.create({ name: 'g-event' })).save();
    });

    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () => events.findGlobal()),
        'name',
      ),
    ).toEqual(['g-event']);
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          events.findWithGlobals('tenant-1'),
        ),
        'name',
      ),
    ).toEqual(['g-event', 't1-event']);
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        events.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);
    expect(
      sorted(
        await withSystemContext(() => events.findWithGlobals('tenant-2')),
        'name',
      ),
    ).toEqual(['g-event', 't2-event']);
  });

  it('EventParticipantCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const participants = await EventParticipantCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (
        await participants.create({
          eventId: 'e1',
          profileId: 'p1',
          role: 'player',
          groupId: 't1-part',
        })
      ).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (
        await participants.create({
          eventId: 'e2',
          profileId: 'p2',
          role: 'player',
          groupId: 't2-part',
        })
      ).save();
    });
    await withSystemContext(async () => {
      await (
        await participants.create({
          eventId: 'eg',
          profileId: 'pg',
          role: 'player',
          groupId: 'g-part',
        })
      ).save();
    });

    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          participants.findGlobal(),
        ),
        'groupId',
      ),
    ).toEqual(['g-part']);
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          participants.findWithGlobals('tenant-1'),
        ),
        'groupId',
      ),
    ).toEqual(['g-part', 't1-part']);
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        participants.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);
    expect(
      sorted(
        await withSystemContext(() => participants.findWithGlobals('tenant-2')),
        'groupId',
      ),
    ).toEqual(['g-part', 't2-part']);
  });

  it('EventSeriesCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const series = await EventSeriesCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (await series.create({ name: 't1-series' })).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (await series.create({ name: 't2-series' })).save();
    });
    await withSystemContext(async () => {
      await (await series.create({ name: 'g-series' })).save();
    });

    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () => series.findGlobal()),
        'name',
      ),
    ).toEqual(['g-series']);
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          series.findWithGlobals('tenant-1'),
        ),
        'name',
      ),
    ).toEqual(['g-series', 't1-series']);
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        series.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);
    expect(
      sorted(
        await withSystemContext(() => series.findWithGlobals('tenant-2')),
        'name',
      ),
    ).toEqual(['g-series', 't2-series']);
  });

  it('EventTypeCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const types = await EventTypeCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (await types.create({ name: 't1-type' })).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (await types.create({ name: 't2-type' })).save();
    });
    await withSystemContext(async () => {
      await (await types.create({ name: 'g-type' })).save();
    });

    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () => types.findGlobal()),
        'name',
      ),
    ).toEqual(['g-type']);
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          types.findWithGlobals('tenant-1'),
        ),
        'name',
      ),
    ).toEqual(['g-type', 't1-type']);
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        types.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);
    expect(
      sorted(
        await withSystemContext(() => types.findWithGlobals('tenant-2')),
        'name',
      ),
    ).toEqual(['g-type', 't2-type']);
  });
});
