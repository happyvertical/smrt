import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { createPhotoCutoutCoordinateGuide } from '../photo-cutout-coordinate-guide.js';

describe('createPhotoCutoutCoordinateGuide', () => {
  it('makes a same-sized transient PNG guide without changing the source data URL', async () => {
    const source = await sharp({
      create: { width: 100, height: 120, channels: 3, background: '#667788' },
    })
      .png()
      .toBuffer();
    const dataUrl = `data:image/png;base64,${source.toString('base64')}`;

    const guide = await createPhotoCutoutCoordinateGuide(dataUrl, 100, 120);

    expect(guide).toMatch(/^data:image\/png;base64,/);
    expect(guide).not.toBe(dataUrl);
    await expect(
      sharp(Buffer.from(guide.slice(22), 'base64')).metadata(),
    ).resolves.toMatchObject({ width: 100, height: 120, format: 'png' });
  });

  it('rejects declared dimensions that do not describe the decoded source', async () => {
    const source = await sharp({
      create: { width: 100, height: 120, channels: 3, background: '#667788' },
    })
      .png()
      .toBuffer();
    const dataUrl = `data:image/png;base64,${source.toString('base64')}`;

    await expect(
      createPhotoCutoutCoordinateGuide(dataUrl, 99, 120),
    ).rejects.toThrow('do not match');
  });
});
