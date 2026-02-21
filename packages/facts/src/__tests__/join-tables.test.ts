/**
 * Join table tests - FactContent and FactTag
 *
 * Tests link/unlink operations, conflict column uniqueness,
 * lookup methods, and metadata round-trips.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FactContentCollection } from '../fact-contents';
import { FactTagCollection } from '../fact-tags';
import { FactCollection } from '../facts';

describe('Join Tables', () => {
  let tempDir: string;
  let dbPath: string;
  let facts: FactCollection;
  let contents: FactContentCollection;
  let tags: FactTagCollection;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'smrt-join-tables-test-'));
    dbPath = join(tempDir, 'facts.db');

    facts = await FactCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    contents = await FactContentCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    tags = await FactTagCollection.create({
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

  // ===========================================================================
  // FactContent Tests
  // ===========================================================================

  describe('FactContent', () => {
    describe('link', () => {
      it('should link content to a fact', async () => {
        const fact = await facts.create({ textRefined: 'Content link test' });

        const link = await contents.link(fact.id as string, 'content-123');

        expect(link.id).toBeDefined();
        expect(link.factId).toBe(fact.id);
        expect(link.contentId).toBe('content-123');
        expect(link.relationship).toBe('extracted_from');
      });

      it('should support custom relationship types', async () => {
        const fact = await facts.create({ textRefined: 'Custom rel test' });

        const link = await contents.link(
          fact.id as string,
          'content-456',
          'supports',
        );

        expect(link.relationship).toBe('supports');
        expect(link.getRelationship()).toBe('supports');
      });

      it('should support all relationship types', async () => {
        const fact = await facts.create({ textRefined: 'All rels test' });
        const factId = fact.id as string;

        const relationships = [
          'extracted_from',
          'referenced_in',
          'supports',
          'contradicts',
          'related',
        ] as const;

        for (const rel of relationships) {
          const link = await contents.link(factId, `content-${rel}`, rel);
          expect(link.getRelationship()).toBe(rel);
        }
      });
    });

    describe('unlink', () => {
      it('should unlink content from a fact', async () => {
        const fact = await facts.create({ textRefined: 'Unlink test' });
        const factId = fact.id as string;

        await contents.link(factId, 'content-123');
        await contents.unlink(factId, 'content-123');

        const links = await contents.getForFact(factId);
        expect(links.length).toBe(0);
      });

      it('should only remove links for specified content', async () => {
        const fact = await facts.create({ textRefined: 'Selective unlink' });
        const factId = fact.id as string;

        await contents.link(factId, 'content-1');
        await contents.link(factId, 'content-2');

        await contents.unlink(factId, 'content-1');

        const links = await contents.getForFact(factId);
        expect(links.length).toBe(1);
        expect(links[0].contentId).toBe('content-2');
      });

      it('should remove all relationship types when unlinking', async () => {
        const fact = await facts.create({ textRefined: 'Multi-rel unlink' });
        const factId = fact.id as string;

        await contents.link(factId, 'content-1', 'extracted_from');
        await contents.link(factId, 'content-1', 'supports');

        await contents.unlink(factId, 'content-1');

        const links = await contents.getForFact(factId);
        expect(links.length).toBe(0);
      });
    });

    describe('getForFact', () => {
      it('should get all content links for a fact', async () => {
        const fact = await facts.create({ textRefined: 'Multi-content' });
        const factId = fact.id as string;

        await contents.link(factId, 'content-1');
        await contents.link(factId, 'content-2');
        await contents.link(factId, 'content-3');

        const links = await contents.getForFact(factId);
        expect(links.length).toBe(3);
      });

      it('should return empty array for fact with no content', async () => {
        const result = await contents.getForFact('nonexistent');
        expect(result).toEqual([]);
      });
    });

    describe('getForContent', () => {
      it('should get all fact links for a content item', async () => {
        const fact1 = await facts.create({ textRefined: 'Fact one' });
        const fact2 = await facts.create({ textRefined: 'Fact two' });

        await contents.link(fact1.id as string, 'content-shared');
        await contents.link(fact2.id as string, 'content-shared');

        const links = await contents.getForContent('content-shared');
        expect(links.length).toBe(2);
      });

      it('should not mix content IDs', async () => {
        const fact = await facts.create({ textRefined: 'Content ID test' });
        const factId = fact.id as string;

        await contents.link(factId, 'content-a');
        await contents.link(factId, 'content-b');

        const linksA = await contents.getForContent('content-a');
        expect(linksA.length).toBe(1);
        expect(linksA[0].contentId).toBe('content-a');
      });
    });

    describe('getByRelationship', () => {
      it('should filter content links by relationship type', async () => {
        const fact = await facts.create({ textRefined: 'Relationship filter' });
        const factId = fact.id as string;

        await contents.link(factId, 'content-1', 'extracted_from');
        await contents.link(factId, 'content-2', 'supports');
        await contents.link(factId, 'content-3', 'extracted_from');

        const extracted = await contents.getByRelationship(
          factId,
          'extracted_from',
        );
        expect(extracted.length).toBe(2);
        expect(
          extracted.every((l) => l.relationship === 'extracted_from'),
        ).toBe(true);
      });

      it('should return empty array when no links match relationship', async () => {
        const fact = await facts.create({ textRefined: 'No match rel' });
        await contents.link(fact.id as string, 'content-1', 'supports');

        const result = await contents.getByRelationship(
          fact.id as string,
          'contradicts',
        );
        expect(result).toEqual([]);
      });
    });

    describe('conflictColumns uniqueness', () => {
      it('should not duplicate same fact+content+relationship', async () => {
        const fact = await facts.create({ textRefined: 'Conflict test' });
        const factId = fact.id as string;

        await contents.link(factId, 'content-1', 'extracted_from');
        await contents.link(factId, 'content-1', 'extracted_from');

        // Upsert should prevent duplicates
        const links = await contents.getForFact(factId);
        expect(links.length).toBe(1);
      });

      it('should allow different relationships for same fact+content', async () => {
        const fact = await facts.create({ textRefined: 'Diff rel test' });
        const factId = fact.id as string;

        await contents.link(factId, 'content-1', 'extracted_from');
        await contents.link(factId, 'content-1', 'supports');

        const links = await contents.getForFact(factId);
        expect(links.length).toBe(2);
      });
    });

    describe('metadata', () => {
      it('should store and retrieve metadata', async () => {
        const fact = await facts.create({ textRefined: 'Meta test' });

        const link = await contents.create({
          factId: fact.id as string,
          contentId: 'content-1',
          relationship: 'extracted_from',
          metadata: { page: 5, section: 'introduction' },
        });

        const meta = link.getMetadata();
        expect(meta.page).toBe(5);
        expect(meta.section).toBe('introduction');
      });

      it('should update metadata by merging', async () => {
        const fact = await facts.create({ textRefined: 'Meta merge test' });

        const link = await contents.create({
          factId: fact.id as string,
          contentId: 'content-1',
          metadata: { page: 1 },
        });

        link.updateMetadata({ paragraph: 3 });

        const meta = link.getMetadata();
        expect(meta.page).toBe(1);
        expect(meta.paragraph).toBe(3);
      });

      it('should handle empty metadata', async () => {
        const fact = await facts.create({ textRefined: 'Empty meta' });

        const link = await contents.link(fact.id as string, 'content-1');
        const meta = link.getMetadata();
        expect(meta).toEqual({});
      });
    });

    describe('navigation', () => {
      it('should navigate to parent fact', async () => {
        const fact = await facts.create({ textRefined: 'Navigate test' });
        const link = await contents.link(fact.id as string, 'content-1');

        const parentFact = await link.getFact();
        expect(parentFact).not.toBeNull();
        expect(parentFact?.textRefined).toBe('Navigate test');
      });
    });
  });

  // ===========================================================================
  // FactTag Tests
  // ===========================================================================

  describe('FactTag', () => {
    describe('addTag', () => {
      it('should add a tag to a fact', async () => {
        const fact = await facts.create({ textRefined: 'Tag test' });

        const tag = await tags.addTag(fact.id as string, 'politics');

        expect(tag.id).toBeDefined();
        expect(tag.factId).toBe(fact.id);
        expect(tag.tagSlug).toBe('politics');
      });

      it('should add multiple tags to a fact', async () => {
        const fact = await facts.create({ textRefined: 'Multi-tag test' });
        const factId = fact.id as string;

        await tags.addTag(factId, 'politics');
        await tags.addTag(factId, 'local-government');
        await tags.addTag(factId, 'budget');

        const factTags = await tags.getForFact(factId);
        expect(factTags.length).toBe(3);
      });
    });

    describe('removeTag', () => {
      it('should remove a tag from a fact', async () => {
        const fact = await facts.create({ textRefined: 'Remove tag test' });
        const factId = fact.id as string;

        await tags.addTag(factId, 'politics');
        await tags.removeTag(factId, 'politics');

        const factTags = await tags.getForFact(factId);
        expect(factTags.length).toBe(0);
      });

      it('should only remove the specified tag', async () => {
        const fact = await facts.create({ textRefined: 'Selective remove' });
        const factId = fact.id as string;

        await tags.addTag(factId, 'politics');
        await tags.addTag(factId, 'budget');

        await tags.removeTag(factId, 'politics');

        const factTags = await tags.getForFact(factId);
        expect(factTags.length).toBe(1);
        expect(factTags[0].tagSlug).toBe('budget');
      });
    });

    describe('getForFact', () => {
      it('should get all tags for a fact', async () => {
        const fact = await facts.create({ textRefined: 'Tags for fact' });
        const factId = fact.id as string;

        await tags.addTag(factId, 'tag-a');
        await tags.addTag(factId, 'tag-b');

        const factTags = await tags.getForFact(factId);
        expect(factTags.length).toBe(2);
      });

      it('should return empty array for fact with no tags', async () => {
        const result = await tags.getForFact('nonexistent');
        expect(result).toEqual([]);
      });
    });

    describe('getForTag', () => {
      it('should get all facts for a tag slug', async () => {
        const fact1 = await facts.create({ textRefined: 'Tagged fact one' });
        const fact2 = await facts.create({ textRefined: 'Tagged fact two' });

        await tags.addTag(fact1.id as string, 'environment');
        await tags.addTag(fact2.id as string, 'environment');

        const tagFacts = await tags.getForTag('environment');
        expect(tagFacts.length).toBe(2);
      });

      it('should not mix tag slugs', async () => {
        const fact = await facts.create({ textRefined: 'Tag slug test' });
        const factId = fact.id as string;

        await tags.addTag(factId, 'politics');
        await tags.addTag(factId, 'budget');

        const politicsFacts = await tags.getForTag('politics');
        expect(politicsFacts.length).toBe(1);
        expect(politicsFacts[0].tagSlug).toBe('politics');
      });
    });

    describe('getTagSlugs', () => {
      it('should return string array of tag slugs', async () => {
        const fact = await facts.create({ textRefined: 'Slugs test' });
        const factId = fact.id as string;

        await tags.addTag(factId, 'alpha');
        await tags.addTag(factId, 'beta');
        await tags.addTag(factId, 'gamma');

        const slugs = await tags.getTagSlugs(factId);
        expect(slugs).toHaveLength(3);
        expect(slugs).toContain('alpha');
        expect(slugs).toContain('beta');
        expect(slugs).toContain('gamma');
      });

      it('should return empty array for fact with no tags', async () => {
        const slugs = await tags.getTagSlugs('nonexistent');
        expect(slugs).toEqual([]);
      });
    });

    describe('conflictColumns uniqueness', () => {
      it('should not duplicate same fact+tag_slug', async () => {
        const fact = await facts.create({ textRefined: 'Tag conflict test' });
        const factId = fact.id as string;

        await tags.addTag(factId, 'politics');
        await tags.addTag(factId, 'politics');

        // Upsert should prevent duplicates
        const factTags = await tags.getForFact(factId);
        expect(factTags.length).toBe(1);
      });

      it('should allow same tag on different facts', async () => {
        const fact1 = await facts.create({ textRefined: 'Fact one' });
        const fact2 = await facts.create({ textRefined: 'Fact two' });

        await tags.addTag(fact1.id as string, 'shared-tag');
        await tags.addTag(fact2.id as string, 'shared-tag');

        const tagLinks = await tags.getForTag('shared-tag');
        expect(tagLinks.length).toBe(2);
      });
    });

    describe('metadata', () => {
      it('should store and retrieve metadata', async () => {
        const fact = await facts.create({ textRefined: 'Tag meta test' });

        const tag = await tags.create({
          factId: fact.id as string,
          tagSlug: 'politics',
          metadata: { confidence: 0.95, source: 'auto' },
        });

        const meta = tag.getMetadata();
        expect(meta.confidence).toBe(0.95);
        expect(meta.source).toBe('auto');
      });

      it('should update metadata by merging', async () => {
        const fact = await facts.create({ textRefined: 'Tag meta merge' });

        const tag = await tags.create({
          factId: fact.id as string,
          tagSlug: 'budget',
          metadata: { weight: 1.0 },
        });

        tag.updateMetadata({ verified: true });

        const meta = tag.getMetadata();
        expect(meta.weight).toBe(1.0);
        expect(meta.verified).toBe(true);
      });

      it('should handle empty metadata', async () => {
        const fact = await facts.create({ textRefined: 'Empty tag meta' });
        const tag = await tags.addTag(fact.id as string, 'simple-tag');

        const meta = tag.getMetadata();
        expect(meta).toEqual({});
      });
    });

    describe('navigation', () => {
      it('should navigate to parent fact', async () => {
        const fact = await facts.create({ textRefined: 'Tag navigate test' });
        const tag = await tags.addTag(fact.id as string, 'nav-tag');

        const parentFact = await tag.getFact();
        expect(parentFact).not.toBeNull();
        expect(parentFact?.textRefined).toBe('Tag navigate test');
      });
    });
  });
});
