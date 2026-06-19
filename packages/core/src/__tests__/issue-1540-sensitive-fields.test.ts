/**
 * Test for issue #1540 (increment 2a): `@field({ sensitive: true })`
 * https://github.com/happyvertical/smrt/issues/1540
 *
 * A sensitive field:
 * - IS still persisted to the database (so secrets round-trip), and remains in
 *   `toJSON()` (the persistence serializer);
 * - is EXCLUDED from `toPublicJSON()` (the serializer used by generated
 *   REST/MCP/SvelteKit routes); and
 * - is REJECTED as a `where` filter key, closing the value-probing oracle.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { field } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

// Unique class name to avoid AST-scanner collisions (issue #543).
@smrt({ api: { include: ['list', 'get', 'create', 'update'] } })
class SensitiveFieldWidget extends SmrtObject {
  @field({ type: 'text' })
  label: string = '';

  @field({ type: 'text', sensitive: true })
  apiSecret: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.label !== undefined) this.label = options.label;
    if (options.apiSecret !== undefined) this.apiSecret = options.apiSecret;
  }
}

class SensitiveFieldWidgetCollection extends SmrtCollection<SensitiveFieldWidget> {
  static readonly _itemClass = SensitiveFieldWidget;
}

describe('Issue #1540: sensitive field handling', () => {
  ObjectRegistry.registerCollection(
    'SensitiveFieldWidget',
    SensitiveFieldWidgetCollection,
  );

  let collection: SensitiveFieldWidgetCollection;
  let db: DatabaseInterface;

  beforeAll(async () => {
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['SensitiveFieldWidget'],
    });
    collection = await SensitiveFieldWidgetCollection.create({ db });

    const widget = await collection.create({
      label: 'primary',
      apiSecret: 'sk-super-secret-value',
    });
    await widget.save();
  });

  afterAll(async () => {
    await db?.close?.();
  });

  it('keeps the sensitive value in toJSON() so it is still persisted', () => {
    const widget = new SensitiveFieldWidget({
      label: 'x',
      apiSecret: 'sk-keep-me',
    });
    const json = widget.toJSON() as Record<string, unknown>;
    expect(json.label).toBe('x');
    expect(json.apiSecret).toBe('sk-keep-me');
  });

  it('excludes the sensitive value from toPublicJSON()', () => {
    const widget = new SensitiveFieldWidget({
      label: 'x',
      apiSecret: 'sk-hide-me',
    });
    const publicJson = widget.toPublicJSON();
    expect(publicJson.label).toBe('x');
    expect('apiSecret' in publicJson).toBe(false);
  });

  it('round-trips the sensitive value through the database', async () => {
    const loaded = await collection.list({ where: { label: 'primary' } });
    expect(loaded).toHaveLength(1);
    expect(loaded[0].apiSecret).toBe('sk-super-secret-value');
    // ...but the public serialization still omits it.
    expect('apiSecret' in loaded[0].toPublicJSON()).toBe(false);
  });

  it('rejects a where filter that targets a sensitive field', async () => {
    await expect(
      collection.list({ where: { apiSecret: 'sk-super-secret-value' } }),
    ).rejects.toThrow(/sensitive/i);
  });

  it('rejects a sensitive-field where filter even with a like operator', async () => {
    await expect(
      collection.list({ where: { 'apiSecret like': 'sk-%' } }),
    ).rejects.toThrow(/sensitive/i);
  });
});
