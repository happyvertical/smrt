/**
 * Integration tests for @happyvertical/smrt-profiles package
 *
 * Basic CRUD tests for each model in the profiles package.
 *
 * Following Organization-Wide Testing Standard:
 * - Uses real resources (in-memory SQLite database)
 * - Tests behavior, not implementation
 * - Tests read like executable examples
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  ProfileCollection,
  ProfileMetafieldCollection,
  ProfileRelationshipTypeCollection,
  type ProfileType,
  ProfileTypeCollection,
} from '../index.js';

describe('Profiles Package Integration Tests', () => {
  describe('ProfileType CRUD', () => {
    let collection: ProfileTypeCollection;

    beforeEach(async () => {
      collection = await ProfileTypeCollection.create({
        persistence: { type: 'sqlite', url: ':memory:' },
      });
    });

    it('should create a profile type', async () => {
      const type = await collection.create({
        name: 'Human',
        description: 'Individual person',
      });
      await type.save();

      expect(type.id).toBeDefined();
      expect(type.name).toBe('Human');
      expect(type.slug).toBeDefined();
    });

    it('should read a profile type', async () => {
      const type = await collection.create({ name: 'Organization' });
      await type.save();

      const retrieved = await collection.get({ id: type.id });

      expect(retrieved).toBeDefined();
      expect(retrieved?.name).toBe('Organization');
    });

    it('should update a profile type', async () => {
      const type = await collection.create({ name: 'Robot' });
      await type.save();

      type.description = 'Automated agent';
      await type.save();

      const updated = await collection.get({ id: type.id });
      expect(updated?.description).toBe('Automated agent');
    });

    it('should delete a profile type', async () => {
      const type = await collection.create({ name: 'Bot' });
      await type.save();
      const id = type.id;

      await type.delete();

      const deleted = await collection.get({ id });
      expect(deleted).toBeNull();
    });
  });

  describe('Profile CRUD', () => {
    let collection: ProfileCollection;
    let profileType: ProfileType;

    beforeEach(async () => {
      collection = await ProfileCollection.create({
        persistence: { type: 'sqlite', url: ':memory:' },
      });

      const typeCollection = await ProfileTypeCollection.create({
        persistence: { type: 'sqlite', url: ':memory:' },
      });

      profileType = await typeCollection.create({
        name: 'Person',
        description: 'Human profile',
      });
      await profileType.save();
    });

    it('should create a profile', async () => {
      const profile = await collection.create({
        typeId: profileType.id,
        name: 'Alice Johnson',
        email: 'alice@example.com',
      });
      await profile.save();

      expect(profile.id).toBeDefined();
      expect(profile.name).toBe('Alice Johnson');
    });

    it('should read a profile', async () => {
      const profile = await collection.create({
        typeId: profileType.id,
        name: 'Bob Smith',
        email: 'bob@example.com',
      });
      await profile.save();

      const retrieved = await collection.get({ id: profile.id });

      expect(retrieved).toBeDefined();
      expect(retrieved?.name).toBe('Bob Smith');
    });

    it('should update a profile', async () => {
      const profile = await collection.create({
        typeId: profileType.id,
        name: 'Carol',
        email: 'carol@example.com',
      });
      await profile.save();

      profile.description = 'Software engineer';
      await profile.save();

      const updated = await collection.get({ id: profile.id });
      expect(updated?.description).toBe('Software engineer');
    });

    it('should delete a profile', async () => {
      const profile = await collection.create({
        typeId: profileType.id,
        name: 'Dave',
        email: 'dave@example.com',
      });
      await profile.save();
      const id = profile.id;

      await profile.delete();

      const deleted = await collection.get({ id });
      expect(deleted).toBeNull();
    });
  });

  describe('ProfileMetafield CRUD', () => {
    let collection: ProfileMetafieldCollection;

    beforeEach(async () => {
      collection = await ProfileMetafieldCollection.create({
        persistence: { type: 'sqlite', url: ':memory:' },
      });
    });

    it('should create a metafield', async () => {
      const field = await collection.create({
        name: 'Location',
        description: 'Geographic location',
      });
      await field.save();

      expect(field.id).toBeDefined();
      expect(field.name).toBe('Location');
    });

    it('should read a metafield', async () => {
      const field = await collection.create({ name: 'Department' });
      await field.save();

      const retrieved = await collection.get({ id: field.id });

      expect(retrieved).toBeDefined();
      expect(retrieved?.name).toBe('Department');
    });

    it('should update a metafield', async () => {
      const field = await collection.create({ name: 'Phone' });
      await field.save();

      field.description = 'Contact phone number';
      await field.save();

      const updated = await collection.get({ id: field.id });
      expect(updated?.description).toBe('Contact phone number');
    });

    it('should delete a metafield', async () => {
      const field = await collection.create({ name: 'Email' });
      await field.save();
      const id = field.id;

      await field.delete();

      const deleted = await collection.get({ id });
      expect(deleted).toBeNull();
    });
  });

  describe('ProfileRelationshipType CRUD', () => {
    let collection: ProfileRelationshipTypeCollection;

    beforeEach(async () => {
      collection = await ProfileRelationshipTypeCollection.create({
        persistence: { type: 'sqlite', url: ':memory:' },
      });
    });

    it('should create a relationship type', async () => {
      const type = await collection.create({
        name: 'Friend',
        reciprocal: true,
      });
      await type.save();

      expect(type.id).toBeDefined();
      expect(type.name).toBe('Friend');
      expect(type.reciprocal).toBe(true);
    });

    it('should read a relationship type', async () => {
      const type = await collection.create({
        name: 'Colleague',
        reciprocal: false,
      });
      await type.save();

      const retrieved = await collection.get({ id: type.id });

      expect(retrieved).toBeDefined();
      expect(retrieved?.name).toBe('Colleague');
    });

    it('should update a relationship type', async () => {
      const type = await collection.create({ name: 'Mentor' });
      await type.save();

      type.reciprocal = false;
      await type.save();

      const updated = await collection.get({ id: type.id });
      expect(updated?.reciprocal).toBe(false);
    });

    it('should delete a relationship type', async () => {
      const type = await collection.create({ name: 'Partner' });
      await type.save();
      const id = type.id;

      await type.delete();

      const deleted = await collection.get({ id });
      expect(deleted).toBeNull();
    });
  });
});
