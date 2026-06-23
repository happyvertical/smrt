/**
 * Tests for the profile relationship graph: Profile relationship helpers,
 * ProfileRelationship / ProfileRelationshipTerm / ProfileRelationshipType
 * models, their collections, and the ProfileCollection network helpers.
 *
 * Real file-backed SQLite, no DB mocking.
 *
 * Note: Profile.addRelationship fires a registered reciprocal handler whenever
 * the type is reciprocal, *unconditionally*. The bundled default handlers
 * (friend/spouse/…) call back into addRelationship and would recurse, so these
 * tests drive reciprocal behaviour with purpose-built non-recursive handlers
 * and never invoke addRelationship with a default reciprocal slug.
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ProfileCollection,
  ProfileRelationship,
  ProfileRelationshipCollection,
  ProfileRelationshipTerm,
  ProfileRelationshipTermCollection,
  ProfileRelationshipType,
  ProfileRelationshipTypeCollection,
  ProfileTypeCollection,
} from '../index.js';

function getTestDbUrl(name: string): string {
  return `file:${join(tmpdir(), `${name}-${randomUUID()}.db`)}`;
}

async function setup(dbUrl: string) {
  const db = { type: 'sqlite' as const, url: dbUrl };
  const profiles = await ProfileCollection.create({ db });
  const profileTypes = await ProfileTypeCollection.create({ db });
  const relTypes = await ProfileRelationshipTypeCollection.create({ db });
  const relationships = await ProfileRelationshipCollection.create({ db });
  const terms = await ProfileRelationshipTermCollection.create({ db });

  const personType = await profileTypes.create({ name: 'Person' });
  await personType.save();

  const mkProfile = async (name: string) => {
    const p = await profiles.create({
      typeId: personType.id,
      name,
      email: `${name.toLowerCase()}-${randomUUID()}@example.com`,
    });
    await p.save();
    return p;
  };

  const alice = await mkProfile('Alice');
  const bob = await mkProfile('Bob');
  const charlie = await mkProfile('Charlie');

  return {
    db,
    profiles,
    relTypes,
    relationships,
    terms,
    alice,
    bob,
    charlie,
  };
}

describe('Profile.addRelationship / getRelationships / getRelatedProfiles', () => {
  let dbUrl: string;

  beforeEach(() => {
    dbUrl = getTestDbUrl('profile-relationships');
  });

  it('adds a directional relationship and is idempotent', async () => {
    const { relTypes, relationships, alice, bob } = await setup(dbUrl);
    const mentor = await relTypes.create({ name: 'Mentor', reciprocal: false });
    await mentor.save();

    await alice.addRelationship(bob, 'mentor');
    await alice.addRelationship(bob, 'mentor'); // duplicate — should be a no-op

    const fromAlice = await relationships.getFromProfile(alice.id as string);
    expect(fromAlice).toHaveLength(1);
    expect(String(fromAlice[0].toProfileId)).toBe(String(bob.id));
  });

  it('throws when the relationship slug is unknown', async () => {
    const { alice, bob } = await setup(dbUrl);
    await expect(alice.addRelationship(bob, 'nope')).rejects.toThrow(
      /not found/,
    );
  });

  it('fires a registered reciprocal handler for reciprocal types', async () => {
    const { relTypes, relationships, alice, bob } = await setup(dbUrl);
    const slug = `recip-${randomUUID().slice(0, 8)}`;

    let handlerArgs: any[] | null = null;
    // Non-recursive handler so we don't trigger the addRelationship recursion.
    ProfileRelationshipType.registerReciprocalHandler(slug, async (from, to) => {
      handlerArgs = [from.id, to.id];
    });

    const recipType = await relTypes.create({
      slug,
      name: 'Reciprocal',
      reciprocal: true,
    });
    await recipType.save();

    await alice.addRelationship(bob, slug);

    expect(handlerArgs).toEqual([alice.id, bob.id]);
    // The forward relationship is still created.
    expect(await relationships.getFromProfile(alice.id as string)).toHaveLength(
      1,
    );

    (globalThis as any).__smrtProfileRelationshipHandlers?.delete(slug);
  });

  it('reads relationships by direction and filters by type slug', async () => {
    const { relTypes, alice, bob, charlie } = await setup(dbUrl);
    const mentor = await relTypes.create({ name: 'Mentor', reciprocal: false });
    await mentor.save();
    const knows = await relTypes.create({ name: 'Knows', reciprocal: false });
    await knows.save();

    await alice.addRelationship(bob, 'mentor');
    await charlie.addRelationship(alice, 'knows');

    const from = await alice.getRelationships({ direction: 'from' });
    expect(from).toHaveLength(1);

    const to = await alice.getRelationships({ direction: 'to' });
    expect(to).toHaveLength(1);

    const all = await alice.getRelationships({ direction: 'all' });
    expect(all).toHaveLength(2);

    // Type-slug filter narrows to the matching relationship type.
    const onlyMentor = await alice.getRelationships({
      direction: 'all',
      typeSlug: 'mentor',
    });
    expect(onlyMentor).toHaveLength(1);
  });

  it('resolves related profiles in both directions, de-duplicated', async () => {
    const { relTypes, alice, bob, charlie } = await setup(dbUrl);
    const mentor = await relTypes.create({ name: 'Mentor', reciprocal: false });
    await mentor.save();

    await alice.addRelationship(bob, 'mentor');
    await charlie.addRelationship(alice, 'mentor');

    const related = await alice.getRelatedProfiles();
    const ids = related.map((p) => String(p.id)).sort();
    expect(ids).toEqual([String(bob.id), String(charlie.id)].sort());
  });

  it('removes a directional relationship and rejects unknown slugs', async () => {
    const { relTypes, relationships, alice, bob } = await setup(dbUrl);
    const mentor = await relTypes.create({ name: 'Mentor', reciprocal: false });
    await mentor.save();

    await alice.addRelationship(bob, 'mentor');
    await alice.removeRelationship(bob, 'mentor');
    expect(await relationships.getFromProfile(alice.id as string)).toEqual([]);

    await expect(alice.removeRelationship(bob, 'ghost')).rejects.toThrow(
      /not found/,
    );
  });

  it('removes the inverse edge for reciprocal types', async () => {
    const { relTypes, relationships, alice, bob } = await setup(dbUrl);
    // reciprocal:true so removeRelationship also deletes the inverse edge.
    const peer = await relTypes.create({ name: 'Peer', reciprocal: true });
    await peer.save();
    const typeId = peer.id as string;

    // Build both directions directly (avoiding addRelationship's handler path).
    for (const [fromId, toId] of [
      [alice.id, bob.id],
      [bob.id, alice.id],
    ] as const) {
      const rel = await relationships.create({
        fromProfileId: fromId,
        toProfileId: toId,
        typeId,
      });
      await rel.save();
    }

    await alice.removeRelationship(bob, 'peer');

    expect(await relationships.getFromProfile(alice.id as string)).toEqual([]);
    expect(await relationships.getFromProfile(bob.id as string)).toEqual([]);
  });
});

describe('ProfileRelationship instance methods and terms', () => {
  let dbUrl: string;

  beforeEach(() => {
    dbUrl = getTestDbUrl('relationship-terms');
  });

  it('exposes the type slug and manages temporal terms', async () => {
    const { relTypes, relationships, alice, bob } = await setup(dbUrl);
    const knows = await relTypes.create({ name: 'Knows', reciprocal: false });
    await knows.save();

    const rel = await relationships.create({
      fromProfileId: alice.id,
      toProfileId: bob.id,
      typeId: knows.id,
    });
    await rel.save();

    expect(await rel.getTypeSlug()).toBe(knows.slug);

    // No terms yet.
    expect(await rel.getActiveTerm()).toBeNull();

    // Add an open-ended (active) term.
    await rel.addTerm(new Date('2020-01-01'));
    const active = await rel.getActiveTerm();
    expect(active).not.toBeNull();
    expect(active?.isActive()).toBe(true);

    expect(await rel.getTerms()).toHaveLength(1);

    // Ending the current term closes it out.
    await rel.endCurrentTerm(new Date('2021-01-01'));
    expect(await rel.getActiveTerm()).toBeNull();
  });
});

describe('ProfileRelationshipTerm model', () => {
  it('reports active state and computes duration', () => {
    const open = new ProfileRelationshipTerm({
      startedAt: new Date('2020-01-01'),
    });
    expect(open.isActive()).toBe(true);

    const future = new ProfileRelationshipTerm({
      startedAt: new Date('2020-01-01'),
      endedAt: new Date(Date.now() + 86_400_000),
    });
    expect(future.isActive()).toBe(true);

    const past = new ProfileRelationshipTerm({
      startedAt: new Date('2020-01-01'),
      endedAt: new Date('2020-01-11'),
    });
    expect(past.isActive()).toBe(false);
    expect(past.getDurationDays()).toBe(10);
  });

  it('end() defaults to now and marks the term closed', async () => {
    const dbUrl = getTestDbUrl('term-end');
    const { relTypes, relationships, alice, bob } = await setup(dbUrl);
    const t = await relTypes.create({ name: 'Knows', reciprocal: false });
    await t.save();
    const rel = await relationships.create({
      fromProfileId: alice.id,
      toProfileId: bob.id,
      typeId: t.id,
    });
    await rel.save();
    await rel.addTerm(new Date('2020-01-01'));

    const [term] = await rel.getTerms();
    await term.end();
    expect(term.endedAt).toBeInstanceOf(Date);
    expect(term.isActive()).toBe(false);
  });
});

describe('ProfileRelationshipTermCollection', () => {
  let dbUrl: string;

  beforeEach(() => {
    dbUrl = getTestDbUrl('term-collection');
  });

  it('separates active and historical terms', async () => {
    const { relTypes, relationships, terms, alice, bob } = await setup(dbUrl);
    const t = await relTypes.create({ name: 'Knows', reciprocal: false });
    await t.save();
    const rel = await relationships.create({
      fromProfileId: alice.id,
      toProfileId: bob.id,
      typeId: t.id,
    });
    await rel.save();
    const relId = rel.id as string;

    // One ended term, one active term.
    const ended = await terms.create({
      relationshipId: relId,
      startedAt: new Date('2019-01-01'),
      endedAt: new Date('2019-06-01'),
    });
    await ended.save();
    const current = await terms.create({
      relationshipId: relId,
      startedAt: new Date('2020-01-01'),
    });
    await current.save();

    expect(await terms.getByRelationship(relId)).toHaveLength(2);
    expect((await terms.getActiveTerm(relId))?.id).toBe(current.id);
    const historical = await terms.getHistoricalTerms(relId);
    expect(historical).toHaveLength(1);
    expect(historical[0].id).toBe(ended.id);
  });
});

describe('ProfileRelationshipType statics and collection', () => {
  let dbUrl: string;
  const customSlug = `custom-${randomUUID().slice(0, 8)}`;

  beforeEach(() => {
    dbUrl = getTestDbUrl('relationship-types');
  });

  afterEach(() => {
    (globalThis as any).__smrtProfileRelationshipHandlers?.delete(customSlug);
  });

  it('ships default reciprocal handlers and supports custom registration', () => {
    // Bundled defaults are present.
    expect(ProfileRelationshipType.getReciprocalHandler('friend')).toBeTypeOf(
      'function',
    );
    expect(ProfileRelationshipType.getReciprocalHandler('sibling')).toBeTypeOf(
      'function',
    );
    expect(
      ProfileRelationshipType.getReciprocalHandler('does-not-exist'),
    ).toBeUndefined();

    const handler = async () => {};
    ProfileRelationshipType.registerReciprocalHandler(customSlug, handler);
    expect(ProfileRelationshipType.getReciprocalHandler(customSlug)).toBe(
      handler,
    );
  });

  it('getBySlug static stub returns null and isReciprocal falls back to false', async () => {
    expect(await ProfileRelationshipType.getBySlug('anything')).toBeNull();
    expect(await ProfileRelationshipType.isReciprocal('anything')).toBe(false);
  });

  it('looks up, lazily creates, and partitions types by reciprocity', async () => {
    const { relTypes } = await setup(dbUrl);

    const created = await relTypes.getOrCreateBySlug('mentor', {
      name: 'Mentor',
      reciprocal: false,
    });
    expect(created.slug).toBe('mentor');
    // Idempotent.
    const again = await relTypes.getOrCreateBySlug('mentor', {
      name: 'Mentor',
    });
    expect(again.id).toBe(created.id);
    expect((await relTypes.getBySlug('mentor'))?.id).toBe(created.id);

    const friend = await relTypes.create({ name: 'Friend', reciprocal: true });
    await friend.save();

    const reciprocal = await relTypes.getReciprocal();
    expect(reciprocal.map((t) => t.slug)).toContain('friend');
    const directional = await relTypes.getDirectional();
    expect(directional.map((t) => t.slug)).toContain('mentor');
  });
});

describe('ProfileRelationshipCollection', () => {
  let dbUrl: string;

  beforeEach(() => {
    dbUrl = getTestDbUrl('relationship-collection');
  });

  it('queries by direction, both directions, and existence', async () => {
    const { relTypes, relationships, alice, bob, charlie } = await setup(dbUrl);
    const mentor = await relTypes.create({ name: 'Mentor', reciprocal: false });
    await mentor.save();
    const knows = await relTypes.create({ name: 'Knows', reciprocal: false });
    await knows.save();

    const r1 = await relationships.create({
      fromProfileId: alice.id,
      toProfileId: bob.id,
      typeId: mentor.id,
    });
    await r1.save();
    const r2 = await relationships.create({
      fromProfileId: charlie.id,
      toProfileId: alice.id,
      typeId: knows.id,
    });
    await r2.save();

    expect(await relationships.getFromProfile(alice.id as string)).toHaveLength(
      1,
    );
    expect(await relationships.getToProfile(alice.id as string)).toHaveLength(
      1,
    );
    expect(await relationships.getForProfile(alice.id as string)).toHaveLength(
      2,
    );

    // Type-filtered queries.
    expect(
      await relationships.getFromProfile(alice.id as string, mentor.id as string),
    ).toHaveLength(1);

    expect(
      await relationships.exists(alice.id as string, bob.id as string, mentor.id as string),
    ).toBe(true);
    expect(
      await relationships.exists(bob.id as string, alice.id as string, mentor.id as string),
    ).toBe(false);
  });
});

describe('ProfileCollection relationship helpers', () => {
  let dbUrl: string;

  beforeEach(() => {
    dbUrl = getTestDbUrl('profile-collection-relationships');
  });

  it('finds related profiles and walks the relationship network', async () => {
    const { profiles, relTypes, alice, bob, charlie } = await setup(dbUrl);
    const mentor = await relTypes.create({ name: 'Mentor', reciprocal: false });
    await mentor.save();

    // alice -> bob -> charlie chain.
    await alice.addRelationship(bob, 'mentor');
    await bob.addRelationship(charlie, 'mentor');

    const related = await profiles.findRelated(alice.id as string);
    expect(related.map((p) => String(p.id))).toContain(String(bob.id));

    // Unknown profile id yields no related profiles.
    expect(await profiles.findRelated('missing-id')).toEqual([]);

    const network = await profiles.getRelationshipNetwork(alice.id as string, {
      maxDepth: 2,
    });
    expect(network.get(alice.id as string)).toBe(0);
    expect(network.get(bob.id as string)).toBe(1);
    expect(network.get(charlie.id as string)).toBe(2);
  });
});
