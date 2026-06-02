/**
 * Test for Issue #198: JSON adapter generates DuckDB-incompatible SQL (DATETIME function)
 *
 * Verifies that schema generation uses DuckDB-compatible types and functions:
 * - TIMESTAMP instead of DATETIME type
 * - current_timestamp instead of datetime('now') function
 *
 * This test follows BDD/TDD approach - tests the fix before implementation.
 */

import { describe, expect, it } from 'vitest';
import { field, SmrtObject, smrt } from '../index';
import { generateSchema } from '../schema/utils';

@smrt()
class TestContent extends SmrtObject {
  @field({ required: true })
  title: string = '';

  publishDate: Date = new Date();
  lastSyncedAt: Date = new Date();
}

describe('Issue #198: DuckDB DATETIME Compatibility', () => {
  it('should use TIMESTAMP type instead of DATETIME for DuckDB compatibility', async () => {
    const schema = await generateSchema(TestContent);

    // DuckDB requires TIMESTAMP, not DATETIME
    expect(schema).toContain('TIMESTAMP');
    expect(schema).not.toContain('DATETIME');
  });

  it('should use current_timestamp instead of datetime() function', async () => {
    const schema = await generateSchema(TestContent);

    // DuckDB requires current_timestamp, not datetime('now')
    expect(schema).toContain('current_timestamp');
    expect(schema).not.toMatch(/datetime\(/);
  });

  it('should generate valid DuckDB schema for created_at column', async () => {
    const schema = await generateSchema(TestContent);

    // Check created_at uses TIMESTAMP and current_timestamp
    expect(schema).toMatch(/"created_at"\s+TIMESTAMP/);
    expect(schema).toMatch(/DEFAULT\s+current_timestamp/);
  });

  it('should generate valid DuckDB schema for updated_at column', async () => {
    const schema = await generateSchema(TestContent);

    // Check updated_at uses TIMESTAMP and current_timestamp
    expect(schema).toMatch(/"updated_at"\s+TIMESTAMP/);
    expect(schema).toMatch(/DEFAULT\s+current_timestamp/);
  });

  it('should generate valid DuckDB schema for custom datetime fields', async () => {
    const schema = await generateSchema(TestContent);

    // Custom datetime fields should also use TIMESTAMP
    expect(schema).toMatch(/"publish_date"\s+TIMESTAMP/);
    expect(schema).toMatch(/"last_synced_at"\s+TIMESTAMP/);
  });

  it('should use current_timestamp in trigger body', async () => {
    const schema = await generateSchema(TestContent);

    // Triggers should use current_timestamp, not datetime('now')
    if (schema.includes('CREATE TRIGGER')) {
      expect(schema).toMatch(/SET\s+"updated_at"\s+=\s+current_timestamp/);
      expect(schema).not.toMatch(/datetime\(['"]now['"]\)/);
    }
  });

  it('should generate schema that works with all databases (SQLite, Postgres, DuckDB)', async () => {
    const schema = await generateSchema(TestContent);

    // TIMESTAMP and current_timestamp are SQL standard
    // They work in SQLite, Postgres, and DuckDB

    // Verify schema structure
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS');
    expect(schema).toContain('"id" UUID PRIMARY KEY');
    expect(schema).toContain(
      '"created_at" TIMESTAMP NOT NULL DEFAULT current_timestamp',
    );
    expect(schema).toContain(
      '"updated_at" TIMESTAMP NOT NULL DEFAULT current_timestamp',
    );

    // Verify no database-specific syntax
    expect(schema).not.toContain('DATETIME'); // SQLite-specific
    expect(schema).not.toMatch(/datetime\(/); // SQLite function
  });

  it('should format datetime default values correctly', async () => {
    const schema = await generateSchema(TestContent);

    // All datetime defaults should use current_timestamp
    const datetimeDefaultMatches = schema.match(/DEFAULT\s+\w+/g) || [];
    const hasDatetimeDefaults = datetimeDefaultMatches.length > 0;

    if (hasDatetimeDefaults) {
      // No datetime('now') should exist
      expect(schema).not.toMatch(/datetime\(['"]now['"]\)/);

      // current_timestamp should be used for datetime columns
      expect(schema).toMatch(/TIMESTAMP.*DEFAULT\s+current_timestamp/);
    }
  });
});
