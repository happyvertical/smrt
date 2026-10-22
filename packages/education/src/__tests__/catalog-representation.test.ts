import { getTestDatabase } from '@happyvertical/smrt-core';
import { describe, expect, it, vi } from 'vitest';
import { CatalogResourceCollection } from '../catalog-collections.js';
import type {
  CatalogSourceRecord,
  CatalogSyncCheckpoint,
} from '../catalog-contracts.js';
import { CatalogDatabaseSyncStore } from '../catalog-database-sync-store.js';
import { CatalogReadService } from '../catalog-read-service.js';
import { CatalogSyncService } from '../catalog-sync-service.js';
import { createPublicIllustrativeMathematicsFirstEditionAdapter } from '../sources/public-illustrative-mathematics-adapter.js';
import {
  IM_ASSET_ORIGIN,
  IM_LICENSE,
  IM_ORIGIN,
  parseImFirstEditionPage,
} from '../sources/public-illustrative-mathematics-parser.js';
import { assertRepresentationMigration } from './catalog-representation-persistence.js';

const path = '/k5/teachers/kindergarten/unit-1/resources.html';
const zipId = 'mnoc9b85ajq0ahsu57o36uotfrdez';
const pdfId = 'mnoc9b85ajq0ahsu57o36uotfrdep';
const modified = 'Wed, 14 Dec 2022 12:29:18 GMT';
const html = `<title>Unit resources</title><table><tr><td>Student Task Statements</td><td><a class="im-c-filetype--pdf" href="${IM_ASSET_ORIGIN}/${zipId}">pdf</a></td></tr><tr><td>Family Support Materials</td><td><a class="im-c-filetype--pdf" href="${IM_ASSET_ORIGIN}/${pdfId}">pdf</a></td></tr></table><footer><p>© 2021 Illustrative Mathematics. Licensed under <a href="${IM_LICENSE}">CC BY 4.0</a>.</p></footer>`;
function setup(
  zipType = 'application/zip',
  zipLength = 92_253_588,
  icon = 'pdf',
) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const address = String(url);
    const isHtml = address.startsWith(IM_ORIGIN);
    const zip = address.endsWith(zipId);
    const response = new Response(
      isHtml
        ? html
            .replace('im-c-filetype--pdf', `im-c-filetype--${icon}`)
            .replace('>pdf</a>', `>${icon}</a>`)
        : null,
      {
        headers: isHtml
          ? { 'content-type': 'text/html' }
          : {
              'content-type': zip ? zipType : 'application/pdf',
              'content-length': String(zip ? zipLength : 4_308_701),
              etag: zip ? '"zip-v1"' : '"pdf-v1"',
              'last-modified': modified,
            },
      },
    );
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
  it('discovers actual DOCX metadata without requiring a PDF icon', async () => {
    const f = setup(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      4_205_212,
      'docx',
    );
    const result = await enumerate(f);
    expect(result.paused).not.toBe(true);
    expect(
      result.records.filter((r) => r.visibility === 'catalog'),
    ).toHaveLength(2);
    expect(
      result.records.find((r) => r.stableId.endsWith(zipId)),
    ).toMatchObject({
      availableFormats: ['docx'],
      representation: {
        format: 'docx',
        mediaType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        byteLength: 4_205_212,
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
    const docx = result.records.find((r) => r.stableId.endsWith(zipId));
    if (!docx) throw new Error('Missing DOCX');
    const count = f.fetch.mock.calls.length;
    for (const format of ['docx', 'pdf'])
      await expect(f.adapter.acquire({ ...docx, format })).rejects.toThrow();
    expect(f.fetch).toHaveBeenCalledTimes(count);
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['CatalogResource', 'CatalogSyncState'],
    });
    try {
      await new CatalogDatabaseSyncStore(db).upsert(docx, 'docx-run');
      const rows = await (await CatalogResourceCollection.create({ db })).list({
        where: { providerId: docx.providerId },
      });
      expect(rows[0].getRepresentation()).toEqual(docx.representation);
      const read = await new CatalogReadService({
        search: async () => [
          {
            ...docx,
            id: String(rows[0].id),
            representation: rows[0].getRepresentation(),
          },
        ],
      }).search({
        tenantId: 'tenant',
        actorUserId: 'guardian',
        roles: ['guardian'],
      });
      expect(read[0].representation).toEqual(docx.representation);
    } finally {
      await db.close?.();
    }
  });
  it('rejects an old icon-filter page fingerprint before reinterpreting its artifact offset or requesting assets', async () => {
    const currentHtml = html
      .replace('im-c-filetype--pdf', 'im-c-filetype--docx')
      .replace('>pdf</a>', '>docx</a>');
    const parsed = parseImFirstEditionPage(currentHtml, path);
    const previous = {
      ...parsed,
      artifacts: parsed.artifacts.filter((a) => a.id !== zipId),
      exclusions: [
        { code: 'unsupported_format', message: `Non-PDF artifact ${zipId}.` },
        ...parsed.exclusions,
      ],
    };
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify({ path, ...previous })),
    );
    const fingerprint = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const cursor = JSON.stringify({
      v: 1,
      todo: [path],
      offset: 1,
      pageRevision: fingerprint,
    });
    const f = setup(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      4_205_212,
      'docx',
    );
    const page = await f.adapter.enumerate({
      cursor,
      checkpoint: {
        providerId: 'illustrative-mathematics',
        cursor,
        complete: false,
        importedCount: 1,
        failures: [],
      },
    });
    expect(page).toMatchObject({
      paused: true,
      complete: false,
      nextCursor: cursor,
      records: [],
    });
    expect(page.exclusions?.[0].message).toContain('Metadata changed');
    expect(f.fetch.mock.calls.map(([, init]) => init?.method)).toEqual(['GET']);
  });

  it('documents quiescent public-store restart semantics without claiming concurrent restart safety', async () => {
    const providerId = 'illustrative-mathematics';
    const old: CatalogSourceRecord = {
      providerId,
      stableId: 'old',
      revision: 'old',
      canonicalUrl: 'https://example.test',
      title: 'Old metadata',
      visibility: 'catalog',
      licenseEvidence: { state: 'unknown' },
    };
    const records = new Map([
      [old.stableId, { record: old, run: 'old-run', withdrawn: false }],
    ]);
    let current: CatalogSyncCheckpoint = {
      providerId,
      runId: 'old-run',
      cursor: 'old-offset-fingerprint',
      complete: false,
      paused: true,
      importedCount: 6,
      lastSuccessfulAt: '2026-01-01T00:00:00Z',
      failures: [
        {
          code: 'provider_metadata_unavailable',
          message: 'Metadata changed during cursor traversal',
          count: 2,
          omittedDetailCount: 0,
        },
      ],
    };
    const withdraw = vi.fn(async (p: string, run: string) => {
      let n = 0;
      for (const row of records.values())
        if (row.record.providerId === p && row.run !== run) {
          row.withdrawn = true;
          n++;
        }
      return n;
    });
    const store = {
      getCheckpoint: async () => structuredClone(current),
      saveCheckpoint: async (value: CatalogSyncCheckpoint) => {
        current = structuredClone(value);
      },
      upsert: async (record: CatalogSourceRecord, run: string) => {
        records.set(record.stableId, { record, run, withdrawn: false });
      },
      withdrawUnseen: withdraw,
    };
    // Test precondition: no producers or provider operations are in flight; this is NOT a UI/CAS protocol.
    const expectedRunId = 'old-run';
    const paused = await store.getCheckpoint();
    if (paused.complete || !paused.paused || paused.runId !== expectedRunId)
      throw new Error('Expected paused generation changed');
    const runId = crypto.randomUUID();
    await store.saveCheckpoint({
      ...paused,
      runId,
      cursor: undefined,
      importedCount: 0,
      complete: false,
      paused: false,
      pauseReason: undefined,
      failures: structuredClone(paused.failures),
    });
    expect(current).toMatchObject({
      runId,
      importedCount: 0,
      complete: false,
      paused: false,
      lastSuccessfulAt: paused.lastSuccessfulAt,
      failures: paused.failures,
    });
    expect(current.cursor).toBeUndefined();
    expect(records.get('old')?.record).toEqual(old);
    expect(withdraw).not.toHaveBeenCalled();
    const first = await new CatalogSyncService(store, 0, 1).sync(providerId, {
      enumerate: async ({ cursor, checkpoint }) => {
        expect(cursor).toBeUndefined();
        expect(checkpoint.runId).toBe(runId);
        return {
          records: [{ ...old, stableId: 'retained' }],
          complete: false,
          nextCursor: 'next-chunk',
        };
      },
    });
    expect(first).toMatchObject({
      complete: false,
      paused: false,
      cursor: 'next-chunk',
      runId,
    });
    expect(records.get('old')?.withdrawn).toBe(false);
    expect(withdraw).not.toHaveBeenCalled();
    const failed = await new CatalogSyncService(store, 0, 1).sync(providerId, {
      enumerate: async () => ({
        records: [],
        complete: false,
        paused: true,
        exclusions: [
          { code: 'access-denied', message: 'Current source failure' },
        ],
      }),
    });
    expect(failed).toMatchObject({
      paused: true,
      complete: false,
      cursor: 'next-chunk',
    });
    expect(withdraw).not.toHaveBeenCalled();
    const terminal = await new CatalogSyncService(store, 0, 1).sync(
      providerId,
      {
        enumerate: async ({ cursor, checkpoint }) => {
          expect(cursor).toBe('next-chunk');
          expect(checkpoint.runId).toBe(runId);
          return {
            records: [{ ...old, stableId: 'terminal' }],
            complete: true,
          };
        },
      },
    );
    expect(terminal.complete).toBe(true);
    expect(terminal.failureSummary).toMatchObject({
      currentCount: 0,
      historicalCount: 3,
    });
    expect(
      terminal.failures.find((f) => f.code === 'provider_metadata_unavailable')
        ?.count,
    ).toBe(2);
    expect(records.get('old')?.withdrawn).toBe(true);
    expect(records.get('retained')?.withdrawn).toBe(false);
    expect(withdraw).toHaveBeenCalledOnce();
  });

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
  ])('retains unknown MIME %s and advances with sibling rows', async (type) => {
    const f = setup(type);
    const page = await enumerate(f);
    expect(page.paused).not.toBe(true);
    expect(
      page.records.filter((r) => r.representation?.format === 'unknown'),
    ).toHaveLength(1);
    expect(page.records.some((r) => r.representation?.format === 'pdf')).toBe(
      true,
    );
    expect(
      page.records
        .filter((r) => r.representation?.format === 'unknown')
        .every(
          (r) =>
            r.representation?.mediaType === type &&
            r.availableFormats?.length === 0,
        ),
    ).toBe(true);
    expect(JSON.parse(page.nextCursor ?? '{}').todo).toEqual([
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
