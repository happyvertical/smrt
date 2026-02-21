/**
 * FactSource model tests - CRUD, getForFact, countForFact, credibility
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FactSourceCollection } from '../fact-sources';
import { FactCollection } from '../facts';

describe('FactSource', () => {
  let tempDir: string;
  let dbPath: string;
  let facts: FactCollection;
  let sources: FactSourceCollection;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'smrt-fact-source-test-'));
    dbPath = join(tempDir, 'facts.db');

    facts = await FactCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    sources = await FactSourceCollection.create({
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
    it('should create a source linked to a fact', async () => {
      const fact = await facts.create({ textRefined: 'Test fact' });

      const source = await sources.create({
        factId: fact.id as string,
        sourceType: 'web',
        sourceUrl: 'https://example.com/article',
        sourceTitle: 'Example Article',
        credibility: 0.8,
      });

      expect(source.id).toBeDefined();
      expect(source.factId).toBe(fact.id);
      expect(source.sourceType).toBe('web');
      expect(source.sourceUrl).toBe('https://example.com/article');
      expect(source.sourceTitle).toBe('Example Article');
      expect(source.credibility).toBe(0.8);
    });

    it('should retrieve a source by id', async () => {
      const fact = await facts.create({ textRefined: 'Test' });
      const created = await sources.create({
        factId: fact.id as string,
        sourceType: 'document',
      });

      const loaded = await sources.get({ id: created.id });
      expect(loaded).not.toBeNull();
      expect(loaded?.sourceType).toBe('document');
    });

    it('should delete a source', async () => {
      const fact = await facts.create({ textRefined: 'Test' });
      const source = await sources.create({
        factId: fact.id as string,
        sourceType: 'web',
      });

      await source.delete();
      const loaded = await sources.get({ id: source.id });
      expect(loaded).toBeNull();
    });
  });

  describe('getForFact', () => {
    it('should get all sources for a fact', async () => {
      const fact = await facts.create({ textRefined: 'Multi-source fact' });
      const factId = fact.id as string;

      await sources.create({
        factId,
        sourceType: 'web',
        sourceUrl: 'https://example.com/1',
      });
      await sources.create({
        factId,
        sourceType: 'document',
        sourceUrl: 'file:///doc.pdf',
      });
      await sources.create({
        factId,
        sourceType: 'api',
        sourceUrl: 'https://api.example.com/data',
      });

      const factSources = await sources.getForFact(factId);
      expect(factSources.length).toBe(3);
    });

    it('should return empty array for fact with no sources', async () => {
      const fact = await facts.create({ textRefined: 'No sources' });
      const factSources = await sources.getForFact(fact.id as string);
      expect(factSources).toEqual([]);
    });
  });

  describe('countForFact', () => {
    it('should count sources for a fact', async () => {
      const fact = await facts.create({ textRefined: 'Count test' });
      const factId = fact.id as string;

      await sources.create({ factId, sourceType: 'web' });
      await sources.create({ factId, sourceType: 'document' });

      const count = await sources.countForFact(factId);
      expect(count).toBe(2);
    });
  });

  describe('credibility queries', () => {
    it('should get high credibility sources', async () => {
      const fact = await facts.create({ textRefined: 'Cred test' });
      const factId = fact.id as string;

      await sources.create({ factId, sourceType: 'web', credibility: 0.9 });
      await sources.create({ factId, sourceType: 'web', credibility: 0.3 });
      await sources.create({ factId, sourceType: 'web', credibility: 0.8 });

      const highCred = await sources.getHighCredibility(0.7);
      expect(highCred.length).toBe(2);
    });

    it('should calculate average credibility for a fact', async () => {
      const fact = await facts.create({ textRefined: 'Avg test' });
      const factId = fact.id as string;

      await sources.create({ factId, sourceType: 'web', credibility: 0.8 });
      await sources.create({ factId, sourceType: 'web', credibility: 0.6 });

      const avg = await sources.getAverageCredibility(factId);
      expect(avg).toBeCloseTo(0.7, 5);
    });

    it('should return 0 average for fact with no sources', async () => {
      const avg = await sources.getAverageCredibility('nonexistent');
      expect(avg).toBe(0);
    });
  });

  describe('metadata', () => {
    it('should store and retrieve metadata', async () => {
      const fact = await facts.create({ textRefined: 'Meta test' });
      const source = await sources.create({
        factId: fact.id as string,
        sourceType: 'web',
        metadata: { pageNumber: 5, section: 'introduction' },
      });

      const meta = source.getMetadata();
      expect(meta.pageNumber).toBe(5);
      expect(meta.section).toBe('introduction');
    });

    it('should round-trip metadata through save/load', async () => {
      const fact = await facts.create({ textRefined: 'Round trip' });
      const source = await sources.create({
        factId: fact.id as string,
        sourceType: 'api',
        metadata: { endpoint: '/data', responseCode: 200 },
      });
      await source.save();

      const loaded = await sources.get({ id: source.id });
      const meta = loaded?.getMetadata();
      expect(meta.endpoint).toBe('/data');
      expect(meta.responseCode).toBe(200);
    });
  });

  describe('getByType', () => {
    it('should filter sources by type', async () => {
      const fact = await facts.create({ textRefined: 'Type test' });
      const factId = fact.id as string;

      await sources.create({ factId, sourceType: 'web' });
      await sources.create({ factId, sourceType: 'document' });
      await sources.create({ factId, sourceType: 'web' });

      const webSources = await sources.getByType('web');
      expect(webSources.length).toBe(2);
    });
  });

  describe('navigation', () => {
    it('should navigate to parent fact', async () => {
      const fact = await facts.create({ textRefined: 'Parent fact' });
      const source = await sources.create({
        factId: fact.id as string,
        sourceType: 'web',
      });

      const parentFact = await source.getFact();
      expect(parentFact).not.toBeNull();
      expect(parentFact?.textRefined).toBe('Parent fact');
    });
  });
});
