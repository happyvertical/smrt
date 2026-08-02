/**
 * Runtime channel for `@field({ ui })` hints (#2046, epic #2045).
 *
 * The authoring contract: `ui` rides the open decorator-option bag into the
 * field's `_meta` (both the manifest path and the runtime decorator path spread
 * options there), is readable via the PUBLIC `ObjectRegistry.getAllFields()` at
 * `field._meta.ui`, and is never promoted to a top-level field key.
 */

import { describe, expect, it } from 'vitest';
import { field } from '../decorators/index.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';

@smrt()
class UIHintQuote extends SmrtObject {
  @field({
    ui: { basic: true, group: 'identity', order: 1 },
    description: 'Customer-visible name',
  })
  name: string = '';

  @field({ ui: { locked: true } })
  taxClass: string = '';

  plain: string = '';
}

describe('@field({ ui }) runtime channel (#2046)', () => {
  it('exposes ui hints at field._meta.ui via ObjectRegistry.getAllFields()', async () => {
    // Reference the class so its decorators are guaranteed evaluated.
    expect(UIHintQuote.name).toBe('UIHintQuote');

    const fields = await ObjectRegistry.getAllFields('UIHintQuote');

    expect(fields.get('name')?._meta?.ui).toEqual({
      basic: true,
      group: 'identity',
      order: 1,
    });
    expect(fields.get('name')?._meta?.description).toBe(
      'Customer-visible name',
    );
    expect(fields.get('taxClass')?._meta?.ui).toEqual({ locked: true });
    expect(fields.get('plain')?._meta?.ui).toBeUndefined();
  });

  it('keeps ui out of the top-level field shape (pure _meta carrier)', async () => {
    const fields = await ObjectRegistry.getAllFields('UIHintQuote');
    expect(fields.get('name')).not.toHaveProperty('ui');
    expect(fields.get('taxClass')).not.toHaveProperty('ui');
  });
});
