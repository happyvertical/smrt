/**
 * Test for Issue #89: JSON/DuckDB adapter schema transformation
 *
 * DuckDB and JSON adapters require inline UNIQUE constraints instead of
 * separate CREATE UNIQUE INDEX statements for ON CONFLICT clauses to work.
 *
 * This test verifies that SMRT automatically transforms schemas for these adapters.
 */

import { describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';

// Define test classes at module level so they get picked up by test manifest scanner
@smrt({
  api: { include: ['list', 'get'] },
})
class TestDocumentForDuckDB extends SmrtObject {
  title: string = '';
  content: string = '';
}

class TestDocumentCollection extends SmrtCollection<TestDocumentForDuckDB> {
  static readonly _itemClass = TestDocumentForDuckDB;
}

@smrt({
  api: { include: ['list', 'get'] },
})
class IndexedDocument extends SmrtObject {
  title: string = '';
  category: string = '';
  priority: number = 0;
}

class IndexedDocumentCollection extends SmrtCollection<IndexedDocument> {
  static readonly _itemClass = IndexedDocument;
}

@smrt({
  api: { include: ['list', 'get'] },
})
class ScopedDocument extends SmrtObject {
  title: string = '';
  content?: string; // Optional field (TypeScript optional property)
}

class ScopedDocumentCollection extends SmrtCollection<ScopedDocument> {
  static readonly _itemClass = ScopedDocument;
}

describe('Issue #89: DuckDB/JSON adapter schema transformation', () => {
  it('should transform UNIQUE indexes to inline constraints for DuckDB adapter', async () => {
    ObjectRegistry.registerCollection(
      'TestDocumentForDuckDB',
      TestDocumentCollection,
    );

    // Create collection with DuckDB adapter (in-memory)
    // DuckDB requires inline UNIQUE constraints instead of separate indexes
    const collection = await TestDocumentCollection.create({
      db: { type: 'duckdb', url: ':memory:' },
    });

    // Create an object to trigger schema generation
    const doc1 = await collection.create({
      slug: 'test-doc',
      title: 'Test Document',
      content: 'This is a test',
    });

    await doc1.save();

    // Verify we can retrieve the object
    const retrieved = await collection.get('test-doc');
    expect(retrieved).toBeDefined();
    expect(retrieved?.title).toBe('Test Document');

    // Test UPSERT - update existing object with same slug
    const doc2 = await collection.create({
      slug: 'test-doc', // Same slug
      title: 'Updated Document',
      content: 'This is updated',
    });

    await doc2.save(); // Should UPSERT (update existing)

    // Verify the object was updated, not duplicated
    const updated = await collection.get('test-doc');
    expect(updated).toBeDefined();
    expect(updated?.title).toBe('Updated Document');
    expect(updated?.content).toBe('This is updated');

    // Verify only one document exists
    const allDocs = await collection.list({});
    expect(allDocs.length).toBe(1);
  });

  it('should preserve non-UNIQUE indexes during transformation', async () => {
    ObjectRegistry.registerCollection(
      'IndexedDocument',
      IndexedDocumentCollection,
    );

    // Create collection with DuckDB adapter (in-memory)
    // DuckDB requires inline UNIQUE constraints instead of separate indexes
    const collection = await IndexedDocumentCollection.create({
      db: { type: 'duckdb', url: ':memory:' },
    });

    // Create and save an object
    const doc = await collection.create({
      slug: 'indexed-doc',
      title: 'Indexed Document',
      category: 'test',
      priority: 1,
    });

    await doc.save();

    // Verify we can query by indexed fields
    const byCategory = await collection.list({
      where: { category: 'test' },
    });
    expect(byCategory.length).toBe(1);
    expect(byCategory[0].title).toBe('Indexed Document');
  });

  it('should work with different contexts (scoped slugs)', async () => {
    ObjectRegistry.registerCollection(
      'ScopedDocument',
      ScopedDocumentCollection,
    );

    // Create collection with DuckDB adapter (in-memory)
    // DuckDB requires inline UNIQUE constraints instead of separate indexes
    const collection = await ScopedDocumentCollection.create({
      db: { type: 'duckdb', url: ':memory:' },
    });

    // Create objects with same slug but different contexts
    const blog = await collection.create({
      slug: 'hello-world',
      context: '/blog',
      title: 'Blog Post',
    });

    await blog.save();

    const doc = await collection.create({
      slug: 'hello-world',
      context: '/docs',
      title: 'Documentation',
    });
    await doc.save();

    // Verify both objects exist (different contexts)
    const allDocs = await collection.list({});
    expect(allDocs.length).toBe(2);

    // Verify we can retrieve each by slug + context
    const blogRetrieved = await collection.get({
      slug: 'hello-world',
      context: '/blog',
    });
    expect(blogRetrieved?.title).toBe('Blog Post');

    const docRetrieved = await collection.get({
      slug: 'hello-world',
      context: '/docs',
    });
    expect(docRetrieved?.title).toBe('Documentation');
  });
});
