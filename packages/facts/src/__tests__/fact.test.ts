/**
 * Fact model tests - CRUD, STI, parentId, metadata round-trip
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FactCollection } from '../facts';

describe('Fact', () => {
  let tempDir: string;
  let dbPath: string;
  let collection: FactCollection;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'smrt-fact-test-'));
    dbPath = join(tempDir, 'facts.db');

    collection = await FactCollection.create({
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

  describe('CRUD operations', () => {
    it('should create a fact with required fields', async () => {
      const fact = await collection.create({
        textRefined: 'The sky is blue',
        type: 'assertion',
        domain: 'science',
      });

      expect(fact.id).toBeDefined();
      expect(fact.textRefined).toBe('The sky is blue');
      expect(fact.type).toBe('assertion');
      expect(fact.domain).toBe('science');
      expect(fact.status).toBe('pending');
      expect(fact.evolutionType).toBe('original');
      expect(fact.sourceCount).toBe(0);
    });

    it('should retrieve a fact by id', async () => {
      const created = await collection.create({
        textRefined: 'Water boils at 100C',
        type: 'measurement',
      });

      const loaded = await collection.get({ id: created.id });
      expect(loaded).not.toBeNull();
      expect(loaded?.textRefined).toBe('Water boils at 100C');
      expect(loaded?.type).toBe('measurement');
    });

    it('should update a fact', async () => {
      const fact = await collection.create({
        textRefined: 'Draft fact',
        status: 'pending',
      });

      fact.textRefined = 'Refined fact';
      fact.status = 'active';
      await fact.save();

      const loaded = await collection.get({ id: fact.id });
      expect(loaded?.textRefined).toBe('Refined fact');
      expect(loaded?.status).toBe('active');
    });

    it('should delete a fact', async () => {
      const fact = await collection.create({
        textRefined: 'To be deleted',
      });

      await fact.delete();

      const loaded = await collection.get({ id: fact.id });
      expect(loaded).toBeNull();
    });

    it('should list all facts', async () => {
      await collection.create({ textRefined: 'Fact 1' });
      await collection.create({ textRefined: 'Fact 2' });
      await collection.create({ textRefined: 'Fact 3' });

      const all = await collection.list({});
      expect(all.length).toBe(3);
    });
  });

  describe('field defaults', () => {
    it('should have correct default values', async () => {
      const fact = await collection.create({
        textRefined: 'Default test',
      });

      expect(fact.textRaw).toBe('');
      expect(fact.type).toBe('assertion');
      expect(fact.status).toBe('pending');
      expect(fact.domain).toBe('');
      expect(fact.parentId).toBe('');
      expect(fact.evolutionType).toBe('original');
      expect(fact.sourceCount).toBe(0);
      expect(fact.confidence).toBe(0);
    });

    it('should accept all optional fields', async () => {
      const fact = await collection.create({
        textRefined: 'Full fact',
        textRaw: 'the sky is blue i think',
        type: 'observation',
        status: 'active',
        domain: 'meteorology',
        evolutionType: 'refinement',
        sourceCount: 3,
        confidence: 0.85,
      });

      expect(fact.textRaw).toBe('the sky is blue i think');
      expect(fact.type).toBe('observation');
      expect(fact.status).toBe('active');
      expect(fact.domain).toBe('meteorology');
      expect(fact.evolutionType).toBe('refinement');
      expect(fact.sourceCount).toBe(3);
      expect(fact.confidence).toBe(0.85);
    });
  });

  describe('metadata', () => {
    it('should store and retrieve metadata as JSON', async () => {
      const fact = await collection.create({
        textRefined: 'Metadata test',
        metadata: { extractionContext: 'council meeting', confidence: 0.9 },
      });

      const meta = fact.getMetadata();
      expect(meta.extractionContext).toBe('council meeting');
      expect(meta.confidence).toBe(0.9);
    });

    it('should round-trip metadata through save/load', async () => {
      const fact = await collection.create({
        textRefined: 'Round trip metadata',
        metadata: { tags: ['politics', 'local'], relatedFactIds: ['abc'] },
      });
      await fact.save();

      const loaded = await collection.get({ id: fact.id });
      const meta = loaded?.getMetadata();
      expect(meta.tags).toEqual(['politics', 'local']);
      expect(meta.relatedFactIds).toEqual(['abc']);
    });

    it('should update metadata by merging', async () => {
      const fact = await collection.create({
        textRefined: 'Merge metadata',
        metadata: { extractionContext: 'original' },
      });

      fact.updateMetadata({ refinedBy: 'claude-3', confidence: 0.95 });
      const meta = fact.getMetadata();
      expect(meta.extractionContext).toBe('original');
      expect(meta.refinedBy).toBe('claude-3');
      expect(meta.confidence).toBe(0.95);
    });

    it('should handle empty metadata gracefully', async () => {
      const fact = await collection.create({
        textRefined: 'No metadata',
      });

      const meta = fact.getMetadata();
      expect(meta).toEqual({});
    });

    it('should accept metadata as JSON string', async () => {
      const fact = await collection.create({
        textRefined: 'String metadata',
        metadata: '{"key":"value"}',
      });

      const meta = fact.getMetadata();
      expect(meta.key).toBe('value');
    });
  });

  describe('parentId and evolution', () => {
    it('should create a fact with a parent', async () => {
      const parent = await collection.create({
        textRefined: 'Original fact',
        status: 'active',
      });

      const child = await collection.create({
        textRefined: 'Corrected version of fact',
        parentId: parent.id as string,
        evolutionType: 'correction',
      });

      expect(child.parentId).toBe(parent.id);
      expect(child.evolutionType).toBe('correction');
      expect(child.hasParent()).toBe(true);
    });

    it('should identify facts without parents', async () => {
      const fact = await collection.create({
        textRefined: 'Root fact',
      });

      expect(fact.hasParent()).toBe(false);
    });

    it('should navigate to parent', async () => {
      const parent = await collection.create({
        textRefined: 'Parent fact',
      });

      const child = await collection.create({
        textRefined: 'Child fact',
        parentId: parent.id as string,
      });

      const foundParent = await child.getParent();
      expect(foundParent).not.toBeNull();
      expect(foundParent?.textRefined).toBe('Parent fact');
    });

    it('should find children of a fact', async () => {
      const parent = await collection.create({
        textRefined: 'Parent',
      });

      await collection.create({
        textRefined: 'Child 1',
        parentId: parent.id as string,
        evolutionType: 'refinement',
      });
      await collection.create({
        textRefined: 'Child 2',
        parentId: parent.id as string,
        evolutionType: 'extension',
      });

      const children = await parent.getChildren();
      expect(children.length).toBe(2);
    });
  });

  describe('status helpers', () => {
    it('should identify active facts', async () => {
      const fact = await collection.create({
        textRefined: 'Active fact',
        status: 'active',
      });

      expect(fact.isActive()).toBe(true);
      expect(fact.isSuperseded()).toBe(false);
    });

    it('should identify superseded facts', async () => {
      const fact = await collection.create({
        textRefined: 'Old fact',
        status: 'superseded',
      });

      expect(fact.isActive()).toBe(false);
      expect(fact.isSuperseded()).toBe(true);
    });
  });

  describe('collection query helpers', () => {
    it('should get active facts', async () => {
      await collection.create({ textRefined: 'Active 1', status: 'active' });
      await collection.create({ textRefined: 'Active 2', status: 'active' });
      await collection.create({ textRefined: 'Pending 1', status: 'pending' });

      const active = await collection.getActive();
      expect(active.length).toBe(2);
      expect(active.every((f) => f.status === 'active')).toBe(true);
    });

    it('should get pending facts', async () => {
      await collection.create({ textRefined: 'Pending', status: 'pending' });
      await collection.create({ textRefined: 'Active', status: 'active' });

      const pending = await collection.getPending();
      expect(pending.length).toBe(1);
      expect(pending[0].status).toBe('pending');
    });

    it('should get facts by type', async () => {
      await collection.create({ textRefined: 'F1', type: 'assertion' });
      await collection.create({ textRefined: 'F2', type: 'observation' });
      await collection.create({ textRefined: 'F3', type: 'assertion' });

      const assertions = await collection.getByType('assertion');
      expect(assertions.length).toBe(2);
    });

    it('should get facts by domain', async () => {
      await collection.create({ textRefined: 'F1', domain: 'politics' });
      await collection.create({ textRefined: 'F2', domain: 'science' });
      await collection.create({ textRefined: 'F3', domain: 'politics' });

      const politics = await collection.getByDomain('politics');
      expect(politics.length).toBe(2);
    });

    it('should get children by parentId', async () => {
      const parent = await collection.create({ textRefined: 'Parent' });
      await collection.create({
        textRefined: 'Child 1',
        parentId: parent.id as string,
      });
      await collection.create({
        textRefined: 'Child 2',
        parentId: parent.id as string,
      });

      const children = await collection.getChildren(parent.id as string);
      expect(children.length).toBe(2);
    });
  });

  describe('implemented methods', () => {
    it('branch() should throw for nonexistent parent', async () => {
      await expect(
        collection.branch('nonexistent-id', { textRefined: 'test' }),
      ).rejects.toThrow('Parent fact not found');
    });

    it('getEvolutionChain() should return empty for nonexistent id', async () => {
      const chain = await collection.getEvolutionChain('nonexistent');
      expect(chain).toEqual([]);
    });

    it('getLatestInChain() should throw for nonexistent id', async () => {
      await expect(collection.getLatestInChain('nonexistent')).rejects.toThrow(
        'Fact not found',
      );
    });

    it('getEvolutionTree() should return empty for nonexistent id', async () => {
      const tree = await collection.getEvolutionTree('nonexistent');
      expect(tree).toEqual([]);
    });

    it('recalculateConfidence() should throw for nonexistent id', async () => {
      await expect(
        collection.recalculateConfidence('nonexistent'),
      ).rejects.toThrow('Fact not found');
    });

    it('getEntityBriefing() should return empty briefing for no links', async () => {
      const briefing = await collection.getEntityBriefing(
        'Profile',
        'no-links',
      );
      expect(briefing.totalCount).toBe(0);
      expect(briefing.facts).toEqual([]);
    });
  });
});
