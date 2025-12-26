/**
 * Integration tests for auto-generation hook in save()
 *
 * Tests:
 * 1. Auto-generation when autoGenerate is enabled
 * 2. No auto-generation when autoGenerate is disabled
 * 3. Skip generation when content hasn't changed
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmrtCollection } from '../collection';
import { EmbeddingProvider } from '../embeddings/provider';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';

// Simple mock embeddings
function createMockEmbeddings(text: string): number[] {
  const hash = text.split('').reduce((acc, char) => {
    return ((acc << 5) - acc + char.charCodeAt(0)) | 0;
  }, 0);
  return [Math.sin(hash), Math.cos(hash), Math.sin(hash * 2)];
}

// Test document with auto-generation ENABLED
@smrt({
  embeddings: {
    fields: ['content'],
    autoGenerate: true, // Enable auto-generation
  },
})
class AutoGenDocument extends SmrtObject {
  title: string = '';
  content: string = '';
}

class AutoGenDocumentCollection extends SmrtCollection<AutoGenDocument> {
  static readonly _itemClass = AutoGenDocument;
}

// Test document with auto-generation DISABLED
@smrt({
  embeddings: {
    fields: ['content'],
    autoGenerate: false, // Disable auto-generation
  },
})
class ManualGenDocument extends SmrtObject {
  title: string = '';
  content: string = '';
}

class ManualGenDocumentCollection extends SmrtCollection<ManualGenDocument> {
  static readonly _itemClass = ManualGenDocument;
}

// Test document with NO embeddings config
@smrt()
class NoEmbeddingsDocument extends SmrtObject {
  title: string = '';
  content: string = '';
}

class NoEmbeddingsDocumentCollection extends SmrtCollection<NoEmbeddingsDocument> {
  static readonly _itemClass = NoEmbeddingsDocument;
}

describe('Embedding Auto-Generation Hook', () => {
  let tempDir: string;
  let dbPath: string;
  let embedSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'smrt-autogen-test-'));
    dbPath = join(tempDir, 'documents.db');

    // Register collections
    ObjectRegistry.registerCollection(
      'AutoGenDocument',
      AutoGenDocumentCollection,
    );
    ObjectRegistry.registerCollection(
      'ManualGenDocument',
      ManualGenDocumentCollection,
    );
    ObjectRegistry.registerCollection(
      'NoEmbeddingsDocument',
      NoEmbeddingsDocumentCollection,
    );

    // Mock the EmbeddingProvider
    embedSpy = vi
      .spyOn(EmbeddingProvider.prototype, 'embed')
      .mockImplementation(async (texts: string | string[]) => {
        const textArray = Array.isArray(texts) ? texts : [texts];
        return textArray.map((t) => createMockEmbeddings(t));
      });

    vi.spyOn(EmbeddingProvider.prototype, 'getModelName').mockReturnValue(
      'test-model',
    );
    vi.spyOn(EmbeddingProvider.prototype, 'getDimensions').mockReturnValue(3);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('when autoGenerate is true', () => {
    it('should auto-generate embeddings on first save', async () => {
      const collection = await AutoGenDocumentCollection.create({
        db: { type: 'sqlite', url: dbPath },
        ai: {
          embed: async (texts: string | string[]) => {
            const textArray = Array.isArray(texts) ? texts : [texts];
            return {
              embeddings: textArray.map((t) => createMockEmbeddings(t)),
            };
          },
        } as any,
      });

      const doc = await collection.create({
        title: 'Auto Gen Test',
        content: 'Content that triggers auto-generation',
      });

      // Clear the spy before save to isolate the auto-generation call
      embedSpy.mockClear();

      await doc.save();

      // Wait a bit for async embedding generation to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      // embedSpy should have been called (auto-generation triggered)
      expect(embedSpy).toHaveBeenCalled();
    });

    it('should skip auto-generation if content unchanged', async () => {
      const collection = await AutoGenDocumentCollection.create({
        db: { type: 'sqlite', url: dbPath },
        ai: {
          embed: async (texts: string | string[]) => {
            const textArray = Array.isArray(texts) ? texts : [texts];
            return {
              embeddings: textArray.map((t) => createMockEmbeddings(t)),
            };
          },
        } as any,
      });

      const doc = await collection.create({
        title: 'No Change Test',
        content: 'Content that stays the same',
      });

      await doc.save();

      // Wait for first auto-generation
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Clear spy and save again without changes
      embedSpy.mockClear();

      await doc.save();

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 100));

      // embed should NOT have been called (content unchanged)
      expect(embedSpy).not.toHaveBeenCalled();
    });

    it('should regenerate when content changes', async () => {
      const collection = await AutoGenDocumentCollection.create({
        db: { type: 'sqlite', url: dbPath },
        ai: {
          embed: async (texts: string | string[]) => {
            const textArray = Array.isArray(texts) ? texts : [texts];
            return {
              embeddings: textArray.map((t) => createMockEmbeddings(t)),
            };
          },
        } as any,
      });

      const doc = await collection.create({
        title: 'Change Test',
        content: 'Original content',
      });

      await doc.save();

      // Wait for first auto-generation
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Modify content
      doc.content = 'Updated content that is different';
      embedSpy.mockClear();

      await doc.save();

      // Wait for regeneration
      await new Promise((resolve) => setTimeout(resolve, 100));

      // embed should have been called (content changed)
      expect(embedSpy).toHaveBeenCalled();
    });
  });

  describe('when autoGenerate is false', () => {
    it('should NOT auto-generate embeddings on save', async () => {
      const collection = await ManualGenDocumentCollection.create({
        db: { type: 'sqlite', url: dbPath },
        ai: {
          embed: async (texts: string | string[]) => {
            const textArray = Array.isArray(texts) ? texts : [texts];
            return {
              embeddings: textArray.map((t) => createMockEmbeddings(t)),
            };
          },
        } as any,
      });

      const doc = await collection.create({
        title: 'Manual Gen Test',
        content: 'Content that should not auto-generate',
      });

      embedSpy.mockClear();

      await doc.save();

      // Wait to ensure no async generation happens
      await new Promise((resolve) => setTimeout(resolve, 100));

      // embed should NOT have been called (autoGenerate: false)
      expect(embedSpy).not.toHaveBeenCalled();
    });

    it('should generate when explicitly called', async () => {
      const collection = await ManualGenDocumentCollection.create({
        db: { type: 'sqlite', url: dbPath },
        ai: {
          embed: async (texts: string | string[]) => {
            const textArray = Array.isArray(texts) ? texts : [texts];
            return {
              embeddings: textArray.map((t) => createMockEmbeddings(t)),
            };
          },
        } as any,
      });

      const doc = await collection.create({
        title: 'Explicit Gen Test',
        content: 'Content for explicit generation',
      });

      await doc.save();

      embedSpy.mockClear();

      // Explicitly generate embeddings
      await doc.generateEmbeddings();

      expect(embedSpy).toHaveBeenCalled();

      // Verify embedding was stored
      const embedding = await doc.getEmbedding('content');
      expect(embedding).not.toBeNull();
    });
  });

  describe('when no embeddings config', () => {
    it('should not attempt any embedding operations', async () => {
      const collection = await NoEmbeddingsDocumentCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      const doc = await collection.create({
        title: 'No Embeddings',
        content: 'This class has no embeddings config',
      });

      embedSpy.mockClear();

      await doc.save();

      // Wait to ensure no async generation happens
      await new Promise((resolve) => setTimeout(resolve, 100));

      // embed should NOT have been called
      expect(embedSpy).not.toHaveBeenCalled();
    });
  });

  describe('without AI client', () => {
    it('should skip auto-generation when no AI client available', async () => {
      const collection = await AutoGenDocumentCollection.create({
        db: { type: 'sqlite', url: dbPath },
        // No AI client provided
      });

      const doc = await collection.create({
        title: 'No AI Test',
        content: 'Content without AI client',
      });

      embedSpy.mockClear();

      // Should not throw - just skips embedding generation
      await doc.save();

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 100));

      // embed should NOT have been called (no AI client)
      expect(embedSpy).not.toHaveBeenCalled();
    });
  });
});
