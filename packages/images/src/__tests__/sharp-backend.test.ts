import { spawnSync } from 'node:child_process';
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

it('imports the published image models without loading native image processors', () => {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'sharp' || specifier === '@happyvertical/images') throw new Error('image processor loaded at boot');
  return next(specifier, context);
} });
const images = await import(${JSON.stringify(new URL('../../dist/index.js', import.meta.url).href)});
if (typeof images.Image !== 'function' || typeof images.PhotoCutoutProfileStore !== 'function') process.exit(2);
`,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  expect(child.status, child.stderr).toBe(0);
});

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
