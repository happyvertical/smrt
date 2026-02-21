/**
 * FactSubject model tests - linkEntity/unlinkEntity, conflictColumns, getForEntity
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FactSubjectCollection } from '../fact-subjects';
import { FactCollection } from '../facts';

describe('FactSubject', () => {
  let tempDir: string;
  let dbPath: string;
  let facts: FactCollection;
  let subjects: FactSubjectCollection;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'smrt-fact-subject-test-'));
    dbPath = join(tempDir, 'facts.db');

    facts = await FactCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    subjects = await FactSubjectCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('linkEntity', () => {
    it('should link an entity to a fact', async () => {
      const fact = await facts.create({ textRefined: 'Test fact' });

      const subject = await subjects.linkEntity(
        fact.id as string,
        'Profile',
        'profile-123',
        'subject',
      );

      expect(subject.id).toBeDefined();
      expect(subject.factId).toBe(fact.id);
      expect(subject.entityType).toBe('Profile');
      expect(subject.entityId).toBe('profile-123');
      expect(subject.role).toBe('subject');
    });

    it('should use default role of subject', async () => {
      const fact = await facts.create({ textRefined: 'Default role test' });

      const subject = await subjects.linkEntity(
        fact.id as string,
        'Place',
        'place-456',
      );

      expect(subject.role).toBe('subject');
    });

    it('should support all role types', async () => {
      const fact = await facts.create({ textRefined: 'Roles test' });
      const factId = fact.id as string;

      const roles = [
        'subject',
        'object',
        'source',
        'location',
        'participant',
        'related',
      ] as const;
      for (const role of roles) {
        const subject = await subjects.linkEntity(
          factId,
          'Entity',
          `entity-${role}`,
          role,
        );
        expect(subject.getRole()).toBe(role);
      }
    });
  });

  describe('unlinkEntity', () => {
    it('should remove a link between entity and fact', async () => {
      const fact = await facts.create({ textRefined: 'Unlink test' });
      const factId = fact.id as string;

      await subjects.linkEntity(factId, 'Profile', 'profile-123');
      await subjects.unlinkEntity(factId, 'Profile', 'profile-123');

      const links = await subjects.getForFact(factId);
      expect(links.length).toBe(0);
    });

    it('should only remove the specific entity link', async () => {
      const fact = await facts.create({ textRefined: 'Selective unlink' });
      const factId = fact.id as string;

      await subjects.linkEntity(factId, 'Profile', 'profile-1');
      await subjects.linkEntity(factId, 'Profile', 'profile-2');

      await subjects.unlinkEntity(factId, 'Profile', 'profile-1');

      const links = await subjects.getForFact(factId);
      expect(links.length).toBe(1);
      expect(links[0].entityId).toBe('profile-2');
    });
  });

  describe('getForFact', () => {
    it('should get all subjects for a fact', async () => {
      const fact = await facts.create({ textRefined: 'Multi-subject' });
      const factId = fact.id as string;

      await subjects.linkEntity(factId, 'Profile', 'p-1', 'subject');
      await subjects.linkEntity(factId, 'Place', 'pl-1', 'location');
      await subjects.linkEntity(factId, 'Event', 'e-1', 'related');

      const factSubjects = await subjects.getForFact(factId);
      expect(factSubjects.length).toBe(3);
    });

    it('should return empty array for fact with no subjects', async () => {
      const result = await subjects.getForFact('nonexistent');
      expect(result).toEqual([]);
    });
  });

  describe('getForEntity', () => {
    it('should get all fact links for an entity', async () => {
      const fact1 = await facts.create({ textRefined: 'Fact about entity' });
      const fact2 = await facts.create({
        textRefined: 'Another fact about entity',
      });

      await subjects.linkEntity(fact1.id as string, 'Profile', 'profile-xyz');
      await subjects.linkEntity(fact2.id as string, 'Profile', 'profile-xyz');

      const entitySubjects = await subjects.getForEntity(
        'Profile',
        'profile-xyz',
      );
      expect(entitySubjects.length).toBe(2);
    });

    it('should not mix entity types', async () => {
      const fact = await facts.create({ textRefined: 'Entity type test' });
      const factId = fact.id as string;

      await subjects.linkEntity(factId, 'Profile', 'id-123');
      await subjects.linkEntity(factId, 'Place', 'id-123');

      const profileLinks = await subjects.getForEntity('Profile', 'id-123');
      expect(profileLinks.length).toBe(1);
      expect(profileLinks[0].entityType).toBe('Profile');
    });
  });

  describe('getByRole', () => {
    it('should filter subjects by role', async () => {
      const fact = await facts.create({ textRefined: 'Role filter test' });
      const factId = fact.id as string;

      await subjects.linkEntity(factId, 'Profile', 'p-1', 'subject');
      await subjects.linkEntity(factId, 'Profile', 'p-2', 'source');
      await subjects.linkEntity(factId, 'Place', 'pl-1', 'location');

      const subjectRoles = await subjects.getByRole(factId, 'subject');
      expect(subjectRoles.length).toBe(1);
      expect(subjectRoles[0].entityId).toBe('p-1');
    });
  });

  describe('countForFact', () => {
    it('should count subjects for a fact', async () => {
      const fact = await facts.create({ textRefined: 'Count test' });
      const factId = fact.id as string;

      await subjects.linkEntity(factId, 'Profile', 'p-1');
      await subjects.linkEntity(factId, 'Place', 'pl-1');

      const count = await subjects.countForFact(factId);
      expect(count).toBe(2);
    });
  });

  describe('metadata', () => {
    it('should store metadata on subject links', async () => {
      const fact = await facts.create({ textRefined: 'Subject meta' });
      const subject = await subjects.create({
        factId: fact.id as string,
        entityType: 'Profile',
        entityId: 'p-1',
        role: 'subject',
        metadata: { relevance: 'high', section: 'body' },
      });

      const meta = subject.getMetadata();
      expect(meta.relevance).toBe('high');
      expect(meta.section).toBe('body');
    });
  });

  describe('navigation', () => {
    it('should navigate to parent fact', async () => {
      const fact = await facts.create({ textRefined: 'Navigate test' });
      const subject = await subjects.linkEntity(
        fact.id as string,
        'Profile',
        'p-1',
      );

      const parentFact = await subject.getFact();
      expect(parentFact).not.toBeNull();
      expect(parentFact?.textRefined).toBe('Navigate test');
    });
  });
});
