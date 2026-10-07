/**
 * Local picture adjustments (`../adjust.ts`): the pure helpers (normalize,
 * encode/decode, variants, focus regions) and real sharp rendering.
 */

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  decodeImageAdjustments,
  describeImageAdjustments,
  encodeImageAdjustments,
  IMAGE_ADJUST_OPERATIONS,
  imageAdjustVariants,
  isEmptyImageAdjustments,
  isImageAdjustOperation,
  normalizeImageAdjustments,
  regionForFocus,
  regionToPixels,
} from '../adjust';
import { applyImageAdjustments } from '../adjust-render';

async function greyJpeg(width: number, height: number, level = 100) {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: level, g: level, b: level },
    },
  })
    .jpeg({ quality: 95 })
    .toBuffer();
}

/** Red left half, blue right half, green bottom-right quarter. */
async function quadrantsPng(width: number, height: number) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const right = x >= width / 2;
      const bottom = y >= height / 2;
      if (!right) pixels[i] = 255;
      else if (bottom) pixels[i + 1] = 255;
      else pixels[i + 2] = 255;
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

describe('normalizeImageAdjustments', () => {
  it('clamps values and drops the ones that change nothing', () => {
    expect(
      normalizeImageAdjustments({
        brightness: 9,
        contrast: 1,
        saturation: -1,
        grayscale: 'yes',
        rotate: -90,
        maxWidth: 3,
      }),
    ).toEqual({ brightness: 3, saturation: 0, rotate: 270, maxWidth: 16 });
  });

  it('refuses a turn that is not a quarter turn', () => {
    expect(() => normalizeImageAdjustments({ rotate: 45 })).toThrow(
      'quarter or half turn',
    );
  });

  it('keeps a region inside the picture and drops the whole picture', () => {
    expect(
      normalizeImageAdjustments({
        region: { left: 0.9, top: -1, width: 0.5, height: 2 },
      }),
    ).toEqual({ region: { left: 0.9, top: 0, width: 0.1, height: 1 } });
    expect(
      normalizeImageAdjustments({
        region: { left: 0, top: 0, width: 1, height: 1 },
      }),
    ).toEqual({});
    expect(() =>
      normalizeImageAdjustments({ region: { left: 0, top: 0 } }),
    ).toThrow('left, top, width and height');
  });

  it('knows empty adjustments', () => {
    expect(isEmptyImageAdjustments({ brightness: 1 })).toBe(true);
    expect(isEmptyImageAdjustments({ grayscale: true })).toBe(false);
  });
});

describe('encode/decode', () => {
  it('round-trips every field in a stable order', () => {
    const adjustments = {
      maxHeight: 900,
      region: { left: 0.1, top: 0.2, width: 0.5, height: 0.6 },
      flipVertical: true,
      flipHorizontal: true,
      rotate: 90 as const,
      grayscale: true,
      saturation: 0.8,
      contrast: 1.1,
      brightness: 1.2,
      maxWidth: 1600,
    };
    const spec = encodeImageAdjustments(adjustments);
    expect(spec).toBe('b1.2,c1.1,s0.8,g,r90,fh,fv,x0.1_0.2_0.5_0.6,w1600,h900');
    expect(decodeImageAdjustments(spec)).toEqual(
      normalizeImageAdjustments(adjustments),
    );
  });

  it('refuses anything it did not write', () => {
    expect(decodeImageAdjustments('')).toEqual({});
    for (const bad of ['q1', 'b', 'b1;rm', 'x1_2', 'bNaN', 'a'.repeat(300)]) {
      expect(() => decodeImageAdjustments(bad), bad).toThrow(
        'Unknown picture adjustment',
      );
    }
  });
});

describe('imageAdjustVariants', () => {
  it('offers two to four versions for every operation', () => {
    for (const { id } of IMAGE_ADJUST_OPERATIONS) {
      const variants = imageAdjustVariants(id);
      expect(variants.length, id).toBeGreaterThanOrEqual(2);
      expect(variants.length, id).toBeLessThanOrEqual(4);
      expect(new Set(variants.map((v) => v.id)).size).toBe(variants.length);
      for (const variant of variants) {
        expect(isEmptyImageAdjustments(variant.adjustments), variant.id).toBe(
          false,
        );
      }
    }
  });

  it('brightens by 10, 20 and 30 percent', () => {
    expect(imageAdjustVariants('brighter').map((v) => v.adjustments)).toEqual([
      { brightness: 1.1 },
      { brightness: 1.2 },
      { brightness: 1.3 },
    ]);
  });

  it('zooms towards the focus', () => {
    const [first] = imageAdjustVariants('zoom', { focus: 'top-right' });
    expect(first.adjustments.region).toEqual({
      left: 0.2,
      top: 0,
      width: 0.8,
      height: 0.8,
    });
  });

  it('checks operation names', () => {
    expect(isImageAdjustOperation('brighter')).toBe(true);
    expect(isImageAdjustOperation('snow')).toBe(false);
    expect(() => imageAdjustVariants('snow' as never)).toThrow();
  });
});

