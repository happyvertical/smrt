/**
 * R10 — generated `@oneToMany` child accessors on real profile models.
 *
 * Profile declares `relationshipsFrom` / `relationshipsTo` as two oneToMany
 * relations to ProfileRelationship, which carries multiple foreign keys back
 * to Profile (fromProfileId / toProfileId). This verifies the generated
 * `getRelationshipsFrom()` / `getRelationshipsTo()` accessors resolve the
 * correct inverse side, and that pre-existing hand-rolled accessors
 * (`Profile.getMetadata`, `ProfileRelationship.getTerms`) are preserved.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ProfileCollection,
  ProfileRelationshipCollection,
  ProfileRelationshipTypeCollection,
  ProfileTypeCollection,
} from '../index.js';

describe('R10: generated child accessors on Profile', () => {
  let profiles: ProfileCollection;
  let relationships: ProfileRelationshipCollection;
  let alice: Awaited<ReturnType<ProfileCollection['create']>>;
  let bob: Awaited<ReturnType<ProfileCollection['create']>>;
  let relationshipTypeId: string;

  beforeEach(async () => {
    // Shared file DB so the related models resolve each other's tables.
    const dbUrl = join(tmpdir(), `test-r10-profiles-${Date.now()}.db`);
    const persistence = { type: 'sqlite' as const, url: dbUrl };

    profiles = await ProfileCollection.create({ persistence });
    relationships = await ProfileRelationshipCollection.create({ persistence });
    const types = await ProfileTypeCollection.create({ persistence });
    const relTypes = await ProfileRelationshipTypeCollection.create({
      persistence,
    });

    const personType = await types.create({ name: 'Person' });
    await personType.save();

    const knows = await relTypes.create({ name: 'Knows' });
    await knows.save();
    relationshipTypeId = knows.id as string;

    alice = await profiles.create({
      typeId: personType.id,
      name: 'Alice',
      email: 'alice@example.com',
    });
    await alice.save();

    bob = await profiles.create({
      typeId: personType.id,
      name: 'Bob',
      email: 'bob@example.com',
    });
    await bob.save();

    // A single directed relationship: Alice -> Bob.
    const rel = await relationships.create({
      fromProfileId: alice.id,
      toProfileId: bob.id,
      typeId: relationshipTypeId,
    });
    await rel.save();
  });

  it('exposes generated getRelationshipsFrom() / getRelationshipsTo()', () => {
    expect(typeof (alice as any).getRelationshipsFrom).toBe('function');
    expect(typeof (alice as any).getRelationshipsTo).toBe('function');
  });

  it('resolves the correct inverse FK for each direction', async () => {
    const aliceFrom = (await (alice as any).getRelationshipsFrom()) as any[];
    const aliceTo = (await (alice as any).getRelationshipsTo()) as any[];
    const bobFrom = (await (bob as any).getRelationshipsFrom()) as any[];
    const bobTo = (await (bob as any).getRelationshipsTo()) as any[];

    // Alice is the origin (fromProfileId), Bob is the target (toProfileId).
    expect(aliceFrom).toHaveLength(1);
    expect(String(aliceFrom[0].fromProfileId)).toBe(String(alice.id));

    expect(bobTo).toHaveLength(1);
    expect(String(bobTo[0].toProfileId)).toBe(String(bob.id));

    // The opposite directions must NOT bleed across (disambiguation works).
    expect(aliceTo).toHaveLength(0);
    expect(bobFrom).toHaveLength(0);
  });

  it('preserves the hand-rolled Profile.getMetadata() (key-value, not the list)', async () => {
    const metadata = await alice.getMetadata();
    // Hand-rolled accessor returns a key-value object, not a ProfileMetadata[].
    expect(Array.isArray(metadata)).toBe(false);
    expect(typeof metadata).toBe('object');
  });

  it('preserves the hand-rolled ProfileRelationship.getTerms()', async () => {
    const [rel] = (await (alice as any).getRelationshipsFrom()) as any[];
    const terms = await rel.getTerms();
    expect(Array.isArray(terms)).toBe(true);
  });
});
