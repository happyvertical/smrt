import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetCollection } from '@happyvertical/smrt-assets';
import { describe, expect, it } from 'vitest';
import {
  Character,
  CharacterOwnedAssetCollection,
  Performer,
  Scene,
  VideoShot,
} from './index.js';

function getTestDbUrl(name: string): string {
  return `file:${join(tmpdir(), `${name}-${randomUUID()}.db`)}`;
}

async function ensureLegacyColumn(
  db: any,
  tableName: string,
  columnName: string,
  columnType: string,
) {
  const tableInfo = await db.query(`PRAGMA table_info(${tableName})`);
  const rows = Array.isArray(tableInfo)
    ? tableInfo
    : Array.isArray(tableInfo?.rows)
      ? tableInfo.rows
      : [];

  if (
    rows.some(
      (row: Record<string, unknown>) =>
        row.name === columnName || row.column_name === columnName,
    )
  ) {
    return;
  }

  try {
    await db.query(
      `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`,
    );
  } catch (error) {
    const message = [
      error instanceof Error ? error.message : String(error),
      error &&
      typeof error === 'object' &&
      'context' in error &&
      typeof (error as { context?: { originalError?: unknown } }).context
        ?.originalError === 'string'
        ? (error as { context?: { originalError?: string } }).context
            ?.originalError
        : '',
    ]
      .join(' ')
      .toLowerCase();
    if (
      !message.includes('duplicate column') &&
      !message.includes('already exists')
    ) {
      throw error;
    }
  }
}

async function createAssetFixture(dbUrl: string) {
  const dbConfig = { type: 'sqlite' as const, url: dbUrl };
  const assets = await AssetCollection.create({ db: dbConfig });

  return {
    assets,
    db: (assets as any).db,
    dbConfig,
  };
}

