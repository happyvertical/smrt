import { generateSchema } from '@happyvertical/smrt-core/schema/utils';
import { fieldsFromClass } from '@happyvertical/smrt-core/utils';
import { describe, expect, it } from 'vitest';
import { Place } from './Place';

describe('Place coordinate schema', () => {
  it('preserves REAL sqlType metadata for coordinates', async () => {
    const fields = await fieldsFromClass(Place);

    expect(fields.latitude?._meta?.sqlType).toBe('REAL');
    expect(fields.longitude?._meta?.sqlType).toBe('REAL');
  });

  it('generates REAL columns for latitude and longitude', async () => {
    const schema = await generateSchema(Place);

    expect(schema).toContain('"latitude" REAL');
    expect(schema).toContain('"longitude" REAL');
  });
});
