/**
 * Barrel + re-export coverage
 *
 * Covers index.ts (package barrel) and media-bundle-persistence.ts (a
 * re-export barrel over @happyvertical/smrt-assets). Importing these modules
 * and touching their exports exercises the re-export wiring. The underlying
 * persistence logic itself is owned and tested by @happyvertical/smrt-assets.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as images from '../index.js';
import * as imagesNode from '../index.node.js';
import { persistImageMediaBundleInspection } from '../media-bundle-persistence.js';

describe('package barrel (index.ts)', () => {
  it('exposes the documented runtime exports', () => {
    expect(images).toBeDefined();

    // Models / collections
    expect(typeof images.Image).toBe('function');
    expect(typeof images.ImageCollection).toBe('function');

    // Operations
    expect(typeof images.ImageSearch).toBe('function');
    expect(typeof images.UpstreamManager).toBe('function');

    // Prompt registration export
    expect(images.smrtImagesGenerateAltTextPrompt).toBeDefined();

    // Media-bundle persistence re-export
    expect(typeof images.persistImageMediaBundleInspection).toBe('function');
  });

  it('keeps Node-only services off the browser-safe root (#3628)', () => {
    for (const name of [
      'ImageCategorizer',
      'ImageDeriver',
      'ImageEditor',
      'ImageMetadataExtractor',
      'applyImageAdjustments',
    ]) {
      expect(name in images, `${name} must not be on the root`).toBe(false);
    }
  });

  it('exposes the Node-only services plus the root from /node', () => {
    expect(typeof imagesNode.ImageCategorizer).toBe('function');
    expect(typeof imagesNode.ImageDeriver).toBe('function');
    expect(typeof imagesNode.ImageEditor).toBe('function');
    expect(typeof imagesNode.ImageMetadataExtractor).toBe('function');
    expect(typeof imagesNode.applyImageAdjustments).toBe('function');
    expect(imagesNode.Image).toBe(images.Image);
    expect(imagesNode.ImageCollection).toBe(images.ImageCollection);
  });

  it('exports ImageCollection and Image as a public, instantiable pair', () => {
    // Assert the public surface (both exported, ImageCollection is constructable)
    // rather than reaching into the underscored `_itemClass` STI internal.
    expect(typeof images.ImageCollection).toBe('function');
    expect(typeof images.Image).toBe('function');
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

describe('package export conditions (#3628)', () => {
  const pkg = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { exports: Record<string, Record<string, unknown>> };

  it('resolves the root to the Node entry under node, browser-safe otherwise', () => {
    const root = pkg.exports['.'];
    // `node` comes first so it wins for Node (runtime and types) while
    // browser/bundler builds skip it.
    expect(Object.keys(root)[0]).toBe('node');
    expect(root.node).toEqual({
      types: './dist/index.node.d.ts',
      import: './dist/index.node.js',
    });
    expect(root.types).toBe('./dist/index.d.ts');
    expect(root.import).toBe('./dist/index.js');
  });

  it('points ./node at the same Node entry', () => {
    expect(pkg.exports['./node']).toEqual(pkg.exports['.']?.node);
  });
});
