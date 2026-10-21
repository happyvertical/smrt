import { describe, expect, it, vi } from 'vitest';
import {
  type CatalogAcquisitionRecord,
  CatalogAcquisitionService,
} from '../catalog-acquisition-service.js';
import type {
  CatalogSourceRecord,
  CatalogSyncCheckpoint,
} from '../catalog-contracts.js';
import { createPublicIllustrativeMathematicsFirstEditionAdapter } from '../sources/public-illustrative-mathematics-adapter.js';
import {
  IM_ASSET_ORIGIN,
  IM_LICENSE,
  IM_ORIGIN,
  imPagePath,
  parseImFirstEditionPage,
} from '../sources/public-illustrative-mathematics-parser.js';

const id = 'mnoc9b85ajq0ahsu57o36uotfrde';
const path = '/k5/teachers/grade-4/unit-1/lesson-5/preparation.html';
const checkpoint: CatalogSyncCheckpoint = {
  providerId: 'illustrative-mathematics',
  complete: false,
  importedCount: 0,
  failures: [],
};
const pdf = new TextEncoder().encode('%PDF-1.7\nselected student task');
const metadata = {
  etag: '"exact-student-v1"',
  'last-modified': 'Wed, 14 Dec 2022 12:29:18 GMT',
  'content-length': String(pdf.length),
  'content-type': 'application/pdf',
};
const footer = `<footer><p>© 2021 Illustrative Mathematics®. Licensed under <a href="${IM_LICENSE}">CC BY 4.0</a>.</p><p>The name and logo are not subject to the Creative Commons license.</p><p>Images remain under their respective licenses.</p></footer>`;
const row = (label = 'Student Task Statements', asset = id) =>
  `<tr><td>${label}</td><td><a class="im-c-filetype--pdf" href="${IM_ASSET_ORIGIN}/${asset}">pdf</a></td></tr>`;
const page = (rows = row()) =>
  `<title>Lesson 5: More Multiples</title><table>${rows}</table>${footer}`;
function response(
  url: string,
  body: BodyInit | null,
  headers: Record<string, string> = {},
  status = 200,
): Response {
  const result = new Response(body, { headers, status });
  Object.defineProperty(result, 'url', { value: url });
  return result;
}
function fixture(
  options: {
    html?: string;
    head?: Record<string, string>;
    get?: Record<string, string>;
    bytes?: Uint8Array;
    status?: number;
    redirect?: boolean;
  } = {},
) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const address = String(url);
    if (address.startsWith(IM_ORIGIN))
      return response(address, options.html ?? page(), {
        'content-type': 'text/html',
      });
    const result = response(
      options.redirect ? 'https://evil.test/pdf' : address,
      init?.method === 'HEAD' ? null : (options.bytes ?? pdf),
      {
        ...metadata,
        ...(init?.method === 'HEAD' ? options.head : options.get),
      },
      options.status ?? 200,
    );
    return result;
  });
  return {
    fetch,
    adapter: createPublicIllustrativeMathematicsFirstEditionAdapter({ fetch }),
  };
}
const start = (offset = 0) => JSON.stringify({ v: 1, todo: [path], offset });
async function discover(f = fixture()): Promise<CatalogSourceRecord> {
  const result = await f.adapter.enumerate({ cursor: start(), checkpoint });
  expect(result.complete).toBe(true);
  const record = result.records.find((r) =>
    r.availableFormats?.includes('pdf'),
  );
  expect(record).toBeDefined();
  if (!record) throw new Error('Missing student record');
  return record;
}
function acquireInput(record: CatalogSourceRecord) {
  return {
    providerId: record.providerId,
    stableId: record.stableId,
    revision: record.revision,
    format: 'pdf',
  };
}

