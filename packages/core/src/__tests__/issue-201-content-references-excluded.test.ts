/**
 * Verification test for Issue #201: Content.references field excluded from schema
 *
 * The Content class in smrt-content has a protected `references: Content[] = []` field.
 * This test verifies that it is NOT added to the database schema.
 */

import { describe, expect, it } from 'vitest';
import { SmrtObject, smrt } from '../index';
import { generateSchema } from '../schema/utils';

// Mock Content class structure from @happyvertical/smrt-content
@smrt()
class ContentMock extends SmrtObject {
  /**
   * Array of referenced content objects
   * This should NOT be in the schema (protected)
   */
  protected references: ContentMock[] = [];

  /**
   * Content type classification (public - should be in schema)
   */
  public type: string | null = null;

  /**
   * Content title (public - should be in schema)
   */
  public title: string = '';

  /**
   * Content body (public - should be in schema)
   */
  public body: string = '';
}

describe('Issue #201: Content.references field excluded from schema', () => {
  it('should not include protected references field in Content schema', async () => {
    const schema = await generateSchema(ContentMock);

    // The protected references field should NOT be in schema
    expect(schema).not.toContain('references');
    expect(schema).not.toContain('REFERENCES'); // Also check uppercase (SQL keyword)
  });

  it('should include public Content fields in schema', async () => {
    const schema = await generateSchema(ContentMock);

    // Public fields should be in schema
    expect(schema).toContain('type');
    expect(schema).toContain('title');
    expect(schema).toContain('body');
  });

  it('should generate valid DuckDB schema without references column', async () => {
    const schema = await generateSchema(ContentMock);

    // Extract column names
    const createTableStmt = `${schema.split('\n).')[0]}\\n);`;
    const columnLines = createTableStmt
      .split('\n')
      .filter(
        (line) =>
          line.trim() && !line.includes('CREATE TABLE') && !line.includes(');'),
      )
      .map((line) =>
        line.trim().split(' ')[0].replace(',', '').replace(/"/g, ''),
      );

    // Should not have references column
    expect(columnLines).not.toContain('references');

    // Should have public columns
    expect(columnLines).toContain('type');
    expect(columnLines).toContain('title');
    expect(columnLines).toContain('body');
  });
});
