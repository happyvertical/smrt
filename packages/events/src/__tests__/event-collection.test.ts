/**
 * Event model + EventCollection integration tests.
 *
 * Covers the hierarchy traversal Event inherits from SmrtHierarchical
 * (getParent/getChildren/getAncestors/getDescendants/moveTo) plus the
 * Event-specific getRootEvent/isRoot, status transitions, in-progress
 * detection, relationship loads, and the collection's query helpers
 * (series/type/place/status/date/upcoming/search/tree) and tenant scoping.
 * Real in-memory SQLite, no mocks.
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Event, EventCollection } from '../index.js';

function getTestDbUrl(name: string): string {
  return `file:${join(tmpdir(), `${name}-${randomUUID()}.db`)}`;
}

async function makeEvents(name: string) {
  const dbUrl = getTestDbUrl(name);
  const events = await EventCollection.create({
    db: { type: 'sqlite', url: dbUrl },
  });
  return { dbUrl, events };
}

describe('Event model', () => {
  it('persists core fields and applies defaults', async () => {
    const { events } = await makeEvents('event-persist');

    const e = await events.create({
      name: 'Opening Ceremony',
      description: 'Kickoff',
      round: 1,
      externalId: 'ext-1',
      source: 'manual',
    });
    await e.save();

    const loaded = await events.get({ id: e.id });
    expect(loaded?.name).toBe('Opening Ceremony');
    expect(loaded?.description).toBe('Kickoff');
    expect(loaded?.round).toBe(1);
    expect(loaded?.status).toBe('scheduled');
    expect(loaded?.isRoot()).toBe(true);
  });

  it('updateStatus moves through the lifecycle and persists', async () => {
    const { events } = await makeEvents('event-status');
    const e = await events.create({ name: 'Match' });
    await e.save();

    await e.updateStatus('in_progress');
    expect(e.status).toBe('in_progress');
    let loaded = await events.get({ id: e.id });
    expect(loaded?.status).toBe('in_progress');

    await e.updateStatus('completed');
    loaded = await events.get({ id: e.id });
    expect(loaded?.status).toBe('completed');
  });

  it('isInProgress requires in_progress status within the date window', () => {
    const past = new Date('2000-01-01');
    const future = new Date('2999-01-01');

    expect(
      new Event({
        name: 'a',
        status: 'in_progress',
        startDate: past,
        endDate: future,
      }).isInProgress(),
    ).toBe(true);

    // Right status but the window has not opened yet.
    expect(
      new Event({
        name: 'b',
        status: 'in_progress',
        startDate: future,
      }).isInProgress(),
    ).toBe(false);

    // Scheduled events are never "in progress".
    expect(
      new Event({
        name: 'c',
        status: 'scheduled',
        startDate: past,
        endDate: future,
      }).isInProgress(),
    ).toBe(false);
  });

  it('round-trips metadata through get/set/update helpers', async () => {
    const { events } = await makeEvents('event-metadata');
    const e = await events.create({
      name: 'Tracked',
      metadata: '{"score":0}',
    });
    expect(e.getMetadata()).toEqual({ score: 0 });

    e.updateMetadata({ attendance: 500 });
    await e.save();

    const loaded = await events.get({ id: e.id });
    expect(loaded?.getMetadata()).toEqual({ score: 0, attendance: 500 });
  });

  it('getSeries/getType return null when their FK is unset', async () => {
    const { events } = await makeEvents('event-rel-null');
    const e = await events.create({ name: 'Standalone' });
    await e.save();
    expect(await e.getSeries()).toBeNull();
    expect(await e.getType()).toBeNull();
  });

  it('getParticipants returns the event participant rows', async () => {
    const dbUrl = getTestDbUrl('event-participants-load');
    const events = await EventCollection.create({
      db: { type: 'sqlite', url: dbUrl },
    });
    const { EventParticipantCollection } = await import('../index.js');
    const participants = await EventParticipantCollection.create({
      db: { type: 'sqlite', url: dbUrl },
    });

    const e = await events.create({ name: 'Game with players' });
    await e.save();

    const p = await participants.create({
      eventId: e.id,
      profileId: 'player-1',
      role: 'home',
    });
    await p.save();

    const loaded = await e.getParticipants();
    expect(loaded.map((row: { profileId?: string }) => row.profileId)).toEqual([
      'player-1',
    ]);
  });
});

describe('Event hierarchy', () => {
  async function buildTree(name: string) {
    const { events } = await makeEvents(name);
    const game = await events.create({ name: 'Game' });
    await game.save();
    const period = await events.create({ name: 'Period 1', parentId: game.id });
    await period.save();
    const goal = await events.create({ name: 'Goal', parentId: period.id });
    await goal.save();
    return { events, game, period, goal };
  }

  it('getParent/getChildren traverse one level each way', async () => {
    const { game, period, goal } = await buildTree('hier-parent-child');

    const parent = await period.getParent();
    expect(parent?.id).toBe(game.id);

    const children = await game.getChildren();
    expect(children.map((c) => c.id)).toEqual([period.id]);

    expect(await goal.getChildren()).toEqual([]);
  });

  it('getAncestors/getDescendants walk the full chain', async () => {
    const { game, period, goal } = await buildTree('hier-ancestors');

    const ancestors = await goal.getAncestors();
    expect(ancestors.map((a) => a.id)).toContain(game.id);
    expect(ancestors.map((a) => a.id)).toContain(period.id);

    const descendants = await game.getDescendants();
    expect(descendants.map((d) => d.id)).toContain(period.id);
    expect(descendants.map((d) => d.id)).toContain(goal.id);
  });

  it('getRootEvent and isRoot identify the top-level ancestor', async () => {
    const { game, period, goal } = await buildTree('hier-root');

    expect(game.isRoot()).toBe(true);
    expect(period.isRoot()).toBe(false);

    const rootFromLeaf = await goal.getRootEvent();
    expect(rootFromLeaf.id).toBe(game.id);

    const rootFromRoot = await game.getRootEvent();
    expect(rootFromRoot.id).toBe(game.id);
  });

  it('moveTo reparents a subtree', async () => {
    const { events, game, period, goal } = await buildTree('hier-move');

    const otherGame = await events.create({ name: 'Game 2' });
    await otherGame.save();

    await period.moveTo(otherGame.id);

    const reloadedPeriod = await events.get({ id: period.id });
    expect(reloadedPeriod?.parentId).toBe(otherGame.id);
    // The original game no longer lists the period as a child.
    expect(await game.getChildren()).toEqual([]);
    // The goal still hangs under the moved period.
    const movedChildren = await reloadedPeriod?.getChildren();
    expect(movedChildren?.map((c) => c.id)).toEqual([goal.id]);
  });
});

describe('EventCollection queries', () => {
  it('filters by series, place, type, status, and parent', async () => {
    const { events } = await makeEvents('coll-filters');

    const a = await events.create({
      name: 'A',
      seriesId: 's1',
      placeId: 'pl1',
      typeId: 't1',
      status: 'scheduled',
    });
    await a.save();
    const b = await events.create({
      name: 'B',
      seriesId: 's2',
      placeId: 'pl2',
      typeId: 't2',
      status: 'completed',
    });
    await b.save();
    const child = await events.create({ name: 'Child', parentId: a.id });
    await child.save();

    expect((await events.getBySeriesId('s1')).map((e) => e.id)).toEqual([a.id]);
    expect((await events.getByPlace('pl2')).map((e) => e.id)).toEqual([b.id]);
    expect((await events.getByType('t1')).map((e) => e.id)).toEqual([a.id]);
    expect((await events.getByStatus('completed')).map((e) => e.id)).toEqual([
      b.id,
    ]);
    expect((await events.getByParent(a.id as string)).map((e) => e.id)).toEqual(
      [child.id],
    );
  });

  it('getRootEvents returns only events without a parent', async () => {
    const { events } = await makeEvents('coll-roots');
    const root = await events.create({ name: 'Root' });
    await root.save();
    const child = await events.create({ name: 'Child', parentId: root.id });
    await child.save();

    const roots = await events.getRootEvents();
    expect(roots.map((e) => e.id)).toContain(root.id);
    expect(roots.map((e) => e.id)).not.toContain(child.id);
  });

  it('getByDateRange and getUpcoming partition by startDate', async () => {
    const { events } = await makeEvents('coll-dates');

    const inRange = await events.create({
      name: 'In range',
      startDate: new Date('2024-06-15'),
    });
    await inRange.save();
    const future = await events.create({
      name: 'Future',
      startDate: new Date('2999-01-01'),
    });
    await future.save();

    const ranged = await events.getByDateRange(
      new Date('2024-06-01'),
      new Date('2024-06-30'),
    );
    expect(ranged.map((e) => e.id)).toEqual([inRange.id]);

    const upcoming = await events.getUpcoming();
    expect(upcoming.map((e) => e.id)).toContain(future.id);
    expect(upcoming.map((e) => e.id)).not.toContain(inRange.id);
  });

  it('getUpcoming respects the limit and sorts ascending', async () => {
    const { events } = await makeEvents('coll-upcoming-limit');
    for (let i = 1; i <= 3; i++) {
      const e = await events.create({
        name: `Future ${i}`,
        startDate: new Date(`299${i}-01-01`),
      });
      await e.save();
    }
    const limited = await events.getUpcoming(2);
    expect(limited).toHaveLength(2);
    expect(limited[0].name).toBe('Future 1');
  });

  it('getInProgress returns only events that are truly in progress', async () => {
    const { events } = await makeEvents('coll-inprogress');

    const live = await events.create({
      name: 'Live',
      status: 'in_progress',
      startDate: new Date('2000-01-01'),
      endDate: new Date('2999-01-01'),
    });
    await live.save();
    const stale = await events.create({
      name: 'Stale',
      status: 'in_progress',
      startDate: new Date('2999-06-01'),
    });
    await stale.save();

    const inProgress = await events.getInProgress();
    expect(inProgress.map((e) => e.id)).toEqual([live.id]);
  });

  it('search matches name/description and applies status array filters', async () => {
    const { events } = await makeEvents('coll-search');

    const a = await events.create({
      name: 'Championship Final',
      description: 'The big game',
      status: 'completed',
    });
    await a.save();
    const b = await events.create({
      name: 'Qualifier',
      description: 'Early round',
      status: 'scheduled',
    });
    await b.save();

    expect((await events.search('championship')).map((e) => e.id)).toEqual([
      a.id,
    ]);
    expect(
      (await events.search('', { status: ['scheduled'] })).map((e) => e.id),
    ).toEqual([b.id]);
  });

  it('getEventTree returns the resolved root event', async () => {
    const { events } = await makeEvents('coll-tree');
    const root = await events.create({ name: 'Tournament' });
    await root.save();
    const child = await events.create({ name: 'Round 1', parentId: root.id });
    await child.save();

    const tree = await events.getEventTree(root.id as string);
    expect(tree?.id).toBe(root.id);

    expect(await events.getEventTree('missing-id')).toBeNull();
  });

  it('scopes events by tenant and resolves globals', async () => {
    const { events } = await makeEvents('coll-tenant');

    const tenantEvent = await events.create({
      name: 'Tenant event',
      tenantId: 'tenant-a',
    });
    await tenantEvent.save();
    const globalEvent = await events.create({
      name: 'Global event',
      tenantId: null,
    });
    await globalEvent.save();

    expect((await events.findByTenant('tenant-a')).map((e) => e.id)).toEqual([
      tenantEvent.id,
    ]);
    expect((await events.findGlobal()).map((e) => e.id)).toEqual([
      globalEvent.id,
    ]);
    const both = (await events.findWithGlobals('tenant-a')).map((e) => e.id);
    expect(both).toContain(tenantEvent.id);
    expect(both).toContain(globalEvent.id);
  });
});
