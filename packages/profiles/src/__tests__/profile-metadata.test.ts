/**
 * Tests for controlled profile metadata: ProfileMetafield validation, the
 * ProfileMetadata model, both collections, and the Profile-level metadata
 * helpers (addMetadata / getMetadata / updateMetadata / removeMetadata).
 *
 * Real file-backed SQLite, no DB mocking.
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ProfileCollection,
  ProfileMetadataCollection,
  ProfileMetafield,
  ProfileMetafieldCollection,
  ProfileTypeCollection,
} from '../index.js';

function getTestDbUrl(name: string): string {
  return `file:${join(tmpdir(), `${name}-${randomUUID()}.db`)}`;
}

async function setup(dbUrl: string) {
  const db = { type: 'sqlite' as const, url: dbUrl };
  const profiles = await ProfileCollection.create({ db });
  const profileTypes = await ProfileTypeCollection.create({ db });
  const metafields = await ProfileMetafieldCollection.create({ db });
  const metadata = await ProfileMetadataCollection.create({ db });

  const type = await profileTypes.create({ name: 'Person' });
  await type.save();

  const profile = await profiles.create({
    typeId: type.id,
    name: 'Alice',
    email: `alice-${randomUUID()}@example.com`,
  });
  await profile.save();

  return { db, profiles, profile, metafields, metadata };
}

describe('ProfileMetafield.validateValue', () => {
  it('accepts any value when no validation schema is set', async () => {
    const field = new ProfileMetafield({ name: 'Freeform' });
    expect(await field.validateValue('anything')).toBe(true);
    expect(await field.validateValue(42)).toBe(true);
  });

  it('enforces type validation', async () => {
    const numberField = new ProfileMetafield({
      name: 'Age',
      validation: { type: 'number' },
    });
    expect(await numberField.validateValue(30)).toBe(true);
    await expect(numberField.validateValue('thirty')).rejects.toThrow();

    const stringField = new ProfileMetafield({
      name: 'City',
      validation: { type: 'string' },
    });
    expect(await stringField.validateValue('Berlin')).toBe(true);
    await expect(stringField.validateValue(5)).rejects.toThrow();

    const boolField = new ProfileMetafield({
      name: 'Active',
      validation: { type: 'boolean' },
    });
    expect(await boolField.validateValue(true)).toBe(true);
    await expect(boolField.validateValue('yes')).rejects.toThrow();
  });

  it('enforces pattern and length constraints on strings', async () => {
    const pattern = new ProfileMetafield({
      name: 'Code',
      validation: { pattern: '^[A-Z]{3}$', message: 'Need 3 caps' },
    });
    expect(await pattern.validateValue('ABC')).toBe(true);
    await expect(pattern.validateValue('abc')).rejects.toThrow('Need 3 caps');

    const minLen = new ProfileMetafield({
      name: 'Bio',
      validation: { minLength: 5 },
    });
    expect(await minLen.validateValue('hello')).toBe(true);
    await expect(minLen.validateValue('hi')).rejects.toThrow();

    const maxLen = new ProfileMetafield({
      name: 'Nick',
      validation: { maxLength: 3 },
    });
    expect(await maxLen.validateValue('abc')).toBe(true);
    await expect(maxLen.validateValue('abcd')).rejects.toThrow();
  });

  it('enforces numeric min/max constraints', async () => {
    const field = new ProfileMetafield({
      name: 'Score',
      validation: { min: 0, max: 100 },
    });
    expect(await field.validateValue(50)).toBe(true);
    await expect(field.validateValue(-1)).rejects.toThrow();
    await expect(field.validateValue(101)).rejects.toThrow();
  });

  describe('custom validators', () => {
    afterEach(() => {
      // Clean up the global registry between tests.
      (globalThis as any).__smrtProfileMetafieldValidators?.delete('isEven');
    });

    it('runs a registered custom validator', async () => {
      ProfileMetafield.registerValidator('isEven', (v: any) => v % 2 === 0);
      expect(ProfileMetafield.getValidator('isEven')).toBeTypeOf('function');

      const field = new ProfileMetafield({
        name: 'EvenNumber',
        validation: { custom: 'isEven', message: 'must be even' },
      });

      expect(await field.validateValue(4)).toBe(true);
      await expect(field.validateValue(3)).rejects.toThrow('must be even');
    });

    it('throws when the custom validator is not registered', async () => {
      const field = new ProfileMetafield({
        name: 'Mystery',
        validation: { custom: 'doesNotExist' },
      });
      await expect(field.validateValue('x')).rejects.toThrow(
        /not registered/,
      );
    });
  });
});

describe('ProfileMetafieldCollection', () => {
  let dbUrl: string;

  beforeEach(() => {
    dbUrl = getTestDbUrl('metafield-collection');
  });

  it('looks up and lazily creates metafields by slug', async () => {
    const { metafields } = await setup(dbUrl);

    const created = await metafields.getOrCreateBySlug('location', {
      name: 'Location',
      description: 'Where they live',
    });
    expect(created.slug).toBe('location');

    // Second call returns the existing record (no duplicate).
    const again = await metafields.getOrCreateBySlug('location', {
      name: 'Location',
    });
    expect(again.id).toBe(created.id);

    expect((await metafields.getBySlug('location'))?.id).toBe(created.id);
    expect(await metafields.getBySlug('missing')).toBeNull();
  });
});

describe('ProfileMetadata model + collection', () => {
  let dbUrl: string;

  beforeEach(() => {
    dbUrl = getTestDbUrl('profile-metadata');
  });

  it('validates a stored value against its metafield', async () => {
    const { db, profile, metafields, metadata } = await setup(dbUrl);

    const field = await metafields.create({
      name: 'Age',
      validation: { type: 'number', min: 0 },
    });
    await field.save();

    const record = await metadata.create({
      db,
      profileId: profile.id,
      metafieldId: field.id,
      value: '5',
    });
    await record.save();

    expect(await record.getMetafieldSlug()).toBe(field.slug);
    // validate() runs the metafield schema against the stored string; the
    // string '5' is not a number, so number-type validation rejects it.
    await expect(record.validate()).rejects.toThrow();
  });

  it('builds a key-value metadata object and finds profiles by metadata', async () => {
    const { profile, metafields, metadata } = await setup(dbUrl);

    const city = await metafields.create({ name: 'City' });
    await city.save();
    const role = await metafields.create({ name: 'Role' });
    await role.save();

    const cityValue = await metadata.create({
      profileId: profile.id,
      metafieldId: city.id,
      value: 'Berlin',
    });
    await cityValue.save();
    const roleValue = await metadata.create({
      profileId: profile.id,
      metafieldId: role.id,
      value: 'Engineer',
    });
    await roleValue.save();

    expect(await metadata.getByProfile(profile.id as string)).toHaveLength(2);

    const asObject = await metadata.getMetadataObject(profile.id as string);
    expect(asObject).toEqual({ city: 'Berlin', role: 'Engineer' });

    const matches = await metadata.findProfilesByMetadata(
      city.id as string,
      'Berlin',
    );
    expect(matches).toEqual([profile.id]);
  });
});

describe('Profile metadata helpers', () => {
  let dbUrl: string;

  beforeEach(() => {
    dbUrl = getTestDbUrl('profile-metadata-helpers');
  });

  it('adds, reads, updates, and removes metadata by metafield slug', async () => {
    const { profile, metafields } = await setup(dbUrl);

    const city = await metafields.create({ name: 'City' });
    await city.save();
    const role = await metafields.create({ name: 'Role' });
    await role.save();

    await profile.addMetadata('city', 'Paris');
    expect(await profile.getMetadata()).toEqual({ city: 'Paris' });

    // Re-adding the same slug updates the existing value rather than inserting.
    await profile.addMetadata('city', 'London');
    expect(await profile.getMetadata()).toEqual({ city: 'London' });

    await profile.updateMetadata({ city: 'Rome', role: 'Designer' });
    expect(await profile.getMetadata()).toEqual({
      city: 'Rome',
      role: 'Designer',
    });

    await profile.removeMetadata('city');
    expect(await profile.getMetadata()).toEqual({ role: 'Designer' });
  });

  it('throws when adding metadata for an unknown metafield slug', async () => {
    const { profile } = await setup(dbUrl);
    await expect(profile.addMetadata('nonexistent', 'x')).rejects.toThrow(
      /not found/,
    );
  });

  it('validates values when adding metadata', async () => {
    const { profile, metafields } = await setup(dbUrl);

    const score = await metafields.create({
      name: 'Score',
      validation: { type: 'number', max: 10 },
    });
    await score.save();

    // 5 is a valid number; 99 exceeds the max.
    await profile.addMetadata('score', 5);
    expect(await profile.getMetadata()).toEqual({ score: '5' });
    await expect(profile.addMetadata('score', 99)).rejects.toThrow();
  });

  it('does nothing when removing metadata for a slug with no value set', async () => {
    const { profile, metafields } = await setup(dbUrl);
    const field = await metafields.create({ name: 'Pronoun' });
    await field.save();

    // No metadata stored yet — removeMetadata is a no-op (does not throw).
    await expect(profile.removeMetadata('pronoun')).resolves.toBeUndefined();
  });
});
