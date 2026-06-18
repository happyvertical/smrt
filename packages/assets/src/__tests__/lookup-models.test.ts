/**
 * Coverage for the AssetType / AssetStatus lookup models — their constructors
 * (slug/name/description wiring) and the `getBySlug` accessors.
 */
import { describe, expect, it } from 'vitest';
import { AssetStatus } from '../asset-status';
import { AssetType } from '../asset-type';

describe('AssetStatus', () => {
  it('wires slug/name/description from options', () => {
    const status = new AssetStatus({
      slug: 'published',
      name: 'Published',
      description: 'Visible to consumers',
    });
    expect(status.slug).toBe('published');
    expect(status.name).toBe('Published');
    expect(status.description).toBe('Visible to consumers');
  });

  it('defaults to empty fields with no options', () => {
    const status = new AssetStatus();
    expect(status.name).toBe('');
    expect(status.description).toBe('');
  });

  it('getBySlug resolves (stub returns null)', async () => {
    expect(await AssetStatus.getBySlug('draft')).toBeNull();
  });
});

describe('AssetType', () => {
  it('wires slug/name/description from options', () => {
    const type = new AssetType({
      slug: 'image',
      name: 'Image',
      description: 'Raster or vector image',
    });
    expect(type.slug).toBe('image');
    expect(type.name).toBe('Image');
    expect(type.description).toBe('Raster or vector image');
  });

  it('getBySlug resolves (stub returns null)', async () => {
    expect(await AssetType.getBySlug('video')).toBeNull();
  });
});
