/**
 * Evolution tree tests - branch, chain, latest, tree
 *
 * Tests for the evolution tracking methods:
 * - branch() - Create a child fact with evolution metadata
 * - getEvolutionChain() - Walk up to root
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
    it('should create a child fact with parentId and evolutionType', async () => {
      const parent = await collection.create({
        textRefined: 'Original fact about the budget',
        type: 'assertion',
        domain: 'politics',
        status: 'active',
      });

      const child = await collection.branch(
        parent.id as string,
        {
          textRefined: 'Updated fact about the budget allocation',
          type: 'assertion',
          domain: 'politics',
        },
        'refinement',
      );

      expect(child.parentId).toBe(parent.id);
      expect(child.evolutionType).toBe('refinement');
      expect(child.status).toBe('active');
    });

    it('should mark parent as superseded for correction', async () => {
      const parent = await collection.create({
        textRefined: 'The budget is $1 million',
        status: 'active',
      });

      await collection.branch(
        parent.id as string,
        { textRefined: 'The budget is actually $2 million' },
        'correction',
      );

      // Reload parent to check status
      const reloadedParent = await collection.get({ id: parent.id });
      expect(reloadedParent?.status).toBe('superseded');
    });

    it('should mark parent as superseded for contradiction', async () => {
      const parent = await collection.create({
        textRefined: 'The meeting was cancelled',
        status: 'active',
      });

      await collection.branch(
        parent.id as string,
        { textRefined: 'The meeting went ahead as scheduled' },
        'contradiction',
      );

      const reloadedParent = await collection.get({ id: parent.id });
      expect(reloadedParent?.status).toBe('superseded');
    });

    it('should NOT mark parent as superseded for extension', async () => {
      const parent = await collection.create({
        textRefined: 'The council discussed three items',
        status: 'active',
      });

      await collection.branch(
        parent.id as string,
        { textRefined: 'The council also discussed a fourth item' },
        'extension',
      );

      const reloadedParent = await collection.get({ id: parent.id });
      expect(reloadedParent?.status).toBe('active');
    });

    it('should NOT mark parent as superseded for refinement', async () => {
      const parent = await collection.create({
        textRefined: 'The project is underway',
        status: 'active',
      });

      await collection.branch(
        parent.id as string,
        { textRefined: 'The project is 50% complete' },
        'refinement',
      );

      const reloadedParent = await collection.get({ id: parent.id });
      expect(reloadedParent?.status).toBe('active');
    });

    it('should throw if parent does not exist', async () => {
      await expect(
        collection.branch('nonexistent-id', { textRefined: 'test' }),
      ).rejects.toThrow('Parent fact not found');
    });

    it('should default to extension evolutionType', async () => {
      const parent = await collection.create({
        textRefined: 'Base fact',
        status: 'active',
      });

      const child = await collection.branch(parent.id as string, {
        textRefined: 'Extended fact',
      });

      expect(child.evolutionType).toBe('extension');
    });
  });

  describe('getEvolutionChain()', () => {
    it('should return single fact for root with no parents', async () => {
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
      const child = await collection.create({
        textRefined: 'Child',
        parentId: root.id as string,
        evolutionType: 'refinement',
      });
      const grandchild = await collection.create({
        textRefined: 'Grandchild',
        parentId: child.id as string,
        evolutionType: 'correction',
      });

      const chain = await collection.getEvolutionChain(grandchild.id as string);
      expect(chain.length).toBe(3);
      expect(chain[0].id).toBe(root.id);
      expect(chain[1].id).toBe(child.id);
      expect(chain[2].id).toBe(grandchild.id);
    });

    it('should return empty array for nonexistent fact', async () => {
      const chain = await collection.getEvolutionChain('does-not-exist');
      expect(chain).toEqual([]);
    });
  });

  describe('getLatestInChain()', () => {
    it('should return the fact itself if it has no children', async () => {
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

      // Create two children with different confidence
      await collection.create({
        textRefined: 'Low confidence child',
        parentId: root.id as string,
        confidence: 0.3,
      });
      const highChild = await collection.create({
        textRefined: 'High confidence child',
        parentId: root.id as string,
        confidence: 0.9,
      });

      const latest = await collection.getLatestInChain(root.id as string);
      expect(latest.id).toBe(highChild.id);
    });

    it('should traverse multiple levels', async () => {
      const root = await collection.create({
        textRefined: 'Root',
        confidence: 0.5,
      });
      const middle = await collection.create({
        textRefined: 'Middle',
        parentId: root.id as string,
        confidence: 0.7,
      });
      const leaf = await collection.create({
        textRefined: 'Leaf',
        parentId: middle.id as string,
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
      const child1 = await collection.create({
        textRefined: 'Child 1',
        parentId: root.id as string,
      });
      const child2 = await collection.create({
        textRefined: 'Child 2',
        parentId: root.id as string,
      });
      const grandchild = await collection.create({
        textRefined: 'Grandchild of child 1',
        parentId: child1.id as string,
      });

      const tree = await collection.getEvolutionTree(root.id as string);
      expect(tree.length).toBe(4);

      const treeIds = tree.map((f) => f.id);
      expect(treeIds).toContain(root.id);
      expect(treeIds).toContain(child1.id);
      expect(treeIds).toContain(child2.id);
      expect(treeIds).toContain(grandchild.id);
    });

    it('should find root when starting from a child', async () => {
      const root = await collection.create({
        textRefined: 'Root',
      });
      const child = await collection.create({
        textRefined: 'Child',
        parentId: root.id as string,
      });
      const grandchild = await collection.create({
        textRefined: 'Grandchild',
        parentId: child.id as string,
      });

      // Start from grandchild, should still get full tree
      const tree = await collection.getEvolutionTree(grandchild.id as string);
      expect(tree.length).toBe(3);

      const treeIds = tree.map((f) => f.id);
      expect(treeIds).toContain(root.id);
      expect(treeIds).toContain(child.id);
      expect(treeIds).toContain(grandchild.id);
    });

    it('should return empty array for nonexistent fact', async () => {
      const tree = await collection.getEvolutionTree('nonexistent');
      expect(tree).toEqual([]);
    });

    it('should handle branching tree structure', async () => {
      const root = await collection.create({ textRefined: 'Root' });
      const branch1 = await collection.create({
        textRefined: 'Branch 1',
        parentId: root.id as string,
      });
      const branch2 = await collection.create({
        textRefined: 'Branch 2',
        parentId: root.id as string,
      });
      const leaf1 = await collection.create({
        textRefined: 'Leaf 1',
        parentId: branch1.id as string,
      });
      const leaf2 = await collection.create({
        textRefined: 'Leaf 2',
        parentId: branch2.id as string,
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
