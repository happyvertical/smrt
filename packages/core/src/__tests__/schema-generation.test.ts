/**
 * Test for Issue #144: Schema generation duplicates created_at and updated_at columns
 *
 * Verifies that generateSchema() produces valid SQL without duplicate columns.
 */

import { describe, expect, it } from 'vitest';
import { SmrtObject, smrt, text } from '../index';
import { generateSchema } from '../schema/utils';
import { tableNameFromClass } from '../utils';

// Move to top level to avoid collision with TestEvent in issue-144-integration.test.ts
@smrt()
class SchemaGenTestEvent extends SmrtObject {
  title = text({ required: true });
  description = text();
  startDate = text();
}

// Move to top level to avoid collision with Article in cli-module.test.ts
@smrt()
class SchemaGenArticle extends SmrtObject {
  title = text({ required: true });
  body = text();
}

// Move to module level so AST scanner can pick it up during test manifest generation
@smrt()
class CustomTimestamps extends SmrtObject {
  name = text();
  // Explicitly defining timestamp fields (should still not duplicate)
  created_at = new Date();
  updated_at = new Date();
}

describe('Issue #144: Schema Generation Duplicate Columns', () => {
  it('should not duplicate created_at column in schema', async () => {
    const schema = await generateSchema(SchemaGenTestEvent);

    // Count occurrences of 'created_at' in the schema
    const matches = schema.match(/created_at/g) || [];

    expect(matches.length).toBe(1); // Should appear exactly once
  });

  it('should not duplicate updated_at column in schema', async () => {
    const schema = await generateSchema(SchemaGenTestEvent);

    // Count occurrences of 'updated_at' in the schema
    const matches = schema.match(/updated_at/g) || [];

    expect(matches.length).toBe(1); // Should appear exactly once
  });

  it('should include timestamp columns for trigger support', async () => {
    const schema = await generateSchema(SchemaGenTestEvent);

    // Verify both timestamp columns exist (with quoted column names)
    expect(schema).toContain('"created_at" DATETIME');
    expect(schema).toContain('"updated_at" DATETIME');
  });

  it('should generate valid SQL without duplicate column errors', async () => {
    const schema = await generateSchema(SchemaGenTestEvent);

    // Extract the CREATE TABLE statement (before indexes)
    const createTableStmt = `${schema.split('\n).')[0]}\n);`;

    // Parse column names from the CREATE TABLE statement
    const columnLines = createTableStmt
      .split('\n')
      .filter(
        (line) =>
          line.trim() && !line.includes('CREATE TABLE') && !line.includes(');'),
      )
      .map((line) => line.trim().split(' ')[0].replace(',', ''));

    // Check for duplicate column names
    const columnCounts = new Map<string, number>();
    for (const col of columnLines) {
      if (col && !col.includes('UNIQUE')) {
        // Skip UNIQUE constraint line
        columnCounts.set(col, (columnCounts.get(col) || 0) + 1);
      }
    }

    // Verify no duplicates
    for (const [col, count] of columnCounts.entries()) {
      expect(count).toBe(1); // Each column should appear exactly once
    }
  });

  it('should match expected schema structure', async () => {
    const schema = await generateSchema(SchemaGenTestEvent);
    const tableName = tableNameFromClass(SchemaGenTestEvent);

    // Expected schema should have this structure:
    // - CREATE TABLE statement
    // - id, slug, context (base fields)
    // - title, description, start_date (custom fields)
    // - created_at, updated_at (timestamp fields - EXACTLY ONCE)
    // - UNIQUE constraint
    // - CREATE INDEX statements

    expect(schema).toContain(`CREATE TABLE IF NOT EXISTS "${tableName}"`);
    expect(schema).toContain('"id" TEXT PRIMARY KEY');
    expect(schema).toContain('"slug" TEXT NOT NULL');
    expect(schema).toContain('"context" TEXT NOT NULL');
    expect(schema).toContain('"title" TEXT NOT NULL'); // required: true
    expect(schema).toContain('"description" TEXT');
    expect(schema).toContain('"start_date" TEXT');
    expect(schema).toContain('"created_at" DATETIME');
    expect(schema).toContain('"updated_at" DATETIME');
    // The new SchemaGenerator creates a UNIQUE INDEX instead of table constraint
    expect(schema).toContain('UNIQUE INDEX');
  });

  it('should handle classes with explicit timestamp field definitions', async () => {
    const schema = await generateSchema(CustomTimestamps);

    // Even with explicit definitions, should only appear once
    const createdMatches = schema.match(/created_at/g) || [];
    const updatedMatches = schema.match(/updated_at/g) || [];

    expect(createdMatches.length).toBe(1);
    expect(updatedMatches.length).toBe(1);
  });

  it('should work correctly with inherited base class fields', async () => {
    const schema = await generateSchema(SchemaGenArticle);

    // Verify all base SmrtObject fields are included (with quoted column names)
    expect(schema).toContain('"id" TEXT PRIMARY KEY');
    expect(schema).toContain('"slug" TEXT NOT NULL');
    expect(schema).toContain('"context" TEXT NOT NULL');
    expect(schema).toContain('"created_at" DATETIME');
    expect(schema).toContain('"updated_at" DATETIME');

    // Verify custom fields (with quoted column names)
    expect(schema).toContain('"title" TEXT NOT NULL');
    expect(schema).toContain('"body" TEXT');

    // Verify no duplicates
    const createdMatches = schema.match(/created_at/g) || [];
    const updatedMatches = schema.match(/updated_at/g) || [];
    expect(createdMatches.length).toBe(1);
    expect(updatedMatches.length).toBe(1);
  });
});
