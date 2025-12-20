/**
 * Test for Issues #533 and #534: JSON adapter lost update bug
 *
 * PROBLEM:
 * - When multiple documents are saved to the same collection via JSON adapter,
 *   only the last record is persisted
 * - Earlier writes are silently lost
 * - This happens even when saves are minutes apart (not concurrent)
 *
 * ROOT CAUSE HYPOTHESIS:
 * - Each collection instance may be creating a new DuckDB in-memory connection
 * - New connections load from JSON file, but cache may not be working correctly
 * - When a new connection writes, it overwrites the JSON file with only its data
 *
 * What these tests verify:
 * - Multiple records from same collection instance persist correctly
 * - Multiple records from different collection instances (simulating restarts) persist
 * - STI subclasses in shared table all persist correctly
 * - Rapid sequential saves all persist
 */

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { SmrtObject, smrt } from '../index';

// Import clearConnectionCache to simulate app restarts
let clearConnectionCache: () => void;
try {
  const sqlModule = await import('@happyvertical/sql');
  clearConnectionCache = sqlModule.clearConnectionCache;
} catch {
  // Fallback if import fails
  clearConnectionCache = () => {};
}

// Test classes - use unique prefix to avoid registry collisions
@smrt()
class Issue533Document extends SmrtObject {
  title: string = '';
  content: string = '';
  meetingId: string = '';
}

// STI test classes
@smrt({ tableStrategy: 'sti' })
class Issue533Content extends SmrtObject {
  title: string = '';
  body: string = '';
}

@smrt()
class Issue533Highlights extends Issue533Content {
  meetingId: string = '';
  highlights: string[] = [];
}

@smrt()
class Issue533Summary extends Issue533Content {
  meetingId: string = '';
  wordCount: number = 0;
}

// Collections
class Issue533DocumentCollection extends SmrtCollection<Issue533Document> {
  static readonly _itemClass = Issue533Document;
}

class Issue533ContentCollection extends SmrtCollection<Issue533Content> {
  static readonly _itemClass = Issue533Content;
}

// Helper to find JSON files in a directory
function findJSONFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}

// Helper to read JSON file contents
function readJSONFile(dir: string, filename: string): any[] {
  const filePath = path.join(dir, filename);
  if (!existsSync(filePath)) return [];
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return [];
  }
}

