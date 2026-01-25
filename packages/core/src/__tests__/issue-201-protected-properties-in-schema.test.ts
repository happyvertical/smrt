/**
 * Test for Issue #201: Protected and private properties should not be added to schema
 *
 * Verifies that the AST scanner excludes protected and private properties from schema generation.
 */

import { describe, expect, it } from 'vitest';
import { field, SmrtObject, smrt } from '../index';
import { generateSchema } from '../schema/utils';

@smrt()
class TestWithProtected extends SmrtObject {
  // Public property - should be in schema
  @field({ required: true })
  publicName: string = '';

  // Protected property - should NOT be in schema
  protected protectedData: string[] = [];

  // Public TypeScript type - should be in schema
  publicDescription: string = '';

  // Protected TypeScript type - should NOT be in schema
  protected protectedCount: number = 0;
}

describe('Issue #201: Protected and Private Properties in Schema', () => {
  it('should not include protected properties in schema', async () => {
    const schema = await generateSchema(TestWithProtected);

    // Protected property should NOT be in schema
    expect(schema).not.toContain('protected_data');
    expect(schema).not.toContain('protectedData');

    // Public property should be in schema
    expect(schema).toContain('public_name');
  });

  it('should not include private properties in schema', async () => {
    const schema = await generateSchema(TestWithProtected);

    // Private property should NOT be in schema
    expect(schema).not.toContain('private_secret');
    expect(schema).not.toContain('privateSecret');
  });

  it('should include public properties in schema', async () => {
    const schema = await generateSchema(TestWithProtected);

    // Public properties should be in schema
    expect(schema).toContain('public_name');
    expect(schema).toContain('public_description');
  });

  it('should not include protected TypeScript type properties in schema', async () => {
    const schema = await generateSchema(TestWithProtected);

    // Protected TypeScript type should NOT be in schema
    expect(schema).not.toContain('protected_count');
    expect(schema).not.toContain('protectedCount');
  });

  it('should generate valid SQL without protected/private properties', async () => {
    const schema = await generateSchema(TestWithProtected);

    // Extract the CREATE TABLE statement
    const createTableStmt = `${schema.split('\n).')[0]}\\n);`;

    // Parse column names from the CREATE TABLE statement
    const columnLines = createTableStmt
      .split('\n')
      .filter(
        (line) =>
          line.trim() && !line.includes('CREATE TABLE') && !line.includes(');'),
      )
      .map((line) => line.trim().split(' ')[0].replace(',', ''));

    // Get column names (remove quotes)
    const columnNames = columnLines
      .filter((col) => col && !col.includes('UNIQUE'))
      .map((col) => col.replace(/"/g, ''));

    // Should not include protected or private columns
    expect(columnNames).not.toContain('protected_data');
    expect(columnNames).not.toContain('protectedData');
    expect(columnNames).not.toContain('private_secret');
    expect(columnNames).not.toContain('privateSecret');
    expect(columnNames).not.toContain('protected_count');
    expect(columnNames).not.toContain('protectedCount');

    // Should include public columns
    expect(columnNames).toContain('public_name');
    expect(columnNames).toContain('public_description');
  });
});
