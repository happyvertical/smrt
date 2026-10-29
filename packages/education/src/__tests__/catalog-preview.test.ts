import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { describe, expect, it, vi } from 'vitest';
import type { CatalogSourceRecord } from '../catalog-contracts.js';
import { CatalogPolicy } from '../catalog-policy.js';
import {
  type CatalogPreview,
  CatalogPreviewService,
  catalogPreviewFor,
  catalogPreviewPngDimensions,
  normalizeCatalogPreview,
} from '../catalog-preview.js';
import { CatalogReadService } from '../catalog-read-service.js';
import { createPublicIllustrativeMathematicsFirstEditionAdapter } from '../sources/public-illustrative-mathematics-adapter.js';
import { parseImFirstEditionPage } from '../sources/public-illustrative-mathematics-parser.js';

import { assertCatalogPreviewPersistence } from './catalog-preview-persistence.js';

const path = '/k5/families/grade-1/unit-1/family-materials.html';
const sourceUrl = 'https://im.kendallhunt.com' + path;
const imageId = 'fd1cykl2wl4zyfc6vzfkl3x09pvr';
const imageUrl = 'https://cms-assets.illustrativemathematics.org/' + imageId;
const html = readFileSync(
  new URL('./fixtures/im-family-grade1-unit1.html', import.meta.url),
  'utf8',
);
const png = readFileSync(
  new URL('./fixtures/im-family-chart.png', import.meta.url),
);
const preview: CatalogPreview = {
  providerId: 'illustrative-mathematics',
  stableId: 'im-first-edition:' + path,
  revision: 'v1',
  reference: imageId,
  mediaType: 'image/png',
  width: 1350,
  height: 674,
  byteLength: png.length,
  sha256: createHash('sha256').update(png).digest('hex'),
  alt: 'Tally Chart',
  rights: {
    state: 'verified',
    identifier: 'CC-BY-4.0',
    sourceUrl,
    attribution: '© 2021 Illustrative Mathematics. CC BY 4.0.',
    retrievedAt: '2026-10-28T00:00:00.000Z',
  },
};
const record: CatalogSourceRecord & { id: string; withdrawnAt?: string } = {
  id: 'resource',
  providerId: preview.providerId,
  stableId: preview.stableId,
  revision: 'v1',
  canonicalUrl: sourceUrl,
  title: 'Adding, Subtracting, and Working with Data',
  visibility: 'catalog',
  licenseEvidence: { state: 'restricted' },
  preview,
};
const actor = {
  tenantId: 'family-a',
  actorUserId: 'guardian-a',
  roles: ['guardian'],
};
const request = { actor, resourceId: record.id, revision: record.revision };
function response(url: string, body: BodyInit, mediaType: string) {
  const result = new Response(body, { headers: { 'content-type': mediaType } });
  Object.defineProperty(result, 'url', { value: url });
  return result;
}

