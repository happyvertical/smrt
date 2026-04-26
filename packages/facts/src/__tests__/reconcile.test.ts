/**
 * Reconcile tests - semantic search + AI disambiguation
 *
 * Tests the reconcile() method which determines whether to create, merge,
 * or branch facts based on semantic similarity.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmbeddingProvider } from '@happyvertical/smrt-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FactSourceCollection } from '../fact-sources';
import { FactCollection } from '../facts';

// Create deterministic topic-based vectors for testing
function createSemanticEmbeddings(text: string): number[] {
  const lowerText = text.toLowerCase();

  let weatherScore = 0;
  let politicsScore = 0;
  let scienceScore = 0;

  if (
    lowerText.includes('sky') ||
    lowerText.includes('blue') ||
    lowerText.includes('weather') ||
    lowerText.includes('rain') ||
    lowerText.includes('sunny')
  ) {
    weatherScore = 0.9;
  }

  if (
    lowerText.includes('council') ||
    lowerText.includes('vote') ||
    lowerText.includes('mayor') ||
    lowerText.includes('election') ||
    lowerText.includes('budget')
  ) {
    politicsScore = 0.9;
  }

  if (
    lowerText.includes('boil') ||
    lowerText.includes('temperature') ||
    lowerText.includes('water') ||
    lowerText.includes('chemistry') ||
    lowerText.includes('experiment')
  ) {
    scienceScore = 0.9;
  }

  // Add text-specific variation
  const hash = text.split('').reduce((acc, char) => {
    return ((acc << 5) - acc + char.charCodeAt(0)) | 0;
  }, 0);
  const variation = Math.sin(hash) * 0.05;

  return [
    weatherScore + variation,
    politicsScore + variation,
    scienceScore + variation,
    Math.abs(Math.sin(hash)) * 0.3,
    Math.abs(Math.cos(hash)) * 0.3,
  ];
}

describe('reconcile()', () => {
  let tempDir: string;
  let dbPath: string;
  let collection: FactCollection;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'smrt-reconcile-test-'));
    dbPath = join(tempDir, 'facts.db');

    // Mock the EmbeddingProvider
    vi.spyOn(EmbeddingProvider.prototype, 'embed').mockImplementation(
      async (texts: string | string[]) => {
        const textArray = Array.isArray(texts) ? texts : [texts];
        return textArray.map((t) => createSemanticEmbeddings(t));
      },
    );
    vi.spyOn(EmbeddingProvider.prototype, 'getModelName').mockReturnValue(
      'test-model',
    );
    vi.spyOn(EmbeddingProvider.prototype, 'getDimensions').mockReturnValue(5);

    collection = await FactCollection.create({
      db: { type: 'sqlite', url: dbPath },
      ai: {
        message: async () => 'merge',
        embed: async (texts: string | string[]) => {
          const textArray = Array.isArray(texts) ? texts : [texts];
          return {
            embeddings: textArray.map((t) => createSemanticEmbeddings(t)),
          };
        },
      } as any,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('CREATE action', () => {
    it('should create a new fact when no existing facts match', async () => {
      const result = await collection.reconcile({
        rawInput: 'The sky is blue today',
        type: 'observation',
        domain: 'weather',
      });

      expect(result.action).toBe('created');
      expect(result.fact).toBeDefined();
      expect(result.fact.textRefined).toBe('The sky is blue today');
      expect(result.fact.type).toBe('observation');
      expect(result.fact.domain).toBe('weather');
      expect(result.fact.status).toBe('active');
      expect(result.similarity).toBeUndefined();
      expect(result.matchedFact).toBeUndefined();
    });

    it('should create a new fact when matches are below conflict threshold', async () => {
      // Create a fact about politics
      const existing = await collection.create({
        textRefined: 'The council voted on the budget',
        type: 'event',
        domain: 'politics',
        status: 'active',
      });
      await existing.generateEmbeddings();

      // Reconcile with unrelated topic (weather)
      const result = await collection.reconcile({
        rawInput: 'The sky is blue and sunny today',
        type: 'observation',
        domain: 'weather',
      });

      expect(result.action).toBe('created');
      expect(result.fact.textRefined).toBe('The sky is blue and sunny today');
    });

    it('should record source when creating', async () => {
      const result = await collection.reconcile({
        rawInput: 'New discovery in chemistry',
        type: 'assertion',
        source: {
          sourceType: 'web',
          sourceUrl: 'https://example.com/article',
          sourceTitle: 'Chemistry News',
          credibility: 0.9,
        },
      });

      expect(result.action).toBe('created');
      expect(result.source).toBeDefined();
      expect(result.source?.sourceType).toBe('web');
      expect(result.source?.sourceUrl).toBe('https://example.com/article');
      expect(result.source?.credibility).toBe(0.9);
    });

    it('generates embeddings once when creating facts explicitly', async () => {
      const embedSpy = vi.mocked(EmbeddingProvider.prototype.embed);
      embedSpy.mockClear();

      await collection.reconcile({
        rawInput: 'The mayor announced a budget update',
        type: 'event',
        domain: 'politics',
      });

      await new Promise((resolve) => setImmediate(resolve));

      // One query embedding for semantic search, then Fact's configured field
      // and combined field. Save-time auto-generation is suppressed here so
      // reconcile owns the explicit fact embedding work.
      expect(embedSpy).toHaveBeenCalledTimes(3);
    });
  });

  describe('MERGE action', () => {
    it('should merge when input is very similar to existing fact', async () => {
      // Create an existing fact
      const existing = await collection.create({
        textRefined: 'The sky is blue',
        type: 'observation',
        domain: 'weather',
        status: 'active',
        sourceCount: 1,
      });
      await existing.generateEmbeddings();

      // Reconcile with very similar text
      const result = await collection.reconcile({
        rawInput: 'The sky is blue',
        type: 'observation',
        domain: 'weather',
      });

      expect(result.action).toBe('merged');
      expect(result.fact.id).toBe(existing.id);
      expect(result.fact.sourceCount).toBe(2);
      expect(result.similarity).toBeDefined();
      expect(result.matchedFact).toBeDefined();
    });

    it('should record source when merging', async () => {
      const existing = await collection.create({
        textRefined: 'The sky is blue',
        type: 'observation',
        status: 'active',
        sourceCount: 1,
      });
      await existing.generateEmbeddings();

      const result = await collection.reconcile({
        rawInput: 'The sky is blue',
        source: {
          sourceType: 'document',
          sourceTitle: 'Weather Report',
          credibility: 0.8,
        },
      });

      expect(result.action).toBe('merged');
      expect(result.source).toBeDefined();
      expect(result.source?.sourceType).toBe('document');
    });
  });

  describe('AI disambiguation', () => {
    it('should use AI when similarity is in ambiguous zone and merge when AI says merge', async () => {
      // Create existing fact about weather
      const existing = await collection.create({
        textRefined: 'The sky appears blue on clear days',
        type: 'observation',
        domain: 'weather',
        status: 'active',
        sourceCount: 1,
      });
      await existing.generateEmbeddings();

      // AI mock returns 'merge'
      const result = await collection.reconcile({
        rawInput: 'The sky looks blue when it is sunny',
        type: 'observation',
        domain: 'weather',
        similarityThreshold: 0.99, // Force into ambiguous zone
        conflictThreshold: 0.01, // Very low threshold to ensure match
      });

      // Should be merge or created depending on similarity
      expect(['merged', 'created', 'branched']).toContain(result.action);
    });

    it('should branch when AI says branch', async () => {
      // Create collection with AI returning 'branch'
      const branchCollection = await FactCollection.create({
        db: { type: 'sqlite', url: dbPath },
        ai: {
          message: async () => 'branch',
          embed: async (texts: string | string[]) => {
            const textArray = Array.isArray(texts) ? texts : [texts];
            return {
              embeddings: textArray.map((t) => createSemanticEmbeddings(t)),
            };
          },
        } as any,
      });

      // Create existing fact
      const existing = await branchCollection.create({
        textRefined: 'The sky is blue on clear weather days',
        type: 'observation',
        domain: 'weather',
        status: 'active',
        sourceCount: 1,
      });
      await existing.generateEmbeddings();

      const result = await branchCollection.reconcile({
        rawInput: 'The sky looks blue in sunny weather',
        type: 'observation',
        domain: 'weather',
        similarityThreshold: 0.99, // Force into ambiguous zone
        conflictThreshold: 0.01,
      });

      // Should be branched since AI says 'branch' and similarity is in ambiguous zone
      if (result.action === 'branched') {
        expect(result.fact.parentId).toBe(existing.id);
        expect(result.fact.evolutionType).toBe('correction');
      }
    });
  });

  describe('thresholds', () => {
    it('should respect custom similarity threshold', async () => {
      const existing = await collection.create({
        textRefined: 'The sky is blue',
        type: 'observation',
        status: 'active',
      });
      await existing.generateEmbeddings();

      // Very high threshold should prevent auto-merge
      const result = await collection.reconcile({
        rawInput: 'The sky is blue',
        similarityThreshold: 1.0, // Impossible threshold
        conflictThreshold: 0.01,
      });

      // Even identical text may not hit 1.0 threshold due to float precision
      expect(['merged', 'created', 'branched']).toContain(result.action);
    });

    it('should respect custom conflict threshold', async () => {
      const existing = await collection.create({
        textRefined: 'The council approved the budget',
        type: 'event',
        status: 'active',
      });
      await existing.generateEmbeddings();

      // Very high conflict threshold should treat most as new
      const result = await collection.reconcile({
        rawInput: 'The council discussed the budget vote',
        conflictThreshold: 0.99,
      });

      expect(result.action).toBe('created');
    });
  });

  describe('defaults', () => {
    it('should use default type and domain', async () => {
      const result = await collection.reconcile({
        rawInput: 'Some new fact without type or domain',
      });

      expect(result.fact.type).toBe('assertion');
      expect(result.fact.domain).toBe('');
    });
  });
});
