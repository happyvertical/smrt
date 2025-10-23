/**
 * Test for issue #65: Nullable number fields not persisted to database schema
 * https://github.com/happyvertical/smrt/issues/65
 */

import { describe, expect, it } from 'vitest';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { SchemaGenerator } from '../schema/generator';

describe('Issue #65: Nullable number fields', () => {
  @smrt({ api: true, mcp: true, cli: true })
  class Place extends SmrtObject {
    latitude: number | null = null;
    longitude: number | null = null;
    name = '';
  }

  it('should detect nullable number fields in ObjectRegistry', () => {
    // Force registration
    new Place({ _skipLoad: true });

    const fields = ObjectRegistry.getFields('Place');

    console.log('Registered fields:', Array.from(fields.keys()));
    console.log('latitude field:', fields.get('latitude'));
    console.log('longitude field:', fields.get('longitude'));

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

    console.log('Generated schema columns:', Object.keys(schema.columns));
    console.log('latitude column:', schema.columns.latitude);
    console.log('longitude column:', schema.columns.longitude);

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

    console.log('Generated SQL:');
    console.log(sql);

    // SQL should include latitude and longitude columns
    expect(sql).toContain('latitude');
    expect(sql).toContain('longitude');
    expect(sql).toContain('REAL'); // Number fields map to REAL
  });
});