describe('catalog publisher previews', () => {
  it('projects only safe revision-bound metadata independently of full-resource permission', async () => {
    const search = vi.fn(async () => [record]);
    const [view] = await new CatalogReadService({ search }).search(actor);
    expect(view.preview).toEqual(preview);
    expect(
      new CatalogPolicy().authorize(record, 'download', actor).allowed,
    ).toBe(false);
    expect(JSON.stringify(view)).not.toContain('cms-assets');
    expect(catalogPreviewFor({ ...record, revision: 'v2' })).toBeUndefined();
    expect(
      catalogPreviewFor({
        ...record,
        preview: {
          ...preview,
          rights: { ...preview.rights, expiresAt: '2000-01-01' },
        },
      }),
    ).toBeUndefined();
    for (const invalid of [
      {},
      { ...preview, mediaType: 'image/svg+xml' },
      { ...preview, reference: 'https://localhost/image' },
      { ...preview, width: 5000 },
      { ...preview, rights: { ...preview.rights, state: 'unknown' } },
    ]) {
      expect(normalizeCatalogPreview(invalid)).toBeUndefined();
    }
    expect(
      await new CatalogReadService({
        search: async () => [{ ...record, withdrawnAt: 'now' }],
      }).search(actor),
    ).toEqual([]);
    expect(
      await new CatalogReadService({
        search: async () => [{ ...record, visibility: 'teacher' }],
      }).search(actor),
    ).toEqual([]);
  });

  it('reauthorizes actor, tenant, visibility, revision and withdrawal on cache hits', async () => {
    let current = { ...record };
    let allowed = true;
    const getResource = vi.fn(async () => current);
    const authorize = vi.fn(
      async (a: typeof actor) =>
        allowed &&
        a.tenantId === actor.tenantId &&
        a.actorUserId === actor.actorUserId,
    );
    const loadPreview = vi.fn(async () => png);
    const service = new CatalogPreviewService(
      { getResource, authorize },
      { loadPreview },
    );
    for (let i = 0; i < 2; i++) {
      const result = await service.serve(request);
      expect(result.status).toBe(200);
      expect(result.headers.get('cache-control')).toBe('private, no-store');
      expect(Buffer.from(await result.arrayBuffer())).toEqual(png);
    }
    expect(loadPreview).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledTimes(2);
    for (const input of [
      { ...request, actor: { ...actor, tenantId: 'family-b' } },
      { ...request, actor: { ...actor, actorUserId: 'learner-b' } },
      { ...request, revision: 'v0' },
    ])
      expect((await service.serve(input)).status).toBe(404);
    allowed = false;
    expect((await service.serve(request)).status).toBe(404);
    allowed = true;
    current = { ...record, visibility: 'teacher' };
    expect((await service.serve(request)).status).toBe(404);
    expect(
      (
        await service.serve({
          ...request,
          actor: { ...actor, roles: ['teacher'] },
        })
      ).status,
    ).toBe(200);
    current = { ...record, withdrawnAt: '2026-10-28' };
    const denied = await service.serve(request);
    expect(denied.status).toBe(404);
    expect(denied.headers.get('cache-control')).toBe('no-store');
    expect(loadPreview).toHaveBeenCalledTimes(1);
  });

  it('expires verified cache bytes and rights without bypassing live authorization', async () => {
    const now = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse('2026-10-28T00:00:00Z'));
    let current = { ...record };
    const loadPreview = vi.fn(async () => png);
    const service = new CatalogPreviewService(
      { getResource: async () => current, authorize: async () => true },
      { loadPreview },
    );
    try {
      expect((await service.serve(request)).status).toBe(200);
      now.mockReturnValue(Date.parse('2026-10-28T00:01:01Z'));
      expect((await service.serve(request)).status).toBe(200);
      expect(loadPreview).toHaveBeenCalledTimes(2);
      current = {
        ...record,
        preview: {
          ...preview,
          rights: { ...preview.rights, expiresAt: '2026-10-28T00:01:00Z' },
        },
      };
      expect((await service.serve(request)).status).toBe(404);
      expect(loadPreview).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it('bounds cache storage and evicts verified public preview bytes', async () => {
    let index = 0;
    const images = Array.from({ length: 9 }, (_, i) => {
      // Valid private ancillary padding keeps the full image decodable at the cap.
      const padding = Buffer.alloc(2 * 1024 * 1024 - png.length);
      padding.writeUInt32BE(padding.length - 12, 0);
      padding.write('npAD', 4, 'ascii');
      padding[padding.length - 5] = i;
      padding.writeUInt32BE(crc32(padding.subarray(4, -4)), padding.length - 4);
      return Buffer.concat([png.subarray(0, -12), padding, png.subarray(-12)]);
    });
    const records = images.map((bytes) => ({
      ...record,
      preview: {
        ...preview,
        byteLength: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    }));
    const loadPreview = vi.fn(async () => images[index]);
    const service = new CatalogPreviewService(
      { getResource: async () => records[index], authorize: async () => true },
      { loadPreview },
    );
    for (index = 0; index < images.length; index++)
      expect((await service.serve(request)).status).toBe(200);
    index = 0;
    expect((await service.serve(request)).status).toBe(200);
    expect(loadPreview).toHaveBeenCalledTimes(10);
  });

  it('retains cached bytes within capacity after concurrent misses for the same image', async () => {
    let index = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const images = [
      png,
      ...Array.from({ length: 7 }, (_, i) => {
        const padding = Buffer.alloc(2 * 1024 * 1024 - png.length);
        padding.writeUInt32BE(padding.length - 12, 0);
        padding.write('npAD', 4, 'ascii');
        padding[padding.length - 5] = i;
        padding.writeUInt32BE(
          crc32(padding.subarray(4, -4)),
          padding.length - 4,
        );
        return Buffer.concat([
          png.subarray(0, -12),
          padding,
          png.subarray(-12),
        ]);
      }),
    ];
    const records = images.map((bytes) => ({
      ...record,
      preview: {
        ...preview,
        byteLength: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    }));
    const loadPreview = vi.fn(async () => {
      const image = images[index];
      if (index === 0) await gate;
      return image;
    });
    const authorize = vi.fn(async () => true);
    const service = new CatalogPreviewService(
      { getResource: async () => records[index], authorize },
      { loadPreview },
    );
    const requests = Array.from({ length: 24 }, () => service.serve(request));
    try {
      await vi.waitFor(() => expect(loadPreview).toHaveBeenCalledTimes(24));
    } finally {
      release();
    }
    expect(
      (await Promise.all(requests)).every((result) => result.status === 200),
    ).toBe(true);
    for (index = 1; index < images.length; index++)
      expect((await service.serve(request)).status).toBe(200);
    // Actual verified bytes are below 16 MiB, so the first image must still hit.
    index = 0;
    expect((await service.serve(request)).status).toBe(200);
    expect(loadPreview).toHaveBeenCalledTimes(31);
    expect(authorize).toHaveBeenCalledTimes(32);
  });

  it('fails closed on changed, invalid, oversized or failed preview bytes', async () => {
    for (const loadPreview of [
      vi.fn(async () => Buffer.alloc(2 * 1024 * 1024 + 1)),
      vi.fn(async () => Buffer.from('not png')),
      vi.fn(async () => Buffer.concat([png, Buffer.from('changed')])),
      vi.fn(async () => {
        throw new Error('upstream');
      }),
    ]) {
      const service = new CatalogPreviewService(
        { getResource: async () => record, authorize: async () => true },
        { loadPreview },
      );
      expect((await service.serve(request)).status).toBe(404);
      expect((await service.serve(request)).status).toBe(404);
      expect(loadPreview).toHaveBeenCalledTimes(2);
    }
  });

  it('extracts an actual publisher diagram and page-specific rights, never logos/credited/ambiguous media', async () => {
    expect(parseImFirstEditionPage(html, path).previewImage).toEqual({
      id: imageId,
      alt: 'Tally Chart. Turtle, tallies, 6. Dog, tallies, 2. Rabbit, tallies, 12.',
    });
    for (const unsafe of [
      html
        .replaceAll('image/png', 'image/svg+xml')
        .replaceAll(
          'https://cms-assets.illustrativemathematics.org/',
          'https://evil.test/',
        ),
      html.replaceAll(
        '<figcaption class="c-figcaption"></figcaption>',
        '<figcaption>Photo copyright someone else</figcaption>',
      ),
      html.replace(
        'https://creativecommons.org/licenses/by/4.0/',
        'https://creativecommons.org/licenses/by-nc/4.0/',
      ),
      html.replace('</main>', '<p>Image attribution: third party</p></main>'),
    ]) {
      expect(
        parseImFirstEditionPage(unsafe, path).previewImage,
      ).toBeUndefined();
    }
    const fetcher = vi.fn(
      async (url: string | URL | Request, options?: RequestInit) => {
        expect(options?.redirect).toBe('error');
        return String(url) === sourceUrl
          ? response(sourceUrl, html, 'text/html')
          : response(imageUrl, png, 'image/png');
      },
    );
    const adapter = createPublicIllustrativeMathematicsFirstEditionAdapter({
      fetch: fetcher as typeof fetch,
    });
    const page = await adapter.enumerate({
      cursor: JSON.stringify({ v: 1, todo: [path], offset: 0 }),
      checkpoint: {
        providerId: preview.providerId,
        complete: false,
        importedCount: 0,
        failures: [],
      },
    });
    expect(page.records[0].preview).toMatchObject({
      reference: imageId,
      width: 1350,
      height: 674,
      sha256: preview.sha256,
      rights: { state: 'verified', identifier: 'CC-BY-4.0', sourceUrl },
    });
    expect(page.records[0].visibility).toBe('teacher');
    expect(page.records[0].preview?.revision).toBe(page.records[0].revision);
    expect(fetcher.mock.calls.map((c) => String(c[0]))).toEqual([
      sourceUrl,
      imageUrl,
    ]);
    await new CatalogReadService({
      search: async () => [{ ...page.records[0], id: 'real' }],
    }).search({ ...actor, roles: ['teacher'] });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      await adapter.loadPreview(page.records[0].preview as CatalogPreview),
    ).toEqual(new Uint8Array(png));
    await expect(
      adapter.loadPreview({ ...preview, reference: 'http://127.0.0.1' }),
    ).rejects.toThrow('Invalid');
  });

  it('bounds preview-only fetching and rejects unsupported MIME, redirects and upstream failures', async () => {
    for (const kind of [
      'mime',
      'redirect',
      'oversize',
      'upstream',
      'timeout',
    ]) {
      const fetcher = vi.fn(async () => {
        if (kind === 'timeout') return new Promise<Response>(() => {});
        if (kind === 'upstream') return new Response(null, { status: 503 });
        const result = response(
          kind === 'redirect' ? 'https://127.0.0.1/image' : imageUrl,
          kind === 'oversize' ? Buffer.alloc(2 * 1024 * 1024 + 1) : png,
          kind === 'mime' ? 'image/svg+xml' : 'image/png',
        );
        return result;
      });
      const adapter = createPublicIllustrativeMathematicsFirstEditionAdapter({
        fetch: fetcher as typeof fetch,
        timeoutMs: 20,
      });
      await expect(adapter.loadPreview(preview)).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      String(url) === sourceUrl
        ? response(sourceUrl, html, 'text/html')
        : response(imageUrl, png, 'image/svg+xml'),
    );
    const adapter = createPublicIllustrativeMathematicsFirstEditionAdapter({
      fetch: fetcher as typeof fetch,
    });
    const page = await adapter.enumerate({
      cursor: JSON.stringify({ v: 1, todo: [path], offset: 0 }),
      checkpoint: {
        providerId: preview.providerId,
        complete: false,
        importedCount: 0,
        failures: [],
      },
    });
    expect(page.records).toHaveLength(1);
    expect(page.records[0].preview).toBeUndefined();
  });

  it('rejects truncated publisher PNGs before recording or serving a verified preview', async () => {
    const truncated = png.subarray(0, 24);
    const current = {
      ...record,
      preview: {
        ...preview,
        byteLength: truncated.length,
        sha256: createHash('sha256').update(truncated).digest('hex'),
      },
    };
    const service = new CatalogPreviewService(
      { getResource: async () => current, authorize: async () => true },
      { loadPreview: async () => truncated },
    );
    expect((await service.serve(request)).status).toBe(404);
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      String(url) === sourceUrl
        ? response(sourceUrl, html, 'text/html')
        : response(imageUrl, truncated, 'image/png'),
    );
    const adapter = createPublicIllustrativeMathematicsFirstEditionAdapter({
      fetch: fetcher as typeof fetch,
    });
    const page = await adapter.enumerate({
      cursor: JSON.stringify({ v: 1, todo: [path], offset: 0 }),
      checkpoint: {
        providerId: preview.providerId,
        complete: false,
        importedCount: 0,
        failures: [],
      },
    });
    expect(page.records).toHaveLength(1);
    expect(page.records[0].preview).toBeUndefined();
  });

  it('rejects corrupt chunks, incomplete compressed data and invalid inflated scanlines', () => {
    const chunk = (data: Buffer) => {
      const result = Buffer.alloc(data.length + 12);
      result.writeUInt32BE(data.length, 0);
      result.write('IDAT', 4, 'ascii');
      data.copy(result, 8);
      result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
      return result;
    };
    const withPixels = (data: Buffer) =>
      Buffer.concat([
        png.subarray(0, 33),
        chunk(deflateSync(data)),
        png.subarray(-12),
      ]);
    const corruptCrc = Buffer.from(png);
    corruptCrc[29] ^= 1;
    const invalidFilter = Buffer.alloc((1350 * 4 + 1) * 674);
    invalidFilter[0] = 5;
    for (const invalid of [
      png.subarray(0, -1),
      corruptCrc,
      withPixels(Buffer.alloc(1)),
      withPixels(invalidFilter),
    ])
      expect(() => catalogPreviewPngDimensions(invalid)).toThrow();
  });

  it('denies rights that expire while the preview loader is awaited', async () => {
    const initial = Date.parse('2026-10-28T00:00:00Z');
    const now = vi.spyOn(Date, 'now').mockReturnValue(initial);
    const current = {
      ...record,
      preview: {
        ...preview,
        rights: {
          ...preview.rights,
          expiresAt: new Date(initial + 100).toISOString(),
        },
      },
    };
    const loader = vi.fn(async () => {
      await Promise.resolve();
      now.mockReturnValue(initial + 101);
      return png;
    });
    const service = new CatalogPreviewService(
      { getResource: async () => current, authorize: async () => true },
      { loadPreview: loader },
    );
    try {
      const result = await service.serve(request);
      expect(result.status).toBe(404);
      expect(result.headers.get('cache-control')).toBe('no-store');
      expect((await service.serve(request)).status).toBe(404);
      expect(loader).toHaveBeenCalledTimes(1);
    } finally {
      now.mockRestore();
    }
  });

  it('advances metadata enumeration when an optional publisher preview hangs', async () => {
    const nextPath = '/k5/families/grade-1/unit-2/family-materials.html';
    const aborted = vi.fn();
    const fetcher = vi.fn(
      async (url: string | URL | Request, options?: RequestInit) => {
        if (String(url) === sourceUrl)
          return response(sourceUrl, html, 'text/html');
        return new Promise<Response>((_resolve, reject) =>
          options?.signal?.addEventListener(
            'abort',
            () => {
              aborted();
              reject(new Error('aborted image'));
            },
            { once: true },
          ),
        );
      },
    );
    const adapter = createPublicIllustrativeMathematicsFirstEditionAdapter({
      fetch: fetcher as typeof fetch,
      timeoutMs: 50,
    });
    const page = await adapter.enumerate({
      cursor: JSON.stringify({ v: 1, todo: [path, nextPath], offset: 0 }),
      checkpoint: {
        providerId: preview.providerId,
        complete: false,
        importedCount: 0,
        failures: [],
      },
    });
    expect(page.paused).not.toBe(true);
    expect(page.records).toHaveLength(1);
    expect(page.records[0].preview).toBeUndefined();
    expect(JSON.parse(page.nextCursor ?? '{}').todo).toEqual([nextPath]);
    expect(aborted).toHaveBeenCalledTimes(1);
  });

  it('persists exact preview metadata; retries retain first retrieval and new revisions invalidate old previews', async () => {
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['CatalogResource', 'CatalogSyncState'],
    });
    try {
      await assertCatalogPreviewPersistence(db, 'sqlite');
    } finally {
      await db.close?.();
    }
  });
});
