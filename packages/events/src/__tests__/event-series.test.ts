/**
 * EventSeries model + EventSeriesCollection integration tests.
 *
 * Exercises recurrence patterns (daily/weekly/monthly/yearly), metadata
 * helpers, active-window checks, relationship loads to events and type,
 * and the collection's organizer/type/date filters and tenant scoping.
 * Real in-memory SQLite, no mocks.
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EventCollection,
  EventSeries,
  EventSeriesCollection,
} from '../index.js';
import type { RecurrencePattern } from '../types';

function getTestDbUrl(name: string): string {
  return `file:${join(tmpdir(), `${name}-${randomUUID()}.db`)}`;
}

async function makeSeries(name: string, dbUrl = getTestDbUrl(name)) {
  const series = await EventSeriesCollection.create({
    db: { type: 'sqlite', url: dbUrl },
  });
  return { dbUrl, series };
}

describe('EventSeries model', () => {
  it('persists core fields and round-trips a weekly recurrence pattern', async () => {
    const { series } = await makeSeries('series-recurrence');

    const pattern: RecurrencePattern = {
      frequency: 'weekly',
      interval: 1,
      byDay: ['MO', 'WE', 'FR'],
      count: 12,
    };

    const created = await series.create({
      name: 'Summer League 2024',
      description: 'Weekly summer league',
      source: 'espn',
      externalId: 'ext-123',
    });
    created.setRecurrence(pattern);
    await created.save();

    const loaded = await series.get({ id: created.id });
    expect(loaded?.name).toBe('Summer League 2024');
    expect(loaded?.source).toBe('espn');
    expect(loaded?.externalId).toBe('ext-123');
    expect(loaded?.getRecurrence()).toEqual(pattern);
  });

  it.each<RecurrencePattern>([
    { frequency: 'daily', interval: 2 },
    { frequency: 'weekly', byDay: ['TU'] },
    { frequency: 'monthly', byMonthDay: [1, 15] },
    { frequency: 'yearly', byMonth: [6] },
  ])('round-trips a %s recurrence frequency', async (pattern) => {
    const { series } = await makeSeries(`series-freq-${pattern.frequency}`);
    const created = await series.create({
      name: `${pattern.frequency} series`,
      recurrence: JSON.stringify(pattern),
    });
    await created.save();

    const loaded = await series.get({ id: created.id });
    expect(loaded?.getRecurrence()).toEqual(pattern);
  });

  it('accepts a recurrence supplied as a JSON string', async () => {
    const s = new EventSeries({
      name: 'String recurrence',
      recurrence: '{"frequency":"monthly","interval":3}',
    });
    expect(s.getRecurrence()).toEqual({ frequency: 'monthly', interval: 3 });
  });

  it('returns null recurrence when unset or malformed', async () => {
    const s = new EventSeries({ name: 'No recurrence' });
    expect(s.getRecurrence()).toBeNull();

    s.recurrence = 'broken{json';
    expect(s.getRecurrence()).toBeNull();
  });

  it('supports the setRecurrence setter', async () => {
    const { series } = await makeSeries('series-set-recurrence');
    const s = await series.create({ name: 'Mutable series' });
    s.setRecurrence({ frequency: 'daily', interval: 1 });
    await s.save();

    const loaded = await series.get({ id: s.id });
    expect(loaded?.getRecurrence()).toEqual({
      frequency: 'daily',
      interval: 1,
    });
  });

  it('merges metadata via updateMetadata and persists it', async () => {
    const { series } = await makeSeries('series-metadata');
    const s = await series.create({
      name: 'Metadata series',
      metadata: '{"season":2024}',
    });
    s.updateMetadata({ sponsor: 'Acme' });
    await s.save();

    const loaded = await series.get({ id: s.id });
    expect(loaded?.getMetadata()).toEqual({ season: 2024, sponsor: 'Acme' });
  });

  it('isActive reflects the start/end window', () => {
    const past = new Date('2000-01-01');
    const future = new Date('2999-01-01');

    expect(new EventSeries({ name: 'open-ended' }).isActive()).toBe(true);
    expect(
      new EventSeries({
        name: 'current',
        startDate: past,
        endDate: future,
      }).isActive(),
    ).toBe(true);
    expect(
      new EventSeries({ name: 'not-started', startDate: future }).isActive(),
    ).toBe(false);
    expect(new EventSeries({ name: 'ended', endDate: past }).isActive()).toBe(
      false,
    );
  });

  it('loads events that belong to the series via getEvents()', async () => {
    const dbUrl = getTestDbUrl('series-getevents');
    const { series } = await makeSeries('series-getevents', dbUrl);
    const events = await EventCollection.create({
      db: { type: 'sqlite', url: dbUrl },
    });

    const s = await series.create({ name: 'Linked series' });
    await s.save();

    const e1 = await events.create({ name: 'Game 1', seriesId: s.id });
    await e1.save();
    const e2 = await events.create({ name: 'Game 2', seriesId: s.id });
    await e2.save();
    const other = await events.create({ name: 'Standalone' });
    await other.save();

    const linked = await s.getEvents();
    expect(linked.map((e: { id?: string }) => e.id).sort()).toEqual(
      [e1.id, e2.id].sort(),
    );
  });

  it('getType returns null when no typeId is set', async () => {
    const { series } = await makeSeries('series-gettype-null');
    const s = await series.create({ name: 'Typeless' });
    expect(await s.getType()).toBeNull();
  });
});

describe('EventSeriesCollection', () => {
  it('filters by organizer and type', async () => {
    const { series } = await makeSeries('seriescoll-filters');

    const a = await series.create({
      name: 'A',
      organizerId: 'org-1',
      typeId: 'type-x',
    });
    await a.save();
    const b = await series.create({
      name: 'B',
      organizerId: 'org-2',
      typeId: 'type-y',
    });
    await b.save();

    expect((await series.getByOrganizer('org-1')).map((s) => s.id)).toEqual([
      a.id,
    ]);
    expect((await series.getByType('type-y')).map((s) => s.id)).toEqual([b.id]);
  });

  it('getActive and getUpcoming partition by date window', async () => {
    const { series } = await makeSeries('seriescoll-active-upcoming');

    const active = await series.create({
      name: 'Active',
      startDate: new Date('2000-01-01'),
      endDate: new Date('2999-01-01'),
    });
    await active.save();
    const future = await series.create({
      name: 'Future',
      startDate: new Date('2999-06-01'),
    });
    await future.save();

    const activeList = await series.getActive();
    expect(activeList.map((s) => s.id)).toContain(active.id);
    expect(activeList.map((s) => s.id)).not.toContain(future.id);

    const upcoming = await series.getUpcoming();
    expect(upcoming.map((s) => s.id)).toContain(future.id);
    expect(upcoming.map((s) => s.id)).not.toContain(active.id);
  });

  it('getUpcoming honours the limit argument', async () => {
    const { series } = await makeSeries('seriescoll-upcoming-limit');
    for (let i = 1; i <= 3; i++) {
      const s = await series.create({
        name: `Future ${i}`,
        startDate: new Date(`299${i}-01-01`),
      });
      await s.save();
    }
    const limited = await series.getUpcoming(2);
    expect(limited).toHaveLength(2);
    // Sorted ascending by startDate.
    expect(limited[0].name).toBe('Future 1');
  });

  it('search matches name/description and applies filters', async () => {
    const { series } = await makeSeries('seriescoll-search');

    const a = await series.create({
      name: 'World Tour',
      description: 'Global concert tour',
      typeId: 'concert',
    });
    await a.save();
    const b = await series.create({
      name: 'Local Meetups',
      description: 'Community gatherings',
      typeId: 'meeting',
    });
    await b.save();

    const byQuery = await series.search('tour');
    expect(byQuery.map((s) => s.id)).toEqual([a.id]);

    const byFilter = await series.search('', { typeId: 'meeting' });
    expect(byFilter.map((s) => s.id)).toEqual([b.id]);
  });

  it('scopes series by tenant and resolves globals', async () => {
    const { series } = await makeSeries('seriescoll-tenant');

    const tenantSeries = await series.create({
      name: 'Tenant series',
      tenantId: 'tenant-a',
    });
    await tenantSeries.save();
    const globalSeries = await series.create({
      name: 'Global series',
      tenantId: null,
    });
    await globalSeries.save();

    expect((await series.findByTenant('tenant-a')).map((s) => s.id)).toEqual([
      tenantSeries.id,
    ]);
    expect((await series.findGlobal()).map((s) => s.id)).toEqual([
      globalSeries.id,
    ]);
    const both = (await series.findWithGlobals('tenant-a')).map((s) => s.id);
    expect(both).toContain(tenantSeries.id);
    expect(both).toContain(globalSeries.id);
  });
});
