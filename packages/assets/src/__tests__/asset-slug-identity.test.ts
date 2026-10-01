/**
 * A file's name is not its identity. Two pictures uploaded or copied with the
 * same file name ("photo.jpg", "generated-content-image-001.jpg") are two
 * assets: the second save must not adopt the first row through the
 * name-derived slug natural key and overwrite its bytes/metadata.
 *
 * Real in-memory SQLite, no DB mocking.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../folder';
import { AssetCollection } from '../assets';

describe('asset identity is not its file name', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') await db.close();
  });

  it('keeps two same-named assets of one tenant apart', async () => {
    const assets = await AssetCollection.create({ db });
    const [first, second] = await withTenant(
      { tenantId: 'tenant-1' },
      async () => {
        const a = await assets.create({
          tenantId: 'tenant-1',
          name: 'photo.jpg',
          sourceUri: 'file://a.jpg',
          externalId: 'mam-a',
        });
        await a.save();
        const b = await assets.create({
          tenantId: 'tenant-1',
          name: 'photo.jpg',
          sourceUri: 'file://b.jpg',
          externalId: 'mam-b',
        });
        await b.save();
        return [a, b];
      },
    );

    expect(second.id).not.toBe(first.id);
    const reloaded = await withTenant({ tenantId: 'tenant-1' }, () =>
      assets.get({ id: first.id as string }),
    );
    expect(reloaded?.sourceUri).toBe('file://a.jpg');
    expect(reloaded?.externalId).toBe('mam-a');
  });

  it('still honours an explicit slug', async () => {
    const assets = await AssetCollection.create({ db });
    const asset = await assets.create({ name: 'photo.jpg', slug: 'hero' });
    await asset.save();
    expect(asset.slug).toBe('hero');
  });
});
