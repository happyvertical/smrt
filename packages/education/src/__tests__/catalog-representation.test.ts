import { getTestDatabase } from '@happyvertical/smrt-core';
import { describe, expect, it, vi } from 'vitest';
import { CatalogResourceCollection } from '../catalog-collections.js';
import { CatalogDatabaseSyncStore } from '../catalog-database-sync-store.js';
import { CatalogReadService } from '../catalog-read-service.js';
import { createPublicIllustrativeMathematicsFirstEditionAdapter } from '../sources/public-illustrative-mathematics-adapter.js';
import {
  IM_ASSET_ORIGIN,
  IM_LICENSE,
  IM_ORIGIN,
} from '../sources/public-illustrative-mathematics-parser.js';
import { assertRepresentationMigration } from './catalog-representation-persistence.js';

const path = '/k5/teachers/kindergarten/unit-1/resources.html';
const zipId = 'mnoc9b85ajq0ahsu57o36uotfrdez';
const pdfId = 'mnoc9b85ajq0ahsu57o36uotfrdep';
const modified = 'Wed, 14 Dec 2022 12:29:18 GMT';
const html = `<title>Unit resources</title><table><tr><td>Student Task Statements</td><td><a class="im-c-filetype--pdf" href="${IM_ASSET_ORIGIN}/${zipId}">pdf</a></td></tr><tr><td>Family Support Materials</td><td><a class="im-c-filetype--pdf" href="${IM_ASSET_ORIGIN}/${pdfId}">pdf</a></td></tr></table><footer><p>© 2021 Illustrative Mathematics. Licensed under <a href="${IM_LICENSE}">CC BY 4.0</a>.</p></footer>`;
function setup(zipType = 'application/zip', zipLength = 92_253_588) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const address = String(url);
    const isHtml = address.startsWith(IM_ORIGIN);
    const zip = address.endsWith(zipId);
    const response = new Response(isHtml ? html : null, {
      headers: isHtml
        ? { 'content-type': 'text/html' }
        : {
            'content-type': zip ? zipType : 'application/pdf',
            'content-length': String(zip ? zipLength : 4_308_701),
            etag: zip ? '"zip-v1"' : '"pdf-v1"',
            'last-modified': modified,
          },
    });
    Object.defineProperty(response, 'url', { value: address });
    return response;
  });
  return {
    fetch,
    adapter: createPublicIllustrativeMathematicsFirstEditionAdapter({ fetch }),
  };
}
async function enumerate(f = setup()) {
  return await f.adapter.enumerate({
    cursor: JSON.stringify({ v: 1, todo: [path, '/HS/index.html'], offset: 0 }),
    checkpoint: {
      providerId: 'illustrative-mathematics',
      complete: false,
      importedCount: 0,
      failures: [],
    },
  });
}

