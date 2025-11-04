/**
 * Test for Issue #208: Optional TEXT fields with field helpers bypass toJSON() fix
 *
 * This tests the specific case from issue #208 where fields declared as:
 * description? = text();
 *
 * are still passing undefined to the database even after the toJSON() fix.
 *
 * Issue #208 specifically mentions using DuckDB via JSON adapter, so we test both.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { text } from '../fields';
import { SmrtObject } from '../object';
import { smrt } from '../registry';

// Define test class at module level for AST scanner
@smrt({ tableName: 'councils_issue_208' })
class CouncilIssue208 extends SmrtObject {
  name = text({ required: true });
  description? = text(); // Optional field helper - the problematic case
}

class CouncilIssue208Collection extends SmrtCollection<CouncilIssue208> {
  static readonly _itemClass = CouncilIssue208;
}

describe('Issue #208: Optional TEXT field helpers with undefined values', () => {
  describe('with JSON database (as reported in issue)', () => {
    let db: DatabaseInterface;
    let dataDir: string;

    beforeEach(async () => {
      // Create unique temp directory for JSON database
      dataDir = join(
        tmpdir(),
        `test-issue-208-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      db = await getDatabase({
        type: 'json',
        url: dataDir,
        dataDir: dataDir,
        writeStrategy: 'immediate',
      });
    });

    it('should handle field helper with optional ? syntax when undefined', async () => {
      const collection = await CouncilIssue208Collection.create({ db });

      // Create without description - this is the failing case from #208
      const council = await collection.create({
        name: 'Test Council',
        // description not provided
      });

      // This should not throw "Cannot create values of type ANY"
      await council.save();

      expect(council.id).toBeDefined();
      expect(council.name).toBe('Test Council');
    });

    it('should convert undefined to empty string in toJSON()', async () => {
      const collection = await CouncilIssue208Collection.create({ db });

      const council = await collection.create({
        name: 'Test Council',
      });

      const json = council.toJSON();

      // The fix should convert undefined TEXT fields to empty strings
      expect(json.description).toBe('');
    });

    it('should handle getOrUpsert with undefined optional fields', async () => {
      const collection = await CouncilIssue208Collection.create({ db });

      // This is the exact pattern from the issue report
      const council = await collection.getOrUpsert({ name: 'test-council' });

      // This should not throw "Cannot create values of type ANY"
      await council.save();

      expect(council.id).toBeDefined();
      expect(council.name).toBe('test-council');
    });
  });

  describe('with SQLite database', () => {
    let db: DatabaseInterface;

    beforeEach(async () => {
      db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    });

    it('should handle field helper with optional ? syntax when undefined', async () => {
      const collection = await CouncilIssue208Collection.create({ db });

      const council = await collection.create({
        name: 'Test Council',
      });

      await council.save();

      expect(council.id).toBeDefined();
      expect(council.name).toBe('Test Council');
    });

    it('should show field type from getFields()', async () => {
      const collection = await CouncilIssue208Collection.create({ db });

      const council = await collection.create({
        name: 'Test Council',
      });

      const fields = council.getFields();

      expect(fields.description).toBeDefined();
      expect(fields.description.type).toBe('text');
      expect(fields.description.value).toBeUndefined();
    });
  });

  describe('with DuckDB database', () => {
    let db: DatabaseInterface;
    let dbPath: string;

    beforeEach(async () => {
      dbPath = join(tmpdir(), `test-issue-208-duckdb-${Date.now()}.db`);
      db = await getDatabase({ type: 'duckdb', url: dbPath });
    });

    it('should handle field helper with optional ? syntax when undefined (DuckDB)', async () => {
      const collection = await CouncilIssue208Collection.create({ db });

      const council = await collection.create({
        name: 'Test Council',
      });

      // This is where the issue #208 error occurs with DuckDB
      await council.save();

      expect(council.id).toBeDefined();
      expect(council.name).toBe('Test Council');
    });

    it('should handle getOrUpsert with DuckDB', async () => {
      const collection = await CouncilIssue208Collection.create({ db });

      const council = await collection.getOrUpsert({ name: 'test-council' });
      await council.save();

      expect(council.id).toBeDefined();
      expect(council.name).toBe('test-council');
    });
  });
});
