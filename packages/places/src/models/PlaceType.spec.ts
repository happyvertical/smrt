import { generateSchema } from '@happyvertical/smrt-core/schema/utils';
import { fieldsFromClass } from '@happyvertical/smrt-core/utils';
import { describe, expect, it } from 'vitest';
import { PlaceType } from './PlaceType';

describe('PlaceType Schema Generation', () => {
  it('should include name field in extracted fields', async () => {
    const fields = await fieldsFromClass(PlaceType);

    // Verify name field is extracted
    expect(fields).toHaveProperty('name');
    expect(fields.name.name).toBe('name');
    expect(fields.name.type).toBe('text');
    expect(fields.name.options).toBeDefined();
    expect(fields.name.options.required).toBe(true);
  });

  it('should include name column in generated schema', async () => {
    const schema = await generateSchema(PlaceType);

    // With STI, fields are nullable in schema (validation at app level)
    expect(schema).toContain('"name" TEXT');

    // Full schema check - STI includes _meta_type discriminator
    expect(schema).toMatch(/CREATE TABLE IF NOT EXISTS "place_types"/);
    expect(schema).toMatch(/"_meta_type" TEXT NOT NULL/);
    expect(schema).toMatch(/"name" TEXT/);
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