describe('regions', () => {
  it('centres and corners a focus', () => {
    expect(regionForFocus('center', 0.5)).toEqual({
      left: 0.25,
      top: 0.25,
      width: 0.5,
      height: 0.5,
    });
    expect(regionForFocus('bottom-left', 0.6)).toEqual({
      left: 0,
      top: 0.4,
      width: 0.6,
      height: 0.6,
    });
  });

  it('maps a region to pixels inside the picture', () => {
    expect(
      regionToPixels({ left: 0.5, top: 0.5, width: 0.5, height: 0.5 }, 101, 51),
    ).toEqual({ left: 51, top: 26, width: 50, height: 25 });
  });
});

describe('describeImageAdjustments', () => {
  it('says what changed in plain words', () => {
    expect(
      describeImageAdjustments({
        brightness: 0.8,
        grayscale: true,
        rotate: 270,
      }),
    ).toBe('turned left, 20% darker, black and white');
    expect(describeImageAdjustments({})).toBe('unchanged');
  });
});

describe('applyImageAdjustments (sharp)', () => {
  it('brightens and keeps JPEG', async () => {
    const out = await applyImageAdjustments(await greyJpeg(16, 8), {
      brightness: 1.3,
    });
    expect(out.mimeType).toBe('image/jpeg');
    expect(out.width).toBe(16);
    const stats = await sharp(out.data).stats();
    expect(stats.channels[0].mean).toBeGreaterThan(115);
  });

  it('raises contrast around mid-grey', async () => {
    const dark = await applyImageAdjustments(await greyJpeg(8, 8, 60), {
      contrast: 1.5,
    });
    const stats = await sharp(dark.data).stats();
    expect(stats.channels[0].mean).toBeLessThan(50);
  });

  it('makes black and white', async () => {
    const out = await applyImageAdjustments(await quadrantsPng(20, 20), {
      grayscale: true,
    });
    expect(out.mimeType).toBe('image/png');
    const { channels } = await sharp(out.data).stats();
    // One grey channel, or three equal ones.
    for (const channel of channels.slice(1, 3)) {
      expect(channel.mean).toBeCloseTo(channels[0].mean, 0);
    }
  });

  it('turns, mirrors and zooms into a region', async () => {
    const source = await quadrantsPng(40, 20);
    const turned = await applyImageAdjustments(source, { rotate: 90 });
    expect([turned.width, turned.height]).toEqual([20, 40]);

    // The bottom-right quarter is green.
    const zoomed = await applyImageAdjustments(source, {
      region: { left: 0.5, top: 0.5, width: 0.5, height: 0.5 },
    });
    expect([zoomed.width, zoomed.height]).toEqual([20, 10]);
    const green = await sharp(zoomed.data).stats();
    expect(green.channels[1].min).toBeGreaterThan(245);
    expect(green.channels[0].max).toBeLessThan(10);

    // Mirrored, the red half is on the right.
    const mirrored = await applyImageAdjustments(source, {
      flipHorizontal: true,
      region: { left: 0.5, top: 0, width: 0.5, height: 1 },
    });
    const red = await sharp(mirrored.data).stats();
    expect(red.channels[0].min).toBeGreaterThan(245);
  });

  it('fits inside a size without enlarging, then fits a preview', async () => {
    const source = await greyJpeg(400, 200);
    const small = await applyImageAdjustments(source, { maxWidth: 100 });
    expect([small.width, small.height]).toEqual([100, 50]);
    const same = await applyImageAdjustments(source, { maxWidth: 4000 });
    expect(same.width).toBe(400);
    const preview = await applyImageAdjustments(
      source,
      { brightness: 1.1 },
      { fit: { width: 120, height: 120, fit: 'cover' }, format: 'webp' },
    );
    expect([preview.width, preview.height, preview.mimeType]).toEqual([
      120,
      120,
      'image/webp',
    ]);
  });
});
