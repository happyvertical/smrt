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

    const publicResolver = vi.fn(async () => [
      { address: '93.184.216.34', family: 4 },
    ]);
    // No-redirect fetch so resolveSafeFinalUrl resolves to the input URL
    // without touching the network.
    const okFetch = vi.fn(async () => new Response(null, { status: 200 }));

    await expect(
      contents.mirror({
        url: 'https://example.com/already-there',
        resolveHostname: publicResolver,
        fetchImpl: okFetch as unknown as typeof fetch,
      }),
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
      resolveHostname: publicResolver,
      fetchImpl: okFetch as unknown as typeof fetch,
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

  it('refuses to mirror SSRF targets (loopback/metadata) (S5 #1388)', async () => {
    const contents = new Contents({} as any);
    const getSpy = vi.spyOn(contents, 'get');
    vi.mocked(fetchDocument).mockReset();

    // Literal loopback / cloud-metadata IPs never reach the resolver and must
    // be rejected before any document fetch.
    await expect(
      contents.mirror({ url: 'http://127.0.0.1:6379/internal' }),
    ).rejects.toThrow('Invalid URL provided');
    await expect(
      contents.mirror({ url: 'http://169.254.169.254/latest/meta-data/' }),
    ).rejects.toThrow('Invalid URL provided');

    // A public hostname that resolves to a private IP is also blocked.
    await expect(
      contents.mirror({
        url: 'https://attacker.example/feed',
        resolveHostname: async () => [{ address: '10.0.0.5', family: 4 }],
      }),
    ).rejects.toThrow('Invalid URL provided');

    // Non-http(s) schemes are rejected too.
    await expect(
      contents.mirror({ url: 'file:///etc/passwd' }),
    ).rejects.toThrow('Invalid URL provided');

    expect(vi.mocked(fetchDocument)).not.toHaveBeenCalled();
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('blocks a public URL that 30x-redirects to an internal host (review #1562)', async () => {
    const contents = new Contents({} as any);
    vi.mocked(fetchDocument).mockReset();
    const getSpy = vi.spyOn(contents, 'get');
    // Initial host is public, but the server redirects to cloud metadata.
    const redirectFetch = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        }),
    );

    await expect(
      contents.mirror({
        url: 'https://feed.example/post',
        resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
        fetchImpl: redirectFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow('Invalid URL provided');

    expect(vi.mocked(fetchDocument)).not.toHaveBeenCalled();
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('redacts userinfo credentials from mirror errors/logs (review #1562)', async () => {
    const contents = new Contents({} as any);
    mockLogger.error.mockClear();

    let err: Error | undefined;
    try {
      await contents.mirror({ url: 'https://user:s3cr3t@example.com/x' });
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toContain('Invalid URL provided');
    // The password must not appear in the thrown message or the log payload.
    expect(err?.message).not.toContain('s3cr3t');
    const loggedUrl =
      (mockLogger.error.mock.calls.at(-1)?.[1] as { url?: string })?.url ?? '';
    expect(loggedUrl).not.toContain('s3cr3t');
  });

  it('refuses to write content files outside the content directory (S5 #1388)', async () => {
    const contents = new Contents({} as any);

    // A traversal-bearing slug must not let an export escape contentDir.
    await expect(
      contents.writeContentFile({
        content: {
          title: 'Pwn',
          slug: '../../../../tmp/evil',
          context: 'news',
          body: 'malicious',
        } as any,
        contentDir: '/tmp/content',
      }),
    ).rejects.toThrow('outside of the content directory');

    // A traversal-bearing context is equally rejected.
    await expect(
      contents.writeContentFile({
        content: {
          title: 'Pwn',
          slug: 'ok',
          context: '../../../../etc/cron.d',
          body: 'malicious',
        } as any,
        contentDir: '/tmp/content',
      }),
    ).rejects.toThrow('outside of the content directory');

    expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
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

    // findByTenant still uses the auto-filtered list() path.
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(listSpy).toHaveBeenNthCalledWith(1, {
      where: { tenantId: 'tenant-1' },
    });
    // findGlobal / findWithGlobals now route through the shared
    // @happyvertical/smrt-tenancy raw helpers (#1600): they call query() with
    // the tenant predicate and { allowRawOnTenantScoped: true } instead of an
    // explicit `tenant_id IS NULL` list() filter (which the interceptor would
    // reject under an active tenant context). Content is an STI base, so no
    // `_meta_type` scope is added.
    expect(querySpy).toHaveBeenNthCalledWith(
      1,
      'SELECT * FROM contents WHERE tenant_id IS NULL',
      [],
      { allowRawOnTenantScoped: true },
    );
    expect(querySpy).toHaveBeenNthCalledWith(
      2,
      'SELECT * FROM contents WHERE tenant_id = ? OR tenant_id IS NULL',
      ['tenant-1'],
      { allowRawOnTenantScoped: true },
    );
  });
});
