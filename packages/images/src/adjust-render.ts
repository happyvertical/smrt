/**
 * Node-only renderer for local picture adjustments (sharp).
 *
 * Split from `./adjust` so the browser-safe root never reaches sharp. Exported
 * from `@happyvertical/smrt-images/node`.
 */

import {
  type AppliedImageAdjustments,
  clamp,
  type ImageAdjustments,
  type ImageAdjustOutputFormat,
  normalizeImageAdjustments,
  regionToPixels,
} from './adjust';

/**
 * Render adjustments with sharp. The EXIF orientation is applied first, so
 * "turn right" means right as the person sees the picture. `format` defaults
 * to the source's (JPEG, PNG or WebP; anything else becomes JPEG).
 */
export async function applyImageAdjustments(
  data: Buffer,
  input: ImageAdjustments,
  options: {
    format?: ImageAdjustOutputFormat;
    quality?: number;
    /** A final fit (for previews), after `maxWidth`/`maxHeight`. */
    fit?: { width: number; height: number; fit?: 'cover' | 'inside' };
  } = {},
): Promise<AppliedImageAdjustments> {
  const a = normalizeImageAdjustments(input);
  const { default: sharp } = await import('sharp');

  // Bake orientation and quarter turns first so later steps see the picture
  // the way the person does.
  let pipeline = sharp(data, { failOn: 'error' }).rotate();
  if (a.rotate) pipeline = pipeline.rotate(a.rotate);
  if (a.flipHorizontal) pipeline = pipeline.flop();
  if (a.flipVertical) pipeline = pipeline.flip();

  if (a.region) {
    const turned = await pipeline.clone().toBuffer({ resolveWithObject: true });
    pipeline = sharp(turned.data).extract(
      regionToPixels(a.region, turned.info.width, turned.info.height),
    );
  }

  if (a.brightness != null || a.saturation != null) {
    pipeline = pipeline.modulate({
      ...(a.brightness != null ? { brightness: a.brightness } : {}),
      ...(a.saturation != null ? { saturation: a.saturation } : {}),
    });
  }
  if (a.contrast != null) {
    // Stretch around mid-grey: out = c * in + 128 * (1 - c).
    pipeline = pipeline.linear(a.contrast, 128 * (1 - a.contrast));
  }
  if (a.grayscale) pipeline = pipeline.grayscale();

  if (a.maxWidth != null || a.maxHeight != null) {
    pipeline = pipeline.resize({
      width: a.maxWidth,
      height: a.maxHeight,
      fit: 'inside',
      withoutEnlargement: true,
    });
  }
  if (options.fit) {
    // A second resize in one sharp pipeline replaces the first, so render
    // the adjusted picture before fitting it.
    const adjusted = await pipeline.toBuffer();
    pipeline = sharp(adjusted).resize({
      width: options.fit.width,
      height: options.fit.height,
      fit: options.fit.fit ?? 'inside',
      withoutEnlargement: options.fit.fit !== 'cover',
    });
  }

  const sourceFormat = (await sharp(data).metadata()).format;
  const format: ImageAdjustOutputFormat =
    options.format ??
    (sourceFormat === 'png' || sourceFormat === 'webp' ? sourceFormat : 'jpeg');
  const quality = clamp(Math.round(options.quality ?? 88), 30, 100);
  pipeline =
    format === 'png'
      ? pipeline.png()
      : format === 'webp'
        ? pipeline.webp({ quality })
        : pipeline.jpeg({ quality, mozjpeg: true });

  const out = await pipeline.toBuffer({ resolveWithObject: true });
  return {
    data: out.data,
    mimeType: `image/${format}`,
    width: out.info.width,
    height: out.info.height,
  };
}