describe('catalog observed representation metadata', () => {
  it('migrates existing rows with nullable legacy absence and rejects invalid replacement before writes', async () => {
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['CatalogResource', 'CatalogSyncState'],
    });
    try {
      await assertRepresentationMigration(db, 'sqlite');
    } finally {
      await db.close?.();
    }
  });
  it('retains known page118 ZIP and sibling PDF, advances and persists/hydrates/reads actual metadata without content GET', async () => {
    const f = setup();
    const page = await enumerate(f);
    expect(page.paused).not.toBe(true);
    expect(page.records.filter((r) => r.visibility === 'catalog')).toHaveLength(
      2,
    );
    expect(JSON.parse(page.nextCursor ?? '{}').todo).toEqual([
      '/HS/index.html',
    ]);
    const zip = page.records.find((r) => r.stableId.endsWith(zipId));
    const pdf = page.records.find((r) => r.stableId.endsWith(pdfId));
    expect(zip).toMatchObject({
      availableFormats: ['zip'],
      representation: {
        format: 'zip',
        mediaType: 'application/zip',
        byteLength: 92_253_588,
        validators: { etag: '"zip-v1"', lastModified: modified },
        acquisition: { status: 'unsupported-format' },
      },
      licenseEvidence: {
        state: 'verified',
        permittedOperations: [
          'link',
          'download',
          'print',
          'adapt',
          'redistribute',
          'commercial-use',
        ],
      },
    });
    expect(pdf).toMatchObject({
      availableFormats: ['pdf'],
      representation: {
        format: 'pdf',
        mediaType: 'application/pdf',
        byteLength: 4_308_701,
        acquisition: { status: 'supported', maxBytes: 32 * 1024 * 1024 },
      },
    });
    expect(
      f.fetch.mock.calls.every(
        ([url, init]) =>
          String(url).startsWith(IM_ORIGIN) || init?.method === 'HEAD',
      ),
    ).toBe(true);
    if (!zip) throw new Error('Missing ZIP metadata');
    const requestCount = f.fetch.mock.calls.length;
    for (const format of ['zip', 'pdf'])
      await expect(
        f.adapter.acquire({
          providerId: zip.providerId,
          stableId: zip.stableId,
          revision: zip.revision,
          format,
        }),
      ).rejects.toThrow();
    expect(f.fetch).toHaveBeenCalledTimes(requestCount);
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['CatalogResource', 'CatalogSyncState'],
    });
    try {
      const store = new CatalogDatabaseSyncStore(db);
      for (const record of page.records) await store.upsert(record, 'run');
      const rows = await (await CatalogResourceCollection.create({ db })).list({
        where: { providerId: 'illustrative-mathematics' },
      });
      const read = await new CatalogReadService({
        search: async () =>
          rows.map((row) => ({
            ...page.records.find((r) => r.stableId === row.stableId),
            id: String(row.id),
            representation: row.getRepresentation(),
          })),
      }).search({
        tenantId: 'family',
        actorUserId: 'guardian',
        roles: ['guardian'],
      });
      expect(
        read.find((r) => r.stableId.endsWith(zipId))?.representation,
      ).toEqual(zip?.representation);
      expect(
        read.find((r) => r.stableId.endsWith(pdfId))?.representation,
      ).toEqual(pdf?.representation);
    } finally {
      await db.close?.();
    }
  });
  it('keeps oversized PDF metadata with size-limit while retaining its legal operations', async () => {
    const f = setup('application/pdf', 92_253_588);
    const result = await enumerate(f);
    expect(result.paused).not.toBe(true);
    expect(
      result.records.find((r) => r.stableId.endsWith(zipId)),
    ).toMatchObject({
      availableFormats: ['pdf'],
      representation: {
        format: 'pdf',
        byteLength: 92_253_588,
        acquisition: { status: 'size-limit', maxBytes: 32 * 1024 * 1024 },
      },
      licenseEvidence: {
        permittedOperations: [
          'link',
          'download',
          'print',
          'adapt',
          'redistribute',
          'commercial-use',
        ],
      },
    });
    const oversized = result.records.find((r) => r.stableId.endsWith(zipId));
    if (!oversized) throw new Error('Missing over-cap PDF');
    const count = f.fetch.mock.calls.length;
    await expect(
      f.adapter.acquire({
        providerId: oversized.providerId,
        stableId: oversized.stableId,
        revision: oversized.revision,
        format: 'pdf',
      }),
    ).rejects.toThrow('revision');
    expect(f.fetch).toHaveBeenCalledTimes(count);
  });
  it.each([
    'application/octet-stream',
    'text/html',
    'application/x-zip-compressed',
  ])('pauses unknown MIME %s without advancing or emitting sibling rows', async (type) => {
    const f = setup(type);
    const page = await enumerate(f);
    expect(page).toMatchObject({ paused: true, complete: false, records: [] });
    expect(JSON.parse(page.nextCursor ?? '{}').todo).toEqual([
      path,
      '/HS/index.html',
    ]);
    expect(
      f.fetch.mock.calls.every(
        ([url, init]) =>
          String(url).startsWith(IM_ORIGIN) || init?.method === 'HEAD',
      ),
    ).toBe(true);
  });
});