describe('Video owned assets', () => {
  it('stores character asset links in character_assets and syncs legacy slots', async () => {
    const dbUrl = getTestDbUrl('video-character-assets');
    const { assets, dbConfig } = await createAssetFixture(dbUrl);

    const character = new Character({
      db: dbConfig,
      name: 'Bentley Anchor',
      tenantId: 'tenant-a',
    });
    await character.initialize();
    await character.save();

    const seedImage = await assets.create({
      name: 'seed.png',
      sourceUri: 'file:///tmp/seed.png',
      mimeType: 'image/png',
      tenantId: 'tenant-a',
    });
    await seedImage.save();

    const logo = await assets.create({
      name: 'logo.png',
      sourceUri: 'file:///tmp/logo.png',
      mimeType: 'image/png',
      tenantId: null,
    });
    await logo.save();

    await character.addAsset(seedImage, 'seed-image', 1);
    await character.addAsset(seedImage, 'seed-image', 1);
    await character.addAsset(logo, 'logo', 0);

    expect(character.imageAssetId).toBe(seedImage.id);
    expect(character.brandingKit.logoAssetId).toBe(logo.id);
    expect((await character.getAssetByRole('seed-image'))?.id).toBe(
      seedImage.id,
    );
    expect(
      (await character.getAssets('logo')).map((asset) => asset.id),
    ).toEqual([logo.id]);

    const links = await CharacterOwnedAssetCollection.create({ db: dbConfig });
    expect(
      await links.byLeft(character.id as string, { role: 'seed-image' }),
    ).toHaveLength(1);
  });

  it('resolves legacy STI-backed character assets during migration', async () => {
    const dbUrl = getTestDbUrl('video-character-legacy-assets');
    const { assets, db, dbConfig } = await createAssetFixture(dbUrl);

    const character = new Character({
      db: dbConfig,
      name: 'Legacy Character',
      tenantId: 'tenant-a',
    });
    await character.initialize();
    await character.save();

    await ensureLegacyColumn(db, 'assets', 'character_id', 'TEXT');
    await ensureLegacyColumn(db, 'assets', 'role', 'TEXT');

    const legacyAsset = await assets.create({
      name: 'legacy-motion.mp4',
      sourceUri: 'file:///tmp/legacy-motion.mp4',
      mimeType: 'video/mp4',
      tenantId: 'tenant-a',
    });
    await legacyAsset.save();

    await db.query(
      `UPDATE assets
          SET character_id = ?,
              role = ?,
              _meta_type = ?
        WHERE id = ?`,
      character.id,
      'base-motion',
      '@happyvertical/smrt-video:CharacterAsset',
      legacyAsset.id,
    );

    expect((await character.getAssetByRole('base-motion'))?.id).toBe(
      legacyAsset.id,
    );
  });

  it('syncs performer and scene asset helpers with legacy scalar fields', async () => {
    const dbUrl = getTestDbUrl('video-performer-scene-assets');
    const { assets, dbConfig } = await createAssetFixture(dbUrl);

    const reference = await assets.create({
      name: 'reference.jpg',
      sourceUri: 'file:///tmp/reference.jpg',
      mimeType: 'image/jpeg',
      tenantId: 'tenant-a',
    });
    await reference.save();

    const seed = await assets.create({
      name: 'seed.jpg',
      sourceUri: 'file:///tmp/seed.jpg',
      mimeType: 'image/jpeg',
      tenantId: 'tenant-a',
    });
    await seed.save();

    const source = await assets.create({
      name: 'scene.jpg',
      sourceUri: 'file:///tmp/scene.jpg',
      mimeType: 'image/jpeg',
      tenantId: 'tenant-a',
    });
    await source.save();

    const envMap = await assets.create({
      name: 'env.hdr',
      sourceUri: 'file:///tmp/env.hdr',
      mimeType: 'image/vnd.radiance',
      tenantId: 'tenant-a',
    });
    await envMap.save();

    const performer = new Performer({
      db: dbConfig,
      name: 'Alex Performer',
      tenantId: 'tenant-a',
    });
    await performer.initialize();
    await performer.save();

    await performer.addAsset(reference, 'reference', 0);
    await performer.addAsset(seed, 'seed', 0);

    expect(performer.referenceAssetIds).toEqual([reference.id]);
    expect(performer.seedImageAssetId).toBe(seed.id);
    expect((await performer.getAssetByRole('seed'))?.id).toBe(seed.id);

    const scene = new Scene({
      db: dbConfig,
      name: 'Studio',
      tenantId: 'tenant-a',
      sourceAssetId: source.id as string,
      lightingProfile: { envMapAssetId: envMap.id as string },
    });
    await scene.initialize();
    await scene.save();

    expect((await scene.getAssetByRole('source'))?.id).toBe(source.id);
    expect((await scene.getAssetByRole('env-map'))?.id).toBe(envMap.id);
  });

  it('keeps video shot ownership canonical on content_assets while reading legacy STI rows', async () => {
    const dbUrl = getTestDbUrl('video-shot-assets');
    const { assets, db, dbConfig } = await createAssetFixture(dbUrl);

    const shot = new VideoShot({
      db: dbConfig,
      title: 'Opening Shot',
      tenantId: 'tenant-a',
    });
    await shot.initialize();
    await shot.save();

    const thumbnail = await assets.create({
      name: 'thumbnail.jpg',
      sourceUri: 'file:///tmp/thumbnail.jpg',
      mimeType: 'image/jpeg',
      tenantId: 'tenant-a',
    });
    await thumbnail.save();

    await shot.addAsset(thumbnail, 'thumbnail', 0);
    expect((await shot.getAssetByRole('thumbnail'))?.id).toBe(thumbnail.id);

    await ensureLegacyColumn(db, 'assets', 'video_shot_id', 'TEXT');
    await ensureLegacyColumn(db, 'assets', 'role', 'TEXT');

    const legacyVideo = await assets.create({
      name: 'legacy-video.mp4',
      sourceUri: 'file:///tmp/legacy-video.mp4',
      mimeType: 'video/mp4',
      tenantId: 'tenant-a',
    });
    await legacyVideo.save();

    await db.query(
      `UPDATE assets
          SET video_shot_id = ?,
              role = ?,
              _meta_type = ?
        WHERE id = ?`,
      shot.id,
      'video',
      '@happyvertical/smrt-video:VideoShotAsset',
      legacyVideo.id,
    );

    expect((await shot.getAssetByRole('video'))?.id).toBe(legacyVideo.id);
  });
});
