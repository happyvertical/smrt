import { writeFile } from 'node:fs/promises';
import { fetchDocument } from '@happyvertical/documents';
import { ensureDirectoryExists } from '@happyvertical/files';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Content } from './content';
import { Contents } from './contents';

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn(),
}));

vi.mock('@happyvertical/documents', () => ({
  fetchDocument: vi.fn(),
}));

vi.mock('@happyvertical/files', () => ({
  ensureDirectoryExists: vi.fn(),
}));

// Stable handle so tests can assert on the logger (S14 console→logger).
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@happyvertical/logger', () => ({ createLogger: () => mockLogger }));

describe('Contents collection helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses fact browse options and serializes catalog results', async () => {
    const contents = new Contents({} as any);
    const browseCatalog = vi.fn().mockResolvedValue([
      {
        toJSON: () => ({ id: 'fact-1', metadata: { stale: true } }),
        getMetadata: () => ({ source: 'catalog' }),
      },
    ]);
    vi.spyOn(contents as any, 'getFactCollection').mockResolvedValue({
      browseCatalog,
    });

    await expect(
      contents.browseFacts({
        q: 'bridge',
        limit: '5',
        offset: '10',
        minSimilarity: '0.75',
        includeSuperseded: 'true',
        latestOnly: 'false',
      }),
    ).resolves.toEqual([
      {
        id: 'fact-1',
        metadata: { source: 'catalog' },
      },
    ]);

    expect(browseCatalog).toHaveBeenCalledWith('bridge', {
      limit: 5,
      offset: 10,
      minSimilarity: 0.75,
      includeSuperseded: true,
      latestOnly: false,
      tenantId: null,
    });
  });

  it('gets content by slug and respects missing slug and status filters', async () => {
    const contents = new Contents({} as any);
    const content = {
      toJSON: () => ({ id: 'content-1', title: 'Bridge Update' }),
      getReferences: async () => [{ id: 'reference-1' }],
      getAssets: async () => [{ id: 'asset-1' }],
      status: 'published',
    };
    vi.spyOn(contents, 'get').mockResolvedValue(content as any);

    await expect(contents.getBySlug({})).rejects.toThrow('slug is required');
    await expect(
      contents.getBySlug({ slug: 'bridge-update', status: 'draft' }),
    ).resolves.toBeNull();
    await expect(
      contents.getBySlug({ slug: 'bridge-update', status: 'published' }),
    ).resolves.toEqual({
      id: 'content-1',
      title: 'Bridge Update',
      referenceIds: ['reference-1'],
      references: [{ id: 'reference-1' }],
      assetIds: ['asset-1'],
      assets: [{ id: 'asset-1' }],
    });
  });

  it('mirrors remote content, reuses existing content, and rejects bad URLs', async () => {
    const contents = new Contents({} as any);
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const existing = { id: 'existing-content' };
    vi.spyOn(contents, 'get').mockResolvedValueOnce(existing as any);

    await expect(
      contents.mirror({ url: 'https://example.com/already-there' }),
    ).resolves.toBe(existing);

    vi.spyOn(contents, 'get').mockResolvedValueOnce(null as any);
    vi.mocked(fetchDocument).mockResolvedValue({
      parts: [{ content: 'Line one' }, { content: 'Line two' }],
    } as any);
    vi.spyOn(Content.prototype, 'initialize').mockImplementation(
      async function initialize() {
        return this;
      },
    );
    vi.spyOn(Content.prototype, 'save').mockImplementation(
      async function save() {
        return this;
      },
    );

    const mirrored = await contents.mirror({
      url: 'https://example.com/news/bridge-update.html',
      context: 'news',
    });

    expect(mirrored).toMatchObject({
      type: 'mirror',
      title: 'bridge update',
      slug: 'bridge-update',
      context: 'news',
      body: 'Line one\n\nLine two',
    });

    await expect(contents.mirror({ url: 'not a url' })).rejects.toThrow(
      'Invalid URL provided',
    );
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('writes content files, normalizes plain text, and syncs article directories', async () => {
    const contents = new Contents({ contentDir: '/tmp/content' } as any);

    await contents.writeContentFile({
      content: {
        title: 'Bridge Update',
        slug: 'bridge-update',
        context: 'news',
        author: 'Reporter',
        publish_date: new Date('2026-03-20T09:00:00.000Z'),
        body: 'Paragraph one\n\nParagraph two',
      } as any,
      contentDir: '/tmp/content',
    });

    expect(vi.mocked(ensureDirectoryExists)).toHaveBeenCalledWith(
      '/tmp/content/news/bridge-update',
    );
    expect(vi.mocked(writeFile)).toHaveBeenCalledWith(
      '/tmp/content/news/bridge-update/index.md',
      expect.stringContaining('Paragraph one\n\nParagraph two'),
    );

    await contents.writeContentFile({
      content: {
        title: 'Markdown File',
        slug: 'markdown-file',
        context: '',
        body: '# Heading\n\nAlready markdown',
      } as any,
      contentDir: '/tmp/content',
    });
    expect(vi.mocked(writeFile)).toHaveBeenLastCalledWith(
      '/tmp/content/markdown-file/index.md',
      expect.stringContaining('# Heading'),
    );

    await expect(
      contents.writeContentFile({
        content: { slug: 'missing-dir', body: 'body' } as any,
        contentDir: '',
      }),
    ).rejects.toThrow('No content dir provided');

    const articleA = { id: 'a', slug: 'a', context: 'news' } as any;
    const articleB = { id: 'b', slug: 'b', context: 'news' } as any;
    vi.spyOn(contents, 'list').mockResolvedValue([articleA, articleB]);
    const writeSpy = vi
      .spyOn(contents, 'writeContentFile')
      .mockResolvedValue(undefined as any);

    await contents.syncContentDir({});

    expect(writeSpy).toHaveBeenCalledTimes(2);
    expect(writeSpy).toHaveBeenNthCalledWith(1, {
      content: articleA,
      contentDir: '/tmp/content',
    });
  });

  it('generates missing thumbnails with merged defaults and tracks failures', async () => {
    const contents = new Contents({
      thumbnail: {
        width: 800,
        height: 450,
        brandColor: '#004488',
      },
      ai: { provider: 'test-ai' },
    } as any);

    const successContent = {
      id: 'content-success',
      generateThumbnail: vi.fn().mockResolvedValue({ id: 'image-1' }),
    };
    const failingContent = {
      id: 'content-fail',
      generateThumbnail: vi
        .fn()
        .mockRejectedValue(new Error('generation failed')),
    };
    vi.spyOn(contents, 'list').mockResolvedValue([
      successContent,
      failingContent,
    ] as any);

    const result = await contents.generateMissingThumbnails({
      strategy: 'ai-generate',
      style: 'minimal',
    });

    expect(successContent.generateThumbnail).toHaveBeenCalledWith({
      strategy: 'ai-generate',
      style: 'minimal',
      width: 800,
      height: 450,
      ai: { provider: 'test-ai' },
    });
    expect(result.images).toEqual([{ id: 'image-1' }]);
    expect(result.failed).toEqual([
      {
        contentId: 'content-fail',
        error: 'generation failed',
      },
    ]);

    vi.spyOn(contents, 'list').mockResolvedValue([
      { id: 'content-weird' },
    ] as any);
    const invalidResult = await contents.generateMissingThumbnails({
      strategy: 'unknown' as any,
    });
    expect(invalidResult.images).toEqual([]);
    expect(invalidResult.failed[0]).toMatchObject({
      contentId: 'content-weird',
      error: 'Unknown strategy: unknown',
    });
  });

  it('provides tenant helper queries', async () => {
    const contents = new Contents({} as any);
    const listSpy = vi.spyOn(contents, 'list').mockResolvedValue([] as any);
    const querySpy = vi.spyOn(contents, 'query').mockResolvedValue([] as any);

    await contents.findByTenant('tenant-1');
    await contents.findGlobal();
    await contents.findWithGlobals('tenant-1');

    expect(listSpy).toHaveBeenNthCalledWith(1, {
      where: { tenantId: 'tenant-1' },
    });
    expect(listSpy).toHaveBeenNthCalledWith(2, {
      where: { tenantId: null },
    });
    expect(querySpy).toHaveBeenCalledWith(
      'SELECT * FROM contents WHERE tenant_id = ? OR tenant_id IS NULL',
      ['tenant-1'],
    );
  });
});