describe('Issues #533/#534: JSON Adapter Lost Update Bug', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'smrt-test-533-534-'));
    // Clear connection cache before each test
    clearConnectionCache();
  });

  afterEach(() => {
    clearConnectionCache();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Single collection instance - multiple records', () => {
    it('should persist multiple records saved from same collection instance', async () => {
      const collection = await Issue533DocumentCollection.create({
        persistence: {
          type: 'json',
          url: tempDir,
          writeStrategy: 'immediate',
        },
      });

      // Save 3 documents sequentially
      const doc1 = await collection.create({
        title: 'Document 1',
        content: 'Content for doc 1',
        meetingId: 'meeting-1',
      });

      const doc2 = await collection.create({
        title: 'Document 2',
        content: 'Content for doc 2',
        meetingId: 'meeting-2',
      });

      const doc3 = await collection.create({
        title: 'Document 3',
        content: 'Content for doc 3',
        meetingId: 'meeting-3',
      });

      // Verify all 3 are in the collection
      const allDocs = await collection.list({});
      expect(allDocs.length).toBe(3);

      // Debug: List all JSON files in temp directory
      const jsonFiles = findJSONFiles(tempDir);
      console.log('[DEBUG] JSON files in temp dir:', jsonFiles);

      // Find the documents JSON file (table name is snake_case + pluralized)
      const docsFile = jsonFiles.find(
        (f) =>
          f.includes('issue533') ||
          f.includes('document') ||
          f.includes('Issue533'),
      );
      expect(docsFile).toBeDefined();

      const jsonContent = readJSONFile(tempDir, docsFile!);
      console.log('[DEBUG] JSON content:', jsonContent.length, 'records');

      expect(jsonContent.length).toBe(3);
      expect(jsonContent.map((r: any) => r.title)).toEqual(
        expect.arrayContaining(['Document 1', 'Document 2', 'Document 3']),
      );
    });
  });

  describe('Multiple collection instances - simulating app restarts', () => {
    it('should persist records across collection instance recreations', async () => {
      // STEP 1: Create first collection instance, save record 1
      const collection1 = await Issue533DocumentCollection.create({
        persistence: {
          type: 'json',
          url: tempDir,
          writeStrategy: 'immediate',
        },
      });

      const doc1 = await collection1.create({
        title: 'First Document',
        content: 'First content',
        meetingId: 'meeting-nov-27',
      });

      // Verify doc1 is saved
      const afterFirst = await collection1.list({});
      expect(afterFirst.length).toBe(1);

      // Debug: Check files after first save
      console.log(
        '[DEBUG] After first save, JSON files:',
        findJSONFiles(tempDir),
      );

      // STEP 2: Clear cache (simulate app restart), create new collection instance
      clearConnectionCache();

      const collection2 = await Issue533DocumentCollection.create({
        persistence: {
          type: 'json',
          url: tempDir,
          writeStrategy: 'immediate',
        },
      });

      // Verify doc1 is still visible in new collection instance
      const beforeSecond = await collection2.list({});
      console.log(
        '[DEBUG] Before second save, docs in collection:',
        beforeSecond.length,
      );
      expect(beforeSecond.length).toBe(1);
      expect(beforeSecond[0].title).toBe('First Document');

      // Save record 2
      const doc2 = await collection2.create({
        title: 'Second Document',
        content: 'Second content',
        meetingId: 'meeting-nov-13',
      });

      // Verify BOTH documents exist
      const afterSecond = await collection2.list({});
      console.log(
        '[DEBUG] After second save, docs in collection:',
        afterSecond.length,
      );
      expect(afterSecond.length).toBe(2);

      // STEP 3: Another restart, create third collection instance
      clearConnectionCache();

      const collection3 = await Issue533DocumentCollection.create({
        persistence: {
          type: 'json',
          url: tempDir,
          writeStrategy: 'immediate',
        },
      });

      // Verify both docs still exist
      const beforeThird = await collection3.list({});
      console.log(
        '[DEBUG] Before third save, docs in collection:',
        beforeThird.length,
      );
      expect(beforeThird.length).toBe(2);

      // Save record 3
      const doc3 = await collection3.create({
        title: 'Third Document',
        content: 'Third content',
        meetingId: 'meeting-oct-30',
      });

      // Verify ALL THREE documents exist
      const afterThird = await collection3.list({});
      console.log(
        '[DEBUG] After third save, docs in collection:',
        afterThird.length,
      );
      expect(afterThird.length).toBe(3);

      // STEP 4: Final verification - restart and check persistence
      clearConnectionCache();

      const finalCollection = await Issue533DocumentCollection.create({
        persistence: {
          type: 'json',
          url: tempDir,
          writeStrategy: 'immediate',
        },
      });

      const finalDocs = await finalCollection.list({});
      console.log('[DEBUG] Final docs count:', finalDocs.length);
      expect(finalDocs.length).toBe(3);
      expect(finalDocs.map((d) => d.title)).toEqual(
        expect.arrayContaining([
          'First Document',
          'Second Document',
          'Third Document',
        ]),
      );

      // Verify JSON file
      const jsonFiles = findJSONFiles(tempDir);
      console.log('[DEBUG] Final JSON files:', jsonFiles);
      const docsFile = jsonFiles.find(
        (f) =>
          f.includes('issue533') ||
          f.includes('document') ||
          f.includes('Issue533'),
      );
      expect(docsFile).toBeDefined();

      const jsonContent = readJSONFile(tempDir, docsFile!);
      expect(jsonContent.length).toBe(3);
    });
  });

  describe('STI classes - shared table persistence', () => {
    it('should persist all STI subclass records in shared table', async () => {
      const persistenceConfig = {
        type: 'json' as const,
        url: tempDir,
        writeStrategy: 'immediate' as const,
      };

      // STEP 1: Save highlights using collection.create()
      const collection1 = await Issue533ContentCollection.create({
        persistence: persistenceConfig,
      });

      // Use collection.create() which properly handles STI
      // For STI, we need to specify _meta_type
      const highlights1 = await collection1.create({
        _meta_type: 'Issue533Highlights',
        title: 'Nov 27 Meeting Highlights',
        body: 'Key points from the meeting...',
        meetingId: 'meeting-nov-27',
        highlights: ['Point 1', 'Point 2'],
      } as any);

      const afterFirstSave = await collection1.list({});
      console.log('[DEBUG] STI after first save:', afterFirstSave.length);
      expect(afterFirstSave.length).toBe(1);

      // STEP 2: Restart, save another highlights
      clearConnectionCache();

      const collection2 = await Issue533ContentCollection.create({
        persistence: persistenceConfig,
      });

      // Check first is still there
      const beforeSecondSave = await collection2.list({});
      console.log('[DEBUG] STI before second save:', beforeSecondSave.length);
      expect(beforeSecondSave.length).toBe(1);

      const highlights2 = await collection2.create({
        _meta_type: 'Issue533Highlights',
        title: 'Nov 13 Meeting Highlights',
        body: 'More key points...',
        meetingId: 'meeting-nov-13',
        highlights: ['Point A', 'Point B'],
      } as any);

      const afterSecondSave = await collection2.list({});
      console.log('[DEBUG] STI after second save:', afterSecondSave.length);
      expect(afterSecondSave.length).toBe(2);

      // STEP 3: Restart, save a summary (different STI subclass)
      clearConnectionCache();

      const collection3 = await Issue533ContentCollection.create({
        persistence: persistenceConfig,
      });

      // Check both highlights are there
      const beforeThirdSave = await collection3.list({});
      console.log('[DEBUG] STI before third save:', beforeThirdSave.length);
      expect(beforeThirdSave.length).toBe(2);

      const summary = await collection3.create({
        _meta_type: 'Issue533Summary',
        title: 'Oct 30 Meeting Summary',
        body: 'Executive summary of the meeting...',
        meetingId: 'meeting-oct-30',
        wordCount: 500,
      } as any);

      const afterThirdSave = await collection3.list({});
      console.log('[DEBUG] STI after third save:', afterThirdSave.length);
      expect(afterThirdSave.length).toBe(3);

      // STEP 4: Final verification
      clearConnectionCache();

      const finalCollection = await Issue533ContentCollection.create({
        persistence: persistenceConfig,
      });

      const allContent = await finalCollection.list({});
      console.log('[DEBUG] STI final count:', allContent.length);
      expect(allContent.length).toBe(3);

      // Verify correct types
      const highlightsItems = allContent.filter(
        (c) => c instanceof Issue533Highlights,
      );
      const summaryItems = allContent.filter(
        (c) => c instanceof Issue533Summary,
      );
      expect(highlightsItems.length).toBe(2);
      expect(summaryItems.length).toBe(1);
    });
  });

  describe('Simultaneous collection instances (BUG REPRODUCTION)', () => {
    it('SMRT collections share connection via auto-dbid (protected from bug)', async () => {
      /**
       * This test verifies that SMRT core protects against the lost update bug
       * by automatically setting dbid based on URL, ensuring connection sharing.
       *
       * Note: SMRT core always sets dbid = `smrt:${url}`, overriding any custom
       * dbid passed by the caller. This ensures all collections using the same
       * data directory share the same in-memory DuckDB connection.
       */

      // Create first collection
      const collection1 = await Issue533DocumentCollection.create({
        persistence: {
          type: 'json',
          url: tempDir,
          writeStrategy: 'immediate',
          dbid: 'connection-1', // This gets overridden by SMRT to smrt:${tempDir}
        },
      });

      // Save doc 1
      await collection1.create({
        title: 'Doc from Connection 1 - First',
        content: 'Content 1',
        meetingId: 'meeting-1',
      });

      // Create second collection - SMRT will give it the same dbid
      const collection2 = await Issue533DocumentCollection.create({
        persistence: {
          type: 'json',
          url: tempDir,
          writeStrategy: 'immediate',
          dbid: 'connection-2', // This gets overridden to same smrt:${tempDir}
        },
      });

      // collection2 shares the connection, so it sees doc1
      const collection2Initial = await collection2.list({});
      expect(collection2Initial.length).toBe(1);

      // Save doc 2 via collection 1
      await collection1.create({
        title: 'Doc from Connection 1 - Second',
        content: 'Content 2',
        meetingId: 'meeting-2',
      });

      // Save doc 3 via collection 2
      await collection2.create({
        title: 'Doc from Connection 2',
        content: 'Content 3',
        meetingId: 'meeting-3',
      });

      // All 3 docs should be preserved because they share the connection
      const jsonFiles = findJSONFiles(tempDir);
      const docsFile = jsonFiles.find(
        (f) => f.includes('issue533') || f.includes('document'),
      );
      const jsonContent = readJSONFile(tempDir, docsFile!);
      expect(jsonContent.length).toBe(3);
    });

    it('DIRECT DATABASE: Lost update bug with separate connections', async () => {
      /**
       * This test bypasses SMRT and directly uses getDatabase to create
       * separate in-memory DuckDB connections. This reproduces the actual
       * lost update bug that occurs when connection caching fails.
       */
      const { getDatabase } = await import('@happyvertical/sql');

      // Table schema for our test
      const schema = {
        ddl: `CREATE TABLE IF NOT EXISTS "test_docs" (
          "id" TEXT PRIMARY KEY,
          "title" TEXT,
          "content" TEXT
        )`,
        indexes: [],
      };

      // Create first connection (NO dbid = no caching when schemas provided)
      const db1 = await getDatabase({
        type: 'json',
        url: tempDir,
        writeStrategy: 'immediate',
        schemas: { test_docs: schema },
        // NO dbid = bypasses caching
      });

      // Create table and insert doc 1
      await db1.execute`CREATE TABLE IF NOT EXISTS test_docs (id TEXT PRIMARY KEY, title TEXT, content TEXT)`;
      await db1.upsert('test_docs', ['id'], {
        id: 'doc-1',
        title: 'Doc 1 from Connection 1',
        content: 'Content 1',
      });

      console.log(
        '[DIRECT DB] After doc1, JSON file:',
        readJSONFile(tempDir, 'test_docs.json').length,
        'records',
      );

      // Create second connection - should load doc1 from JSON
      const db2 = await getDatabase({
        type: 'json',
        url: tempDir,
        writeStrategy: 'immediate',
        schemas: { test_docs: schema },
        // NO dbid = bypasses caching, gets NEW connection
      });

      // Verify db2 loaded doc1
      const db2Initial = await db2.list('test_docs', {});
      console.log('[DIRECT DB] db2 loaded:', db2Initial.length, 'records');
      expect(db2Initial.length).toBe(1);

      // Save doc 2 via db1
      await db1.upsert('test_docs', ['id'], {
        id: 'doc-2',
        title: 'Doc 2 from Connection 1',
        content: 'Content 2',
      });

      console.log(
        '[DIRECT DB] After doc2, JSON file:',
        readJSONFile(tempDir, 'test_docs.json').length,
        'records',
      );
      expect(readJSONFile(tempDir, 'test_docs.json').length).toBe(2);

      // Save doc 3 via db2
      // BUG: db2's in-memory DuckDB only has doc1, NOT doc2!
      // When db2 exports, it will overwrite JSON with only doc1 + doc3
      await db2.upsert('test_docs', ['id'], {
        id: 'doc-3',
        title: 'Doc 3 from Connection 2',
        content: 'Content 3',
      });

      // Check final JSON file
      const finalContent = readJSONFile(tempDir, 'test_docs.json');
      console.log('[DIRECT DB] Final JSON:', finalContent.length, 'records');
      console.log(
        '[DIRECT DB] Titles:',
        finalContent.map((r: any) => r.title),
      );

      // This assertion will FAIL if the bug exists
      // Expected: 3 records
      // Actual (with bug): 2 records (doc1, doc3) - doc2 is LOST!
      expect(finalContent.length).toBe(3);
      expect(finalContent.map((r: any) => r.title)).toEqual(
        expect.arrayContaining([
          'Doc 1 from Connection 1',
          'Doc 2 from Connection 1',
          'Doc 3 from Connection 2',
        ]),
      );
    });
  });

  describe('Rapid sequential saves', () => {
    it('should not lose records with rapid sequential saves', async () => {
      const collection = await Issue533DocumentCollection.create({
        persistence: {
          type: 'json',
          url: tempDir,
          writeStrategy: 'immediate',
        },
      });

      // Save 10 documents in rapid succession (no awaiting between creates)
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(
          collection.create({
            title: `Rapid Doc ${i}`,
            content: `Content ${i}`,
            meetingId: `meeting-${i}`,
          }),
        );
      }

      // Wait for all to complete
      await Promise.all(promises);

      // Verify all 10 are persisted
      const allDocs = await collection.list({});
      console.log('[DEBUG] Rapid saves - docs in collection:', allDocs.length);
      expect(allDocs.length).toBe(10);

      // Verify JSON file
      const jsonFiles = findJSONFiles(tempDir);
      console.log('[DEBUG] Rapid saves - JSON files:', jsonFiles);
      const docsFile = jsonFiles.find(
        (f) =>
          f.includes('issue533') ||
          f.includes('document') ||
          f.includes('Issue533'),
      );
      expect(docsFile).toBeDefined();

      const jsonContent = readJSONFile(tempDir, docsFile!);
      console.log(
        '[DEBUG] Rapid saves - JSON record count:',
        jsonContent.length,
      );
      expect(jsonContent.length).toBe(10);
    });

    it('should handle concurrent saves from different instances', async () => {
      // Create two collection instances pointing to same data
      const collection1 = await Issue533DocumentCollection.create({
        persistence: {
          type: 'json',
          url: tempDir,
          writeStrategy: 'immediate',
          dbid: 'shared-db', // Force shared connection
        },
      });

      const collection2 = await Issue533DocumentCollection.create({
        persistence: {
          type: 'json',
          url: tempDir,
          writeStrategy: 'immediate',
          dbid: 'shared-db', // Force shared connection
        },
      });

      // Save from both instances concurrently
      const [doc1, doc2] = await Promise.all([
        collection1.create({
          title: 'From Instance 1',
          content: 'Content 1',
          meetingId: 'meeting-1',
        }),
        collection2.create({
          title: 'From Instance 2',
          content: 'Content 2',
          meetingId: 'meeting-2',
        }),
      ]);

      // Verify both are persisted
      const allDocs = await collection1.list({});
      console.log('[DEBUG] Concurrent saves - docs count:', allDocs.length);
      expect(allDocs.length).toBe(2);
    });
  });
});
