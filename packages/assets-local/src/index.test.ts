import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssetRuntime } from '@happyvertical/smrt-assets';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import type { DatabaseInterface } from '@happyvertical/sql';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createLocalAssetProcessor,
  extractAssetImageMetadataFromBuffer,
  normalizeAssetImageMetadata,
} from './index';

describe('smrt-assets local processor', () => {
  let db: DatabaseInterface;
  let storageDir: string;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    storageDir = mkdtempSync(join(tmpdir(), 'smrt-assets-local-'));
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
    if (storageDir && existsSync(storageDir)) {
      rmSync(storageDir, { recursive: true, force: true });
    }
  });

  async function samplePng(width = 24, height = 12): Promise<Buffer> {
    return sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: 20, g: 120, b: 180, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
  }

  it('extracts image metadata from local bytes', async () => {
    const metadata = await extractAssetImageMetadataFromBuffer(
      await samplePng(),
    );

    expect(metadata).toMatchObject({
      width: 24,
      height: 12,
      mimeType: 'image/png',
      gps: null,
    });
  });

  it('normalizes EXIF rational GPS metadata', () => {
    const metadata = normalizeAssetImageMetadata({
      exif: {
        GPSLatitude: [
          { numerator: 52, denominator: 1 },
          { numerator: 27, denominator: 1 },
          { numerator: 54, denominator: 1 },
        ],
        GPSLongitude: [
          { numerator: 114, denominator: 1 },
          { numerator: 2, denominator: 1 },
          { numerator: 59, denominator: 1 },
        ],
        GPSLongitudeRef: 'W',
      },
    });
    expect(metadata.gps?.latitude).toBeCloseTo(52.465, 6);
    expect(metadata.gps?.longitude).toBeCloseTo(-114.04972222222221, 6);
  });

  it('generates and caches standard image variants', async () => {
    const processor = createLocalAssetProcessor({
      variants: {
        thumb: { width: 16, height: 16, fit: 'cover' },
      },
    });
    const runtime = await createAssetRuntime({
      db,
      storage: storageDir,
      capabilityProviders: [processor],
    });
    const source = await runtime.storeSourceAsset(
      'source.png',
      await samplePng(),
      { mimeType: 'image/png', typeSlug: 'image' },
    );

    const processed = await runtime.processAsset(source, {
      variants: [{ variant: 'thumb' }],
    });
    const generated = processed.variants?.[0];
    const cached = await runtime.ensureVariant(source, { variant: 'thumb' });

    expect(processed.metadata).toMatchObject({ width: 24, height: 12 });
    expect(source.getMetadata()).toMatchObject({
      imageMetadata: { width: 24, height: 12 },
    });
    expect(generated).toMatchObject({
      variant: 'thumb',
      source: 'generated',
    });
    expect(generated?.asset.mimeType).toBe('image/webp');
    expect(generated?.asset.typeSlug).toBe('image-variant');
    expect(generated?.asset.parentId).toBe(source.id);
    expect(generated?.asset.externalId).toContain('smrt-assets:variant');
    expect(generated?.asset.getMetadata()).toMatchObject({
      assetVariant: {
        sourceAssetId: source.id,
        variant: 'thumb',
        width: 16,
        height: 16,
      },
    });
    expect(cached.source).toBe('cached');
    expect(cached.asset.id).toBe(generated?.asset.id);
  });

  it('throws clearly for custom variants without dimensions', async () => {
    const runtime = await createAssetRuntime({
      db,
      storage: storageDir,
      capabilityProviders: [createLocalAssetProcessor()],
    });
    const source = await runtime.storeSourceAsset(
      'source.png',
      await samplePng(),
      { mimeType: 'image/png', typeSlug: 'image' },
    );

    await expect(
      runtime.ensureVariant(source, { variant: 'unknown' }),
    ).rejects.toThrow(/requires width and height/);
  });
});
