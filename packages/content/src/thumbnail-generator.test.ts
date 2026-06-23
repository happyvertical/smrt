import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  fetchStaticMapMock,
  generateHeadlineCardMock,
  getAIMock,
  imageCollectionCreateMock,
  imageCreateMock,
  imageSaveMock,
} = vi.hoisted(() => ({
  fetchStaticMapMock: vi.fn(),
  generateHeadlineCardMock: vi.fn(),
  getAIMock: vi.fn(),
  imageCollectionCreateMock: vi.fn(),
  imageCreateMock: vi.fn(),
  imageSaveMock: vi.fn(),
}));

vi.mock('@happyvertical/geo', () => ({
  fetchStaticMap: fetchStaticMapMock,
}));

vi.mock('@happyvertical/images', () => ({
  generateHeadlineCard: generateHeadlineCardMock,
}));

vi.mock('@happyvertical/ai', () => ({
  getAI: getAIMock,
}));

vi.mock('@happyvertical/smrt-images', () => ({
  ImageCollection: {
    create: imageCollectionCreateMock,
  },
}));

import { ThumbnailGenerator } from './thumbnail-generator';

describe('ThumbnailGenerator', () => {
  beforeEach(() => {
    imageSaveMock.mockResolvedValue(undefined);
    // Real `SmrtCollection.create()` persists the row itself (calls save), so
    // the generator no longer issues a redundant `image.save()` (#1387). Model
    // that here: `create` invokes the save mock and returns the saved record.
    imageCreateMock.mockImplementation(async () => {
      const image = { id: 'image-1', save: imageSaveMock };
      await image.save();
      return image;
    });
    imageCollectionCreateMock.mockResolvedValue({
      create: imageCreateMock,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fetchStaticMapMock.mockReset();
    generateHeadlineCardMock.mockReset();
    getAIMock.mockReset();
    imageCollectionCreateMock.mockReset();
    imageCreateMock.mockReset();
    imageSaveMock.mockReset();
  });

  it('generates headline-card thumbnails and stores them as images', async () => {
    generateHeadlineCardMock.mockResolvedValue({
      buffer: Buffer.from('headline'),
      width: 1200,
      height: 630,
      mimeType: 'image/png',
    });

    const generator = new ThumbnailGenerator({
      id: 'content-1',
      title: 'Bridge Update',
      category: 'Local News',
    } as any);

    const image = await generator.generate({
      strategy: 'headline-card',
      brandColor: '#123456',
    });

    expect(generateHeadlineCardMock).toHaveBeenCalledWith(
      'Bridge Update',
      expect.objectContaining({
        width: 1200,
        height: 630,
        subtitle: 'Local News',
        brandColor: '#123456',
      }),
    );
    expect(imageCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'content-1-headline.png',
        mimeType: 'image/png',
      }),
    );
    expect(imageSaveMock).toHaveBeenCalled();
    expect(image).toMatchObject({ id: 'image-1' });
  });

  it('validates and generates static-map thumbnails', async () => {
    fetchStaticMapMock.mockResolvedValue({
      buffer: Buffer.from('map'),
      width: 800,
      height: 600,
      mimeType: 'image/jpeg',
    });

    const generator = new ThumbnailGenerator({
      id: 'content-2',
      metadata: { latitude: '51.05', longitude: '-114.07' },
    } as any);

    await expect(
      generator.generate({ strategy: 'static-map', zoom: 10 }),
    ).resolves.toMatchObject({ id: 'image-1' });

    expect(fetchStaticMapMock).toHaveBeenCalledWith(
      51.05,
      -114.07,
      expect.objectContaining({
        provider: 'mapbox',
        zoom: 10,
        width: 1200,
        height: 630,
      }),
    );

    const missingCoords = new ThumbnailGenerator({
      id: 'content-3',
      metadata: {},
    } as any);
    await expect(
      missingCoords.generate({ strategy: 'static-map' }),
    ).rejects.toThrow('latitude and longitude');

    const invalidCoords = new ThumbnailGenerator({
      id: 'content-4',
      metadata: { lat: 'north', lon: 'west' },
    } as any);
    await expect(
      invalidCoords.generate({ strategy: 'static-map' }),
    ).rejects.toThrow('Invalid latitude value');
  });

  it('generates AI thumbnails from direct clients, config-resolved clients, and URL/base64 responses', async () => {
    const directClient = {
      generateImage: vi.fn().mockResolvedValue({
        images: [{ data: Buffer.from('direct-buffer') }],
      }),
    };
    const generator = new ThumbnailGenerator(
      {
        id: 'content-5',
        title: 'Weather',
        description: 'Storm warning',
      } as any,
      {},
    );

    await expect(
      generator.generate({
        strategy: 'ai-generate',
        ai: directClient as any,
      }),
    ).resolves.toMatchObject({ id: 'image-1' });
    expect(directClient.generateImage).toHaveBeenCalledWith(
      expect.stringContaining('Weather'),
      expect.objectContaining({ size: '1200x630' }),
    );

    const resolvedClient = {
      generateImage: vi
        .fn()
        .mockResolvedValueOnce({
          images: [{ data: Buffer.from('base64-result').toString('base64') }],
        })
        .mockResolvedValueOnce({
          images: [{ data: 'https://example.com/generated.png' }],
        }),
    };
    getAIMock.mockResolvedValue(resolvedClient);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => Buffer.from('url-buffer'),
      }),
    );

    const configured = new ThumbnailGenerator(
      {
        id: 'content-6',
        title: 'Election Guide',
        description: 'Candidates and voting',
      } as any,
      {
        ai: { provider: 'test' } as any,
      },
    );

    await configured.generate({
      strategy: 'ai-generate',
      style: 'illustration',
    });
    await configured.generate({
      strategy: 'ai-generate',
      prompt: 'Custom prompt',
    });

    expect(getAIMock).toHaveBeenCalledWith({ provider: 'test' });
    expect(resolvedClient.generateImage).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('digital illustration'),
      expect.objectContaining({ outputFormat: 'buffer' }),
    );
    expect(resolvedClient.generateImage).toHaveBeenNthCalledWith(
      2,
      'Custom prompt',
      expect.any(Object),
    );
  });

  it('throws on unsupported AI flows and unknown strategies', async () => {
    const generator = new ThumbnailGenerator({
      id: 'content-7',
      title: 'No AI Config',
    } as any);

    await expect(
      generator.generate({ strategy: 'ai-generate' }),
    ).rejects.toThrow('AI configuration required');

    getAIMock.mockResolvedValueOnce(undefined);
    await expect(
      generator.generate({
        strategy: 'ai-generate',
        ai: { provider: 'unsupported' } as any,
      }),
    ).rejects.toThrow('Cannot read properties of undefined');

    const emptyResultsGenerator = new ThumbnailGenerator(
      { id: 'content-8', title: 'Empty Results' } as any,
      {
        ai: {
          generateImage: vi.fn().mockResolvedValue({ images: [] }),
        } as any,
      },
    );
    await expect(
      emptyResultsGenerator.generate({ strategy: 'ai-generate' }),
    ).rejects.toThrow('returned no results');

    const badFormatGenerator = new ThumbnailGenerator(
      { id: 'content-9', title: 'Bad Format' } as any,
      {
        ai: {
          generateImage: vi.fn().mockResolvedValue({
            images: [{ data: 42 }],
          }),
        } as any,
      },
    );
    await expect(
      badFormatGenerator.generate({ strategy: 'ai-generate' }),
    ).rejects.toThrow('unexpected format');

    await expect(
      generator.generate({ strategy: 'unknown' as any }),
    ).rejects.toThrow('Unknown thumbnail strategy');
  });
});
