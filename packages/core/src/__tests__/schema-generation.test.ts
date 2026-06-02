/**
 * Test for Issue #144: Schema generation duplicates created_at and updated_at columns
 *
 * Verifies that generateSchema() produces valid SQL without duplicate columns.
 */

import { describe, expect, it } from 'vitest';
import { field, SmrtObject, smrt } from '../index';
import { ObjectRegistry } from '../registry';
import { generateSchema } from '../schema/utils';
import { tableNameFromClass } from '../utils';

// Move to top level to avoid collision with TestEvent in issue-144-integration.test.ts
@smrt()
class SchemaGenTestEvent extends SmrtObject {
  @field({ required: true })
  title: string = '';

  description: string = '';
  startDate: string = '';
}

// Move to top level to avoid collision with Article in cli-module.test.ts
@smrt()
class SchemaGenArticle extends SmrtObject {
  @field({ required: true })
  title: string = '';

  body: string = '';
}

@smrt()
class UniqueEmailRecord extends SmrtObject {
  @field({ unique: true })
  email: string = '';
}

@smrt({ conflictColumns: ['key'] })
class ConflictKeyRecord extends SmrtObject {
  @field({ required: true })
  key: string = '';

  label: string = '';
}

@smrt()
class CustomPrimaryKeyRecord extends SmrtObject {
  @field({ required: true, primaryKey: true })
  externalId: string = '';

  label: string = '';
}

// Move to module level so AST scanner can pick it up during test manifest generation
@smrt()
class CustomTimestamps extends SmrtObject {
  name: string = '';
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
    expect(schema).toContain('"created_at" TIMESTAMP');
    expect(schema).toContain('"updated_at" TIMESTAMP');
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
    expect(schema).toContain('"id" UUID PRIMARY KEY');
    expect(schema).toContain('"slug" TEXT NOT NULL');
    expect(schema).toContain('"context" TEXT NOT NULL');
    expect(schema).toContain('"title" TEXT NOT NULL'); // required: true
    expect(schema).toContain('"description" TEXT');
    expect(schema).toContain('"start_date" TEXT');
    expect(schema).toContain('"created_at" TIMESTAMP');
    expect(schema).toContain('"updated_at" TIMESTAMP');
    // NOTE: Since the SchemaManager refactor, generateSQL() returns only CREATE TABLE.
    // Indexes are stored separately in schema.indexes and handled by SchemaManager.
    // The DDL no longer includes UNIQUE INDEX statements.
    expect(schema).not.toContain('UNIQUE INDEX');
  });

  it('should render engine-specific DDL when requested', async () => {
    const schema = await generateSchema(SchemaGenTestEvent, undefined, {
      engine: 'sqlite',
    });

    expect(schema).toContain('"id" TEXT PRIMARY KEY');
    expect(schema).not.toContain('"id" UUID PRIMARY KEY');
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
    expect(schema).toContain('"id" UUID PRIMARY KEY');
    expect(schema).toContain('"slug" TEXT NOT NULL');
    expect(schema).toContain('"context" TEXT NOT NULL');
    expect(schema).toContain('"created_at" TIMESTAMP');
    expect(schema).toContain('"updated_at" TIMESTAMP');

    // Verify custom fields (with quoted column names)
    expect(schema).toContain('"title" TEXT NOT NULL');
    expect(schema).toContain('"body" TEXT');

    // Verify no duplicates
    const createdMatches = schema.match(/created_at/g) || [];
    const updatedMatches = schema.match(/updated_at/g) || [];
    expect(createdMatches.length).toBe(1);
    expect(updatedMatches.length).toBe(1);
  });

  it('should preserve field-level unique constraints in generated schema', async () => {
    const schema = await generateSchema(UniqueEmailRecord);

    expect(schema).toContain('"email" TEXT UNIQUE');
  });

  it('should honor runtime conflictColumns when generating CTI schema indexes', async () => {
    await generateSchema(ConflictKeyRecord);

    const registered = ObjectRegistry.getClass('ConflictKeyRecord');
    const uniqueIndexes =
      registered?.schema?.indexes.filter((index) => index.unique) || [];

    expect(uniqueIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          columns: ['key'],
        }),
      ]),
    );
    expect(
      uniqueIndexes.some(
        (index) =>
          index.columns.length === 2 &&
          index.columns[0] === 'slug' &&
          index.columns[1] === 'context',
      ),
    ).toBe(false);
  });

  it('should not add synthetic id, slug, or context columns for custom primary keys', async () => {
    const schema = await generateSchema(CustomPrimaryKeyRecord);

    expect(schema).toContain('"external_id" TEXT PRIMARY KEY');
    expect(schema).not.toContain('"id" UUID PRIMARY KEY');
    expect(schema).not.toContain('"slug" TEXT NOT NULL');
    expect(schema).not.toContain('"context" TEXT NOT NULL');
    expect(schema).toContain('"created_at" TIMESTAMP');
    expect(schema).toContain('"updated_at" TIMESTAMP');
  });
});
