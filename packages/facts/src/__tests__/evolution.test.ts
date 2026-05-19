/**
 * Evolution tree tests - branch, chain, latest, tree
 *
 * Tests for the evolution tracking methods:
 * - branch() - Create a successor fact with evolution metadata
 * - getEvolutionChain() - Walk up to root via previousFactId
 * - getLatestInChain() - Walk down to leaf (highest confidence)
 * - getEvolutionTree() - Full tree from root
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmbeddingProvider } from '@happyvertical/smrt-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FactCollection } from '../facts';

// Simple embedding mock - not used for semantic search here,
// but needed because Fact has autoGenerate: true on embeddings
function createSimpleEmbedding(text: string): number[] {
  const hash = text.split('').reduce((acc, char) => {
    return ((acc << 5) - acc + char.charCodeAt(0)) | 0;
  }, 0);
  return [
    Math.abs(Math.sin(hash)) * 0.5,
    Math.abs(Math.cos(hash)) * 0.5,
    Math.abs(Math.sin(hash * 2)) * 0.5,
    Math.abs(Math.cos(hash * 2)) * 0.5,
    Math.abs(Math.sin(hash * 3)) * 0.5,
  ];
}

describe('Evolution tree methods', () => {
  let tempDir: string;
  let dbPath: string;
  let collection: FactCollection;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'smrt-evolution-test-'));
    dbPath = join(tempDir, 'facts.db');

    // Mock the EmbeddingProvider
    vi.spyOn(EmbeddingProvider.prototype, 'embed').mockImplementation(
      async (texts: string | string[]) => {
        const textArray = Array.isArray(texts) ? texts : [texts];
        return textArray.map((t) => createSimpleEmbedding(t));
      },
    );
    vi.spyOn(EmbeddingProvider.prototype, 'getModelName').mockReturnValue(
      'test-model',
    );
    vi.spyOn(EmbeddingProvider.prototype, 'getDimensions').mockReturnValue(5);

    collection = await FactCollection.create({
      db: { type: 'sqlite', url: dbPath },
      ai: {
        embed: async (texts: string | string[]) => {
          const textArray = Array.isArray(texts) ? texts : [texts];
          return {
            embeddings: textArray.map((t) => createSimpleEmbedding(t)),
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

  describe('branch()', () => {
    it('should create a successor fact with previousFactId and evolutionType', async () => {
      const predecessor = await collection.create({
        textRefined: 'Original fact about the budget',
        type: 'assertion',
        domain: 'politics',
        status: 'active',
      });

      const successor = await collection.branch(
        predecessor.id as string,
        {
          textRefined: 'Updated fact about the budget allocation',
          type: 'assertion',
          domain: 'politics',
        },
        'refinement',
      );

      expect(successor.previousFactId).toBe(predecessor.id);
      expect(successor.evolutionType).toBe('refinement');
      expect(successor.status).toBe('active');
    });

    it('should mark predecessor as superseded for correction', async () => {
      const predecessor = await collection.create({
        textRefined: 'The budget is $1 million',
        status: 'active',
      });

      await collection.branch(
        predecessor.id as string,
        { textRefined: 'The budget is actually $2 million' },
        'correction',
      );

      // Reload predecessor to check status
      const reloaded = await collection.get({ id: predecessor.id });
      expect(reloaded?.status).toBe('superseded');
    });

    it('should mark predecessor as superseded for contradiction', async () => {
      const predecessor = await collection.create({
        textRefined: 'The meeting was cancelled',
        status: 'active',
      });

      await collection.branch(
        predecessor.id as string,
        { textRefined: 'The meeting went ahead as scheduled' },
        'contradiction',
      );

      const reloaded = await collection.get({ id: predecessor.id });
      expect(reloaded?.status).toBe('superseded');
    });

    it('should NOT mark predecessor as superseded for extension', async () => {
      const predecessor = await collection.create({
        textRefined: 'The council discussed three items',
        status: 'active',
      });

      await collection.branch(
        predecessor.id as string,
        { textRefined: 'The council also discussed a fourth item' },
        'extension',
      );

      const reloaded = await collection.get({ id: predecessor.id });
      expect(reloaded?.status).toBe('active');
    });

    it('should NOT mark predecessor as superseded for refinement', async () => {
      const predecessor = await collection.create({
        textRefined: 'The project is underway',
        status: 'active',
      });

      await collection.branch(
        predecessor.id as string,
        { textRefined: 'The project is 50% complete' },
        'refinement',
      );

      const reloaded = await collection.get({ id: predecessor.id });
      expect(reloaded?.status).toBe('active');
    });

    it('should throw if predecessor does not exist', async () => {
      await expect(
        collection.branch('nonexistent-id', { textRefined: 'test' }),
      ).rejects.toThrow('Predecessor fact not found');
    });

    it('should default to extension evolutionType', async () => {
      const predecessor = await collection.create({
        textRefined: 'Base fact',
        status: 'active',
      });

      const successor = await collection.branch(predecessor.id as string, {
        textRefined: 'Extended fact',
      });

      expect(successor.evolutionType).toBe('extension');
    });
  });

  describe('getEvolutionChain()', () => {
    it('should return single fact for root with no predecessor', async () => {
      const root = await collection.create({
        textRefined: 'Root fact',
      });

      const chain = await collection.getEvolutionChain(root.id as string);
      expect(chain.length).toBe(1);
      expect(chain[0].id).toBe(root.id);
    });

    it('should walk up to root and return root->current order', async () => {
      const root = await collection.create({
        textRefined: 'Root',
        status: 'active',
      });
      const middle = await collection.create({
        textRefined: 'Middle',
        previousFactId: root.id as string,
        evolutionType: 'refinement',
      });
      const leaf = await collection.create({
        textRefined: 'Leaf',
        previousFactId: middle.id as string,
        evolutionType: 'correction',
      });

      const chain = await collection.getEvolutionChain(leaf.id as string);
      expect(chain.length).toBe(3);
      expect(chain[0].id).toBe(root.id);
      expect(chain[1].id).toBe(middle.id);
      expect(chain[2].id).toBe(leaf.id);
    });

    it('should return empty array for nonexistent fact', async () => {
      const chain = await collection.getEvolutionChain('does-not-exist');
      expect(chain).toEqual([]);
    });
  });

  describe('getLatestInChain()', () => {
    it('should return the fact itself if it has no successors', async () => {
      const leaf = await collection.create({
        textRefined: 'Leaf fact',
      });

      const latest = await collection.getLatestInChain(leaf.id as string);
      expect(latest.id).toBe(leaf.id);
    });

    it('should walk down to the leaf with highest confidence', async () => {
      const root = await collection.create({
        textRefined: 'Root',
        status: 'active',
        confidence: 0.5,
      });

      // Create two successors with different confidence
      await collection.create({
        textRefined: 'Low confidence successor',
        previousFactId: root.id as string,
        confidence: 0.3,
      });
      const highSuccessor = await collection.create({
        textRefined: 'High confidence successor',
        previousFactId: root.id as string,
        confidence: 0.9,
      });

      const latest = await collection.getLatestInChain(root.id as string);
      expect(latest.id).toBe(highSuccessor.id);
    });

    it('should traverse multiple levels', async () => {
      const root = await collection.create({
        textRefined: 'Root',
        confidence: 0.5,
      });
      const middle = await collection.create({
        textRefined: 'Middle',
        previousFactId: root.id as string,
        confidence: 0.7,
      });
      const leaf = await collection.create({
        textRefined: 'Leaf',
        previousFactId: middle.id as string,
        confidence: 0.9,
      });

      const latest = await collection.getLatestInChain(root.id as string);
      expect(latest.id).toBe(leaf.id);
    });

    it('should throw for nonexistent fact', async () => {
      await expect(collection.getLatestInChain('nonexistent')).rejects.toThrow(
        'Fact not found',
      );
    });
  });

  describe('getEvolutionTree()', () => {
    it('should return single fact for root with no descendants', async () => {
      const root = await collection.create({
        textRefined: 'Standalone fact',
      });

      const tree = await collection.getEvolutionTree(root.id as string);
      expect(tree.length).toBe(1);
      expect(tree[0].id).toBe(root.id);
    });

    it('should collect all descendants from root', async () => {
      const root = await collection.create({
        textRefined: 'Root',
      });
      const succ1 = await collection.create({
        textRefined: 'Successor 1',
        previousFactId: root.id as string,
      });
      const succ2 = await collection.create({
        textRefined: 'Successor 2',
        previousFactId: root.id as string,
      });
      const grandSucc = await collection.create({
        textRefined: 'Grand-successor of successor 1',
        previousFactId: succ1.id as string,
      });

      const tree = await collection.getEvolutionTree(root.id as string);
      expect(tree.length).toBe(4);

      const treeIds = tree.map((f) => f.id);
      expect(treeIds).toContain(root.id);
      expect(treeIds).toContain(succ1.id);
      expect(treeIds).toContain(succ2.id);
      expect(treeIds).toContain(grandSucc.id);
    });

    it('should find root when starting from a successor', async () => {
      const root = await collection.create({
        textRefined: 'Root',
      });
      const middle = await collection.create({
        textRefined: 'Middle',
        previousFactId: root.id as string,
      });
      const leaf = await collection.create({
        textRefined: 'Leaf',
        previousFactId: middle.id as string,
      });

      // Start from leaf, should still get full tree
      const tree = await collection.getEvolutionTree(leaf.id as string);
      expect(tree.length).toBe(3);

      const treeIds = tree.map((f) => f.id);
      expect(treeIds).toContain(root.id);
      expect(treeIds).toContain(middle.id);
      expect(treeIds).toContain(leaf.id);
    });

    it('should return empty array for nonexistent fact', async () => {
      const tree = await collection.getEvolutionTree('nonexistent');
      expect(tree).toEqual([]);
    });

    it('should handle branching tree structure', async () => {
      const root = await collection.create({ textRefined: 'Root' });
      const branch1 = await collection.create({
        textRefined: 'Branch 1',
        previousFactId: root.id as string,
      });
      const branch2 = await collection.create({
        textRefined: 'Branch 2',
        previousFactId: root.id as string,
      });
      const leaf1 = await collection.create({
        textRefined: 'Leaf 1',
        previousFactId: branch1.id as string,
      });
      const leaf2 = await collection.create({
        textRefined: 'Leaf 2',
        previousFactId: branch2.id as string,
      });

      const tree = await collection.getEvolutionTree(root.id as string);
      expect(tree.length).toBe(5);

      const ids = tree.map((f) => f.id);
      expect(ids).toContain(root.id);
      expect(ids).toContain(branch1.id);
      expect(ids).toContain(branch2.id);
      expect(ids).toContain(leaf1.id);
      expect(ids).toContain(leaf2.id);
    });
  });
});