describe('public first-edition IM metadata and selected acquisition', () => {
  it('ignores transient CSRF markup but binds every relevant source semantic', async () => {
    const base = fixture({
      html: `<meta name="csrf-token" content="one">${page()}`,
    });
    const record = await discover(base);
    const transient = fixture({
      html: `<meta name="csrf-token" content="two">${page()}`,
    });
    expect(
      (await transient.adapter.acquire(acquireInput(record))).bytes,
    ).toEqual(pdf);
    for (const html of [
      page().replace('Student Task Statements', 'Teacher Guide'),
      page().replace(id, `${id}x`),
      page().replace('More Multiples', 'Changed lesson'),
      page().replace('© 2021', '© 2022'),
      page().replace('Images remain', 'Images changed'),
      page().replace('licenses/by/4.0/', 'licenses/by-nc/4.0/'),
    ]) {
      const changed = fixture({ html });
      await expect(
        changed.adapter.acquire(acquireInput(record)),
      ).rejects.toThrow('changed');
      expect(changed.fetch).toHaveBeenCalledTimes(1);
    }
  });
  it('does not claim a malformed empty hierarchy page is complete', async () => {
    const f = fixture({ html: '<html>Upstream structure changed</html>' });
    const result = await f.adapter.enumerate({
      cursor: JSON.stringify({ v: 1, todo: ['/MS/index.html'], offset: 0 }),
      checkpoint,
    });
    expect(result).toMatchObject({
      complete: false,
      paused: true,
      records: [],
    });
  });
  it('rejects invalid revision values before requesting content', async () => {
    const record = await discover();
    const f = fixture();
    for (const revision of [
      { ...JSON.parse(record.revision), etag: 'W/"weak"' },
      { ...JSON.parse(record.revision), length: -1 },
      { ...JSON.parse(record.revision), modified: 'garbage' },
      { ...JSON.parse(record.revision), unknown: true },
    ]) {
      await expect(
        f.adapter.acquire({
          ...acquireInput(record),
          revision: JSON.stringify(revision),
        }),
      ).rejects.toThrow();
    }
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it('rejects PDF signature failures and streamed bytes exceeding declared length', async () => {
    const record = await discover();
    for (const bytes of [
      new TextEncoder().encode(
        `xxxxx${new TextDecoder().decode(pdf.subarray(5))}`,
      ),
      new Uint8Array(pdf.length + 1),
    ]) {
      await expect(
        fixture({ bytes }).adapter.acquire(acquireInput(record)),
      ).rejects.toThrow();
    }
    await expect(
      fixture({ get: { 'content-encoding': 'br' } }).adapter.acquire(
        acquireInput(record),
      ),
    ).rejects.toThrow('encoded');
  });
  it('bounds stalled requests and exposes Retry-After without advancing', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Promise<Response>(() => {}),
    );
    const stalled =
      await createPublicIllustrativeMathematicsFirstEditionAdapter({
        fetch,
        timeoutMs: 5,
      }).enumerate({ cursor: start(), checkpoint });
    expect(stalled).toMatchObject({
      complete: false,
      paused: true,
      nextCursor: start(),
    });
    const limited = await fixture({ status: 429 }).adapter.enumerate({
      cursor: start(),
      checkpoint,
    });
    expect(limited.exclusions?.[0].retryAfterMs).toBe(60000);
  });

  it('emits exact student metadata and attribution with no PDF GET during synchronization', async () => {
    const f = fixture();
    const record = await discover(f);
    expect(record).toMatchObject({
      canonicalUrl: IM_ORIGIN + path,
      title: 'IM k5 Grade 4 Unit 1 Lesson 5 — Student Task Statements',
      gradeRange: { min: '4', max: '4' },
      availableFormats: ['pdf'],
      visibility: 'catalog',
      resourceType: 'student-material',
      parentStableId: `im-first-edition:${path}`,
      licenseEvidence: {
        state: 'verified',
        identifier: 'CC BY',
        version: '4.0',
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
    expect(record.licenseEvidence.attribution).toContain(
      '2021 Illustrative Mathematics',
    );
    expect(record.licenseEvidence.exceptions).toContain('respective licenses');
    expect(
      f.fetch.mock.calls.map(([url, init]) => [String(url), init?.method]),
    ).toEqual([
      [IM_ORIGIN + path, 'GET'],
      [`${IM_ASSET_ORIGIN}/${id}`, 'HEAD'],
    ]);
    expect(
      f.fetch.mock.calls.every(([, init]) => init?.redirect === 'error'),
    ).toBe(true);
  });
  it('supports all three bands, supports courses, linked translations and family hierarchy without navigation cycles', () => {
    for (const [root, link] of [
      ['/k5/curriculum.html', '/K5_ES/teachers/grade-4/units.html'],
      ['/MS/index.html', '/MS/teachers/3/index.html'],
      ['/HS/index.html', '/HS/teachers/4/index.html'],
    ] as const) {
      expect(
        parseImFirstEditionPage(`<a href="${link}">course</a>`, root).children,
      ).toEqual([imPagePath(link).path]);
    }
    for (const [parent, child] of [
      [
        '/k5/teachers/grade-4/units.html',
        '/k5/teachers/grade-4/unit-1/lessons.html',
      ],
      ['/MS/teachers/1/index.html', '/MS/teachers/1/1/index.html'],
      ['/HS/teachers/4/1/index.html', '/HS/teachers/4/1/5/preparation.html'],
      [
        '/k5/families/grade-4/units.html',
        '/k5/families/grade-4/unit-1/family-materials.html',
      ],
      ['/MS/families/1/index.html', '/MS/families/1/1/index.html'],
    ] as const) {
      expect(
        parseImFirstEditionPage(
          `<a href="${child}">child</a><a href="${parent}">self</a>`,
          parent,
        ).children,
      ).toEqual([child]);
    }
    expect(
      parseImFirstEditionPage(
        '<a href="/MS/teachers/1/1/resources.html">resources</a>',
        '/MS/teachers/1/1/index.html',
      ).children,
    ).toEqual(['/MS/teachers/1/1/resources.html']);
    expect(
      parseImFirstEditionPage(
        '<a href="/MS/teachers/1/1/index.html">back</a>',
        '/MS/teachers/1/1/resources.html',
      ).children,
    ).toEqual([]);
  });
  it('classifies explicit table and resource-block labels; teacher, unknown, nonPDF and v360 stay excluded', async () => {
    const html = page(
      row('Teacher Guide') +
        row('Unknown future role', `${id}x`) +
        `<div><h4>Family Support Materials</h4><a class="im-c-filetype--pdf" href="${IM_ASSET_ORIGIN}/${id}y">pdf</a></div><a href="https://accessim.org/">v360</a><a href="/oauth_im/login">login</a><a href="${IM_ASSET_ORIGIN}/${id}z">docx</a>`,
    );
    const result = await fixture({ html }).adapter.enumerate({
      cursor: start(),
      checkpoint,
    });
    expect(
      result.records.filter((r) => r.visibility === 'catalog'),
    ).toHaveLength(1);
    expect(result.exclusions?.map((e) => e.code)).toEqual(
      expect.arrayContaining([
        'teacher_or_unknown_role',
        'different_edition',
        'login_required',
        'unsupported_format',
      ]),
    );
  });
  it.each([
    page().replace(footer, ''),
    page().replace('licenses/by/4.0/', 'licenses/by-nc/4.0/'),
    page().replace('</footer>', '<p>All rights reserved</p></footer>'),
  ])('denies missing or conflicting exact page license without asset requests', async (html) => {
    const f = fixture({ html });
    const result = await f.adapter.enumerate({ cursor: start(), checkpoint });
    expect(result.records.some((r) => r.visibility === 'catalog')).toBe(false);
    expect(
      result.exclusions?.some((e) => e.code === 'unverified_license'),
    ).toBe(true);
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it('resumes bounded artifact chunks in a new adapter, preserving source identity and full terminal coverage', async () => {
    const html = page(
      Array.from({ length: 9 }, (_, i) =>
        row('Student Handouts', `${id}${i}`),
      ).join(''),
    );
    const f = fixture({ html });
    let cursor: string | undefined = start();
    const ids = new Set<string>();
    let terminal = false;
    for (let i = 0; i < 3; i++) {
      const adapter = createPublicIllustrativeMathematicsFirstEditionAdapter({
        fetch: f.fetch,
      });
      const result = await adapter.enumerate({ cursor, checkpoint });
      result.records
        .filter((r) => r.visibility === 'catalog')
        .forEach((r) => {
          ids.add(r.stableId);
        });
      cursor = result.nextCursor;
      terminal = result.complete;
    }
    expect(terminal).toBe(true);
    expect(ids.size).toBe(9);
    expect(
      f.fetch.mock.calls.filter(([, init]) => init?.method === 'HEAD'),
    ).toHaveLength(9);
  });
  it.each([
    'garbage',
    '{}',
    '{"v":2,"todo":["/"],"offset":0}',
    JSON.stringify({ v: 1, todo: ['https://evil.test/'], offset: 0 }),
    JSON.stringify({ v: 1, todo: [path], offset: 1 }),
    'x'.repeat(64001),
  ])('fails closed on malformed cursor before network', async (cursor) => {
    const f = fixture();
    const result = await f.adapter.enumerate({ cursor, checkpoint });
    expect(result).toMatchObject({
      complete: false,
      paused: true,
      records: [],
    });
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it('fails safely on page changes during resumable chunks', async () => {
    const f = fixture({
      html: page(
        Array.from({ length: 5 }, (_, i) =>
          row('Student Handouts', `${id}${i}`),
        ).join(''),
      ),
    });
    const first = await f.adapter.enumerate({ cursor: start(), checkpoint });
    const changed = fixture({ html: page() });
    const result = await changed.adapter.enumerate({
      cursor: first.nextCursor,
      checkpoint,
    });
    expect(result).toMatchObject({
      complete: false,
      paused: true,
      records: [],
    });
    expect(result.exclusions?.[0].message).toContain('changed');
  });
  it('acquires only selected bytes with conditional strong validators and SHA256', async () => {
    const f = fixture();
    const record = await discover(f);
    const result = await f.adapter.acquire(acquireInput(record));
    expect(result.bytes).toEqual(pdf);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.revision).toBe(record.revision);
    expect(f.fetch.mock.calls.at(-1)?.[1]?.headers).toMatchObject({
      'if-match': metadata.etag,
      'if-unmodified-since': metadata['last-modified'],
    });
  });
  it.each([
    { get: { etag: '"changed"' } },
    { get: { etag: 'W/"weak"' } },
    { get: { 'content-type': 'text/html' } },
    { get: { 'content-length': '1000000000' } },
    { get: { 'last-modified': 'Thu, 15 Dec 2022 12:29:18 GMT' } },
    { redirect: true },
    { status: 412 },
    { bytes: new TextEncoder().encode('<html>not a pdf</html>') },
  ])('rejects changed or unsafe selected PDF response %j', async (options) => {
    const record = await discover();
    await expect(
      fixture(options).adapter.acquire(acquireInput(record)),
    ).rejects.toThrow();
  });
  it.each([
    { head: { etag: '' } },
    { head: { etag: 'W/"weak"' } },
    { head: { 'content-length': '-1' } },
    { head: { 'last-modified': '' } },
    { head: { 'content-type': 'text/html' } },
    { status: 429 },
  ])('does not advance after unavailable/malformed HEAD %j', async (options) => {
    const result = await fixture(options).adapter.enumerate({
      cursor: start(),
      checkpoint,
    });
    expect(result).toMatchObject({
      records: [],
      complete: false,
      paused: true,
      nextCursor: start(),
    });
  });
  it('rejects hostile identity and redirects, and caps streamed undeclared metadata', async () => {
    const f = fixture();
    await expect(
      f.adapter.acquire({
        providerId: checkpoint.providerId,
        stableId: `im-first-edition:https://evil.test/#${id}`,
        revision: '{}',
        format: 'pdf',
      }),
    ).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      response(String(url), 'x'.repeat(2_000_001), {
        'content-type': 'text/html',
      }),
    );
    const result = await createPublicIllustrativeMathematicsFirstEditionAdapter(
      { fetch },
    ).enumerate({ cursor: start(), checkpoint });
    expect(result).toMatchObject({
      records: [],
      complete: false,
      paused: true,
    });
  });
  it('bounds the entire operation including a stalled body read', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      response(String(url), new ReadableStream({ start() {} }), {
        'content-type': 'text/html',
      }),
    );
    const result = await createPublicIllustrativeMathematicsFirstEditionAdapter(
      { fetch, timeoutMs: 5 },
    ).enumerate({ cursor: start(), checkpoint });
    expect(result).toMatchObject({ complete: false, paused: true });
    expect(result.exclusions?.[0].message).toContain('timed out');
  });
  it('uses generic acquisition policy/idempotence and preserves notices with one private write', async () => {
    const f = fixture();
    const resource = {
      ...(await discover(f)),
      id: 'resource',
      withdrawnAt: null,
    };
    let saved: CatalogAcquisitionRecord | undefined;
    const createAcquisition = vi.fn(async (input) => {
      saved = { ...input, id: 'acquired' };
      return saved;
    });
    const service = new CatalogAcquisitionService(
      {
        getResource: async () => resource,
        getSelection: async ({ tenantId }) =>
          tenantId === 'family'
            ? {
                id: 'selection',
                tenantId,
                resourceId: 'resource',
                selectedRevision: resource.revision,
              }
            : undefined,
        findAcquisition: async () => saved,
        createAcquisition,
      },
      f.adapter,
    );
    const request = {
      tenantId: 'family',
      actorUserId: 'guardian',
      roles: ['guardian'],
      resourceId: 'resource',
      selectionId: 'selection',
      revision: resource.revision,
      format: 'pdf',
      operation: 'print' as const,
    };
    const acquired = await service.acquire(request);
    expect(await service.acquire(request)).toBe(acquired);
    expect(createAcquisition).toHaveBeenCalledTimes(1);
    expect(acquired.notices).toContain('respective licenses');
    expect(
      f.fetch.mock.calls.filter(
        ([url, init]) =>
          String(url).startsWith(IM_ASSET_ORIGIN) && init?.method === 'GET',
      ),
    ).toHaveLength(1);
    await expect(
      service.acquire({ ...request, tenantId: 'sibling' }),
    ).rejects.toThrow('matching tenant selection');
  });
});
