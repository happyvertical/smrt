/**
 * Barrel + re-export coverage
 *
 * Covers index.ts (package barrel) and media-bundle-persistence.ts (a
 * re-export barrel over @happyvertical/smrt-assets). Importing these modules
 * and touching their exports exercises the re-export wiring. The underlying
 * persistence logic itself is owned and tested by @happyvertical/smrt-assets.
 */

import { describe, expect, it } from 'vitest';
import * as images from '../index.js';
import { persistImageMediaBundleInspection } from '../media-bundle-persistence.js';

describe('package barrel (index.ts)', () => {
  it('exposes the documented runtime exports', () => {
    expect(images).toBeDefined();

    // Models / collections
    expect(typeof images.Image).toBe('function');
    expect(typeof images.ImageCollection).toBe('function');

    // Operations
    expect(typeof images.ImageCategorizer).toBe('function');
    expect(typeof images.ImageDeriver).toBe('function');
    expect(typeof images.ImageEditor).toBe('function');
    expect(typeof images.ImageMetadataExtractor).toBe('function');
    expect(typeof images.ImageSearch).toBe('function');
    expect(typeof images.UpstreamManager).toBe('function');

    // Prompt registration export
    expect(images.smrtImagesGenerateAltTextPrompt).toBeDefined();

    // Media-bundle persistence re-export
    expect(typeof images.persistImageMediaBundleInspection).toBe('function');
  });

  it('exports ImageCollection that extends a SMRT collection', () => {
    // Static item class is wired so STI resolution works
    expect((images.ImageCollection as any)._itemClass).toBe(images.Image);
  });
});

describe('media-bundle-persistence re-exports', () => {
  it('re-exports persistMediaBundleInspection from smrt-assets', () => {
    expect(typeof persistImageMediaBundleInspection).toBe('function');
    // Same function reference is surfaced via the package barrel
    expect(persistImageMediaBundleInspection).toBe(
      images.persistImageMediaBundleInspection,
    );
  });
});
