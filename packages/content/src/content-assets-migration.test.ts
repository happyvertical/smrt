import { AssetCollection } from '@happyvertical/smrt-assets';
import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { syncSchema } from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import { backfillContentAssetsFromAssetAssociations } from './content-assets-migration';
import { Contents } from './contents';

const CONTENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS contents (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  _meta_type TEXT NOT NULL,
  _meta_data JSON,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  tenant_id TEXT,
  type TEXT,
  variant TEXT,
  file_key TEXT,
  author TEXT,
  name TEXT NOT NULL,
  title TEXT,
  description TEXT,
  body TEXT,
  publish_date DATETIME,
  url TEXT,
  source TEXT,
  original_url TEXT,
  language TEXT,
  tags TEXT,
  category TEXT,
  status TEXT,
  state TEXT,
  metadata TEXT,
  thumbnail_asset_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS contents_slug_context_meta_type_idx ON contents (slug, context, _meta_type);
`;

const ASSETS_SCHEMA = `
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  _meta_type TEXT NOT NULL,
  _meta_data JSON,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  tenant_id TEXT,
  name TEXT DEFAULT '',
  source_uri TEXT DEFAULT '',
  mime_type TEXT DEFAULT '',
  description TEXT DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  primary_version_id TEXT,
  type_slug TEXT DEFAULT '',
  status_slug TEXT DEFAULT '',
  owner_profile_id TEXT,
  parent_id TEXT,
  folder_id TEXT,
  source_type TEXT DEFAULT '',
  external_id TEXT DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS assets_slug_context_idx ON assets (slug, context);
`;

const ASSET_ASSOCIATIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS asset_associations (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  asset_id TEXT,
  meta_type TEXT,
  meta_id TEXT,
  role TEXT DEFAULT 'default',
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS asset_associations_unique_idx ON asset_associations (asset_id, meta_type, meta_id, role);
`;

async function createDb(): Promise<DatabaseInterface> {
  const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  await syncSchema({
    db,
    schema: [CONTENTS_SCHEMA, ASSETS_SCHEMA, ASSET_ASSOCIATIONS_SCHEMA].join(
      '\n',
    ),
  });
  return db;
}

describe('content asset backfill', () => {
  it('ignores legacy asset_associations rows until they are explicitly backfilled', async () => {
    const db = await createDb();
    const contents = await Contents.create({ db });
    const assets = await AssetCollection.create({ db });

    const content = await contents.create({
      name: 'legacy-content',
      title: 'Legacy content',
      body: 'Legacy body',
      status: 'draft',
      tenantId: 'tenant-1',
    });
    const asset = await assets.create({
      name: 'legacy-image.jpg',
      sourceUri: 'file:///tmp/legacy-image.jpg',
      mimeType: 'image/jpeg',
      tenantId: 'tenant-1',
    });

    await db.insert('asset_associations', {
      id: 'assoc-1',
      slug: 'assoc-1',
      context: '',
      created_at: new Date(),
      updated_at: new Date(),
      asset_id: asset.id,
      meta_type: 'Content',
      meta_id: content.id,
      role: 'thumbnail',
      sort_order: 2,
    });

    await expect(content.getAssets('thumbnail')).resolves.toEqual([]);

    const result = await backfillContentAssetsFromAssetAssociations({ db });
    expect(result).toMatchObject({
      scanned: 1,
      migrated: 1,
      duplicate: 0,
      deletedLegacy: 0,
    });

    const reloaded = await contents.get({ id: content.id });
    const linkedAssets = await reloaded?.getAssets('thumbnail');

    expect(linkedAssets).toHaveLength(1);
    expect(linkedAssets?.[0]?.id).toBe(asset.id);

    const rows = await db.list('content_assets', {});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.relationship).toBe('thumbnail');
    expect(rows[0]?.sort_order ?? rows[0]?.sortOrder).toBe(2);
  });

  it('can delete legacy rows once the backfill has succeeded', async () => {
    const db = await createDb();
    const contents = await Contents.create({ db });
    const assets = await AssetCollection.create({ db });

    const content = await contents.create({
      name: 'legacy-cleanup',
      title: 'Legacy cleanup',
      body: 'Legacy cleanup body',
      status: 'draft',
    });
    const asset = await assets.create({
      name: 'legacy-cleanup.jpg',
      sourceUri: 'file:///tmp/legacy-cleanup.jpg',
      mimeType: 'image/jpeg',
    });

    await db.insert('asset_associations', {
      id: 'assoc-cleanup',
      slug: 'assoc-cleanup',
      context: '',
      created_at: new Date(),
      updated_at: new Date(),
      asset_id: asset.id,
      meta_type: 'Content',
      meta_id: content.id,
      role: 'default',
      sort_order: 0,
    });

    const result = await backfillContentAssetsFromAssetAssociations({
      db,
      deleteLegacy: true,
    });

    expect(result).toMatchObject({
      scanned: 1,
      migrated: 1,
      deletedLegacy: 1,
    });

    expect(await db.list('asset_associations', {})).toEqual([]);

    const rows = await db.list('content_assets', {});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.relationship).toBe('attachment');
  });
});
