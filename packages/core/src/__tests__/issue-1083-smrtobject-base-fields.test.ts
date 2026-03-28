import { describe, expect, it } from 'vitest';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';

@smrt()
class Issue1083Document extends SmrtObject {
  title: string = '';
}

@smrt()
class Issue1083Article extends Issue1083Document {
  body: string = '';
}

describe('Issue #1083: SmrtObject base fields in getAllFields()', () => {
  it('should include SmrtObject system fields for direct descendants', async () => {
    const fields = await ObjectRegistry.getAllFields('Issue1083Document');

    expect(fields.has('id')).toBe(true);
    expect(fields.has('slug')).toBe(true);
    expect(fields.has('context')).toBe(true);
    expect(fields.has('created_at')).toBe(true);
    expect(fields.has('updated_at')).toBe(true);
    expect(fields.has('title')).toBe(true);
  });

  it('should preserve SmrtObject system fields for deeper descendants', async () => {
    const fields = await ObjectRegistry.getAllFields('Issue1083Article');

    expect(fields.has('id')).toBe(true);
    expect(fields.has('slug')).toBe(true);
    expect(fields.has('context')).toBe(true);
    expect(fields.has('created_at')).toBe(true);
    expect(fields.has('updated_at')).toBe(true);
    expect(fields.has('title')).toBe(true);
    expect(fields.has('body')).toBe(true);
  });
});
