/**
 * EventParticipant model + EventParticipantCollection integration tests.
 *
 * Covers roles, numeric placement (home=0/away=1), group membership,
 * placement-ordered queries, participant statistics, the home/away
 * accessors, search filters, and tenant scoping. The collection extends
 * SmrtJunction with leftField=eventId / rightField=profileId.
 * Real temp-file SQLite (file:tmpdir), no mocks.
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EventCollection,
  EventParticipant,
  EventParticipantCollection,
} from '../index.js';

function getTestDbUrl(name: string): string {
  return `file:${join(tmpdir(), `${name}-${randomUUID()}.db`)}`;
}

async function setup(name: string) {
  const dbUrl = getTestDbUrl(name);
  const participants = await EventParticipantCollection.create({
    db: { type: 'sqlite', url: dbUrl },
  });
  const events = await EventCollection.create({
    db: { type: 'sqlite', url: dbUrl },
  });
  return { dbUrl, participants, events };
}

describe('EventParticipant model', () => {
  it('persists role, placement, and group fields', async () => {
    const { participants } = await setup('participant-persist');

    const p = await participants.create({
      eventId: 'event-1',
      profileId: 'profile-1',
      role: 'speaker',
      placement: 3,
      groupId: 'team-blue',
      source: 'manual',
    });
    await p.save();

    const loaded = await participants.get({ id: p.id });
    expect(loaded?.role).toBe('speaker');
    expect(loaded?.placement).toBe(3);
    expect(loaded?.groupId).toBe('team-blue');
    expect(loaded?.profileId).toBe('profile-1');
    expect(loaded?.source).toBe('manual');
  });

  it('isHome/isAway reflect placement 0 and 1', () => {
    expect(new EventParticipant({ placement: 0 }).isHome()).toBe(true);
    expect(new EventParticipant({ placement: 1 }).isHome()).toBe(false);
    expect(new EventParticipant({ placement: 1 }).isAway()).toBe(true);
    expect(new EventParticipant({ placement: 0 }).isAway()).toBe(false);
    // null placement is neither home nor away.
    const neutral = new EventParticipant({ role: 'attendee' });
    expect(neutral.isHome()).toBe(false);
    expect(neutral.isAway()).toBe(false);
  });

  it('manages metadata through get/set/update helpers', async () => {
    const { participants } = await setup('participant-metadata');
    const p = await participants.create({
      eventId: 'e',
      profileId: 'pr',
      role: 'home',
      metadata: '{"jersey":10}',
    });
    expect(p.getMetadata()).toEqual({ jersey: 10 });

    p.setMetadata({ jersey: 23 });
    p.updateMetadata({ captain: true });
    await p.save();

    const loaded = await participants.get({ id: p.id });
    expect(loaded?.getMetadata()).toEqual({ jersey: 23, captain: true });
  });

  it('returns empty metadata for malformed JSON', () => {
    const p = new EventParticipant({ role: 'host' });
    expect(p.getMetadata()).toEqual({});
    p.metadata = 'broken{';
    expect(p.getMetadata()).toEqual({});
  });

  it('loads the related event via getEvent()', async () => {
    const { participants, events } = await setup('participant-getevent');
    const event = await events.create({ name: 'Final Match' });
    await event.save();

    const p = await participants.create({
      eventId: event.id,
      profileId: 'profile-x',
      role: 'competitor',
    });
    await p.save();

    const linkedEvent = await p.getEvent();
    expect(linkedEvent?.id).toBe(event.id);
    expect(linkedEvent?.name).toBe('Final Match');
  });

  it('getEvent returns null when eventId is unset', async () => {
    const { participants } = await setup('participant-getevent-null');
    const p = await participants.create({ profileId: 'p', role: 'attendee' });
    expect(await p.getEvent()).toBeNull();
  });

  it('getGroupParticipants returns same-group teammates excluding self', async () => {
    const { participants } = await setup('participant-group');

    const a = await participants.create({
      eventId: 'game-1',
      profileId: 'player-a',
      role: 'home',
      groupId: 'team-red',
    });
    await a.save();
    const b = await participants.create({
      eventId: 'game-1',
      profileId: 'player-b',
      role: 'home',
      groupId: 'team-red',
    });
    await b.save();
    const other = await participants.create({
      eventId: 'game-1',
      profileId: 'player-c',
      role: 'away',
      groupId: 'team-blue',
    });
    await other.save();

    const teammates = await a.getGroupParticipants();
    expect(teammates.map((p) => p.profileId)).toEqual(['player-b']);
  });

  it('getGroupParticipants returns empty when no groupId', async () => {
    const { participants } = await setup('participant-group-empty');
    const p = await participants.create({
      eventId: 'g',
      profileId: 'solo',
      role: 'competitor',
    });
    await p.save();
    expect(await p.getGroupParticipants()).toEqual([]);
  });
});

describe('EventParticipantCollection', () => {
  async function seedGame(name: string) {
    const ctx = await setup(name);
    const home = await ctx.participants.create({
      eventId: 'game',
      profileId: 'team-home',
      role: 'home',
      placement: 0,
      groupId: 'home-roster',
    });
    await home.save();
    const away = await ctx.participants.create({
      eventId: 'game',
      profileId: 'team-away',
      role: 'away',
      placement: 1,
      groupId: 'away-roster',
    });
    await away.save();
    const bench = await ctx.participants.create({
      eventId: 'game',
      profileId: 'sub-1',
      role: 'competitor',
      placement: null,
    });
    await bench.save();
    return { ...ctx, home, away, bench };
  }

  it('getByPlacement orders ascending with nulls last', async () => {
    const { participants } = await seedGame('coll-by-placement');
    const ordered = await participants.getByPlacement('game');
    expect(ordered.map((p) => p.profileId)).toEqual([
      'team-home',
      'team-away',
      'sub-1',
    ]);
  });

  it('getHome and getAway resolve placement 0 and 1', async () => {
    const { participants } = await seedGame('coll-home-away');
    const home = await participants.getHome('game');
    const away = await participants.getAway('game');
    expect(home.map((p) => p.profileId)).toEqual(['team-home']);
    expect(away.map((p) => p.profileId)).toEqual(['team-away']);
  });

  it('getByGroup filters participants by groupId within an event', async () => {
    const { participants } = await seedGame('coll-by-group');
    const homeRoster = await participants.getByGroup('game', 'home-roster');
    expect(homeRoster.map((p) => p.profileId)).toEqual(['team-home']);
  });

  it('byLeft / byRight resolve the junction in both directions', async () => {
    const { participants } = await seedGame('coll-junction');
    const forEvent = await participants.byLeft('game');
    expect(forEvent).toHaveLength(3);

    const forProfile = await participants.byRight('team-home');
    expect(forProfile.map((p) => p.eventId)).toEqual(['game']);
  });

  it('search filters by event, profile, role, and group', async () => {
    const { participants } = await seedGame('coll-search');

    expect(
      (await participants.search({ role: 'home' })).map((p) => p.profileId),
    ).toEqual(['team-home']);
    expect(
      (await participants.search({ profileId: 'sub-1' })).map((p) => p.role),
    ).toEqual(['competitor']);
    expect(
      (await participants.search({ groupId: 'away-roster' })).map(
        (p) => p.profileId,
      ),
    ).toEqual(['team-away']);
    expect(await participants.search({ eventId: 'no-such-event' })).toEqual([]);
  });

  it('getParticipantStats aggregates totals by role and placement', async () => {
    const { participants } = await setup('coll-stats');

    // Same profile competing across two events with different roles.
    const g1 = await participants.create({
      eventId: 'g1',
      profileId: 'star',
      role: 'home',
      placement: 0,
    });
    await g1.save();
    const g2 = await participants.create({
      eventId: 'g2',
      profileId: 'star',
      role: 'away',
      placement: 1,
    });
    await g2.save();
    const g3 = await participants.create({
      eventId: 'g3',
      profileId: 'star',
      role: 'home',
      placement: 0,
    });
    await g3.save();

    const stats = await participants.getParticipantStats('star');
    expect(stats.totalEvents).toBe(3);
    expect(stats.byRole).toEqual({ home: 2, away: 1 });
    expect(stats.byPlacement).toEqual({ 0: 2, 1: 1 });
  });

  it('getParticipantStats filters by event type when requested', async () => {
    const dbUrl = getTestDbUrl('coll-stats-typed');
    const participants = await EventParticipantCollection.create({
      db: { type: 'sqlite', url: dbUrl },
    });
    const events = await EventCollection.create({
      db: { type: 'sqlite', url: dbUrl },
    });

    const basketball = await events.create({
      name: 'BBall',
      typeId: 'type-basketball',
    });
    await basketball.save();
    const soccer = await events.create({
      name: 'Soccer',
      typeId: 'type-soccer',
    });
    await soccer.save();

    const p1 = await participants.create({
      eventId: basketball.id,
      profileId: 'athlete',
      role: 'home',
      placement: 0,
    });
    await p1.save();
    const p2 = await participants.create({
      eventId: soccer.id,
      profileId: 'athlete',
      role: 'away',
      placement: 1,
    });
    await p2.save();

    const stats = await participants.getParticipantStats(
      'athlete',
      'type-basketball',
    );
    expect(stats.totalEvents).toBe(1);
    expect(stats.byRole).toEqual({ home: 1 });
    expect(stats.byPlacement).toEqual({ 0: 1 });
  });

  it('enforces the event_id+profile_id+role natural key on upsert', async () => {
    const { participants } = await setup('coll-conflict');

    const first = await participants.create({
      eventId: 'evt',
      profileId: 'prof',
      role: 'speaker',
      placement: 5,
    });
    await first.save();

    // Same (event, profile, role) — should upsert onto the same row.
    const dup = await participants.create({
      eventId: 'evt',
      profileId: 'prof',
      role: 'speaker',
      placement: 9,
    });
    await dup.save();

    const all = await participants.search({ eventId: 'evt' });
    expect(all).toHaveLength(1);
    expect(all[0].placement).toBe(9);
  });

  it('scopes participants by tenant and resolves globals', async () => {
    const { participants } = await setup('coll-tenant');

    const tenantP = await participants.create({
      eventId: 'e1',
      profileId: 'p1',
      role: 'home',
      tenantId: 'tenant-a',
    });
    await tenantP.save();
    const globalP = await participants.create({
      eventId: 'e2',
      profileId: 'p2',
      role: 'away',
      tenantId: null,
    });
    await globalP.save();

    expect(
      (await participants.findByTenant('tenant-a')).map((p) => p.id),
    ).toEqual([tenantP.id]);
    expect((await participants.findGlobal()).map((p) => p.id)).toEqual([
      globalP.id,
    ]);
    const both = (await participants.findWithGlobals('tenant-a')).map(
      (p) => p.id,
    );
    expect(both).toContain(tenantP.id);
    expect(both).toContain(globalP.id);
  });
});
