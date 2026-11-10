/**
 * Test for Issue #3723: `getCollection()` before `registerCollection()` cached
 * a generic default collection, and the registered class never replaced it.
 */

import { describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';

@smrt()
class Issue3723Widget extends SmrtObject {
  label: string = '';
}

class Issue3723WidgetCollection extends SmrtCollection<Issue3723Widget> {
  static readonly _itemClass = Issue3723Widget;

  marker(): string {
    return 'own-collection';
  }
}

describe('Issue #3723: registerCollection replaces a cached default', () => {
  it('returns the registered collection after a generic one was cached', async () => {
    const options = { db: { type: 'sqlite' as const, url: ':memory:' } };

    const generic = await ObjectRegistry.getCollection(
      'Issue3723Widget',
      options,
    );
    expect(generic).not.toBeInstanceOf(Issue3723WidgetCollection);

    ObjectRegistry.registerCollection(
      'Issue3723Widget',
      Issue3723WidgetCollection,
    );

    const own = await ObjectRegistry.getCollection('Issue3723Widget', options);
    expect(own).toBeInstanceOf(Issue3723WidgetCollection);
    expect((own as Issue3723WidgetCollection).marker()).toBe('own-collection');

    // Re-registering the same class keeps the cached instance.
    ObjectRegistry.registerCollection(
      'Issue3723Widget',
      Issue3723WidgetCollection,
    );
    expect(await ObjectRegistry.getCollection('Issue3723Widget', options)).toBe(
      own,
    );
  });
});
