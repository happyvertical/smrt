import {
  fieldsFromClass,
  generateSchema,
} from '@happyvertical/smrt-core/utils';
import { describe, expect, it } from 'vitest';
import { PlaceType } from './PlaceType';

describe('PlaceType Schema Generation', () => {
  it('should include name field in extracted fields', () => {
    const fields = fieldsFromClass(PlaceType);

    // Verify name field is extracted
    expect(fields).toHaveProperty('name');
    expect(fields.name).toEqual({
      name: 'name',
      type: 'text',
    });
  });

  it('should include name column in generated schema', () => {
    const schema = generateSchema(PlaceType);

    // Verify schema includes name column (with quoted column names)
    expect(schema).toContain('"name" TEXT NOT NULL');

    // Full schema check
    expect(schema).toMatch(/CREATE TABLE IF NOT EXISTS "place_types"/);
    expect(schema).toMatch(/"name" TEXT NOT NULL/);
  });

  it('should allow creating PlaceType with name', () => {
    const placeType = new PlaceType({
      slug: 'town',
      name: 'Town',
      description: 'A town or small city',
    });

    // Verify name field can be set and accessed
    // This would fail with "table place_types has no column named name" in database operations
    expect(placeType.name).toBeTruthy();
    expect(placeType.description).toBe('A town or small city');
  });
});
