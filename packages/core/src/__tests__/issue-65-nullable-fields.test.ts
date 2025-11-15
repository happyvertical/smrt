/**
 * Test for issue #65: Nullable number fields not persisted to database schema
 * https://github.com/happyvertical/smrt/issues/65
 *
 * Fixed by issues #128, #69: Runtime fallback removed, Field helpers required
 */

import { describe, expect, it } from 'vitest';
import { field } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { SchemaGenerator } from '../schema/generator';

// Define test class at top level so AST scanner can find it
@smrt({ api: true, mcp: true, cli: true })
class Place extends SmrtObject {
  @field({ nullable: true })
  latitude: number = 0.0;

  @field({ nullable: true })
  longitude: number = 0.0;

  name: string = '';
}

describe('Issue #65: Nullable number fields', () => {
  it('should detect nullable number fields in ObjectRegistry', () => {
    // Force registration
    new Place({ _skipLoad: true });

    const fields = ObjectRegistry.getFields('Place');

    // Nullable number fields should be registered
    expect(fields.has('latitude')).toBe(true);
    expect(fields.has('longitude')).toBe(true);

    // Should have correct types
    const latField = fields.get('latitude');
    const lonField = fields.get('longitude');

    expect(latField).toBeDefined();
    expect(lonField).toBeDefined();
  });

  it('should include nullable number fields in generated schema', () => {
    // Force registration
    new Place({ _skipLoad: true });

    const fields = ObjectRegistry.getFields('Place');
    const generator = new SchemaGenerator();

    const schema = generator.generateSchemaFromRegistry(
      'Place',
      'places',
      fields,
    );

    // Nullable number fields should be in schema
    expect(schema.columns.latitude).toBeDefined();
    expect(schema.columns.longitude).toBeDefined();

    // Should be REAL type (for decimal/number)
    expect(schema.columns.latitude?.type).toBe('REAL');
    expect(schema.columns.longitude?.type).toBe('REAL');
  });

  it('should generate SQL with latitude/longitude columns', () => {
    // Force registration
    new Place({ _skipLoad: true });

    const fields = ObjectRegistry.getFields('Place');
    const generator = new SchemaGenerator();

    const schema = generator.generateSchemaFromRegistry(
      'Place',
      'places',
      fields,
    );

    const sql = generator.generateSQL(schema);

    // SQL should include latitude and longitude columns
    expect(sql).toContain('latitude');
    expect(sql).toContain('longitude');
    expect(sql).toContain('REAL'); // Number fields map to REAL
  });
});
