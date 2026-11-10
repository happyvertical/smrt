import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  convertFormat,
  generateThumbnail,
  getDimensions,
  getImageMetadata,
  getImageProcessor,
  resizeImage,
} from '@happyvertical/images';
import sharp from 'sharp';
import { expect, it } from 'vitest';

it('processes local images through the required Sharp backend without Jimp', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'smrt-sharp-backend-'));
  try {
    const input = join(directory, 'input.png');
    await sharp({
      create: {
        width: 120,
        height: 80,
        channels: 3,
        background: '#3388cc',
      },
    })
      .png()
      .toFile(input);
    const processor = await getImageProcessor();
    expect(await processor.getDimensions(input)).toEqual({
      width: 120,
      height: 80,
    });
    expect((await getImageMetadata(input)).format).toBe('png');

    const resized = join(directory, 'resized.png');
    await resizeImage(input, resized, { width: 60, height: 40, fit: 'fill' });
    expect(await getDimensions(resized)).toEqual({ width: 60, height: 40 });

    const converted = join(directory, 'converted.webp');
    await convertFormat(input, converted, { format: 'webp' });
    expect((await sharp(await readFile(converted)).metadata()).format).toBe(
      'webp',
    );

    const thumbnail = join(directory, 'thumbnail.png');
    await generateThumbnail(input, thumbnail, {
      maxWidth: 30,
      maxHeight: 20,
      format: 'png',
    });
    expect(await getDimensions(thumbnail)).toEqual({ width: 30, height: 20 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
