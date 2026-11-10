import { describe, expect, it, vi } from 'vitest';
import type { CatalogSyncCheckpoint } from '../catalog-contracts.js';
import {
  CatalogSyncService,
  type CatalogSyncStore,
} from '../catalog-sync-service.js';
import {
  createOerCommonsRssAdapter,
  createPublicIllustrativeMathematicsK5Adapter,
} from '../hearth-catalog-providers.js';
import {
  GoogleDriveCurriculumAdapter,
  type GoogleDriveFilesClient,
} from '../sources/google-drive-adapter.js';
import { createPublicIllustrativeMathematicsFirstEditionAdapter } from '../sources/public-illustrative-mathematics-adapter.js';
import {
  IM_ASSET_ORIGIN,
  IM_LICENSE,
  IM_ORIGIN,
  parseImFirstEditionPage,
} from '../sources/public-illustrative-mathematics-parser.js';

const providerId = 'illustrative-mathematics';
const lesson = '/k5/teachers/grade-4/unit-1/lesson-5/preparation.html';
const id = 'mnoc9b85ajq0ahsu57o36uotfrde';
const otherId = `${id}x`;
const bytes = new TextEncoder().encode('%PDF-1.7\nstudent');
const footer = `<footer><p>© 2021 Illustrative Mathematics. Licensed under <a href="${IM_LICENSE}">CC BY 4.0</a>.</p></footer>`;
const link = (asset = id) =>
  `<a class="im-c-filetype--pdf" href="${IM_ASSET_ORIGIN}/${asset}">pdf</a>`;
const block = (asset = id) =>
  `<div class="im-c-row__flex-resource"><h4 class="im-c-row__resource">Student Task Statements</h4>${link(asset)}</div>`;
const page = (body: string) => `<title>Exact lesson</title>${body}${footer}`;
const checkpoint: CatalogSyncCheckpoint = {
  providerId,
  complete: false,
  importedCount: 0,
  failures: [],
};
const cursor = (path = lesson) =>
  JSON.stringify({ v: 1, todo: [path], offset: 0 });
function setup(pages: Record<string, string>) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const address = String(url);
    const content = address.startsWith(IM_ORIGIN)
      ? pages[address.slice(IM_ORIGIN.length)]
      : undefined;
    if (address.startsWith(IM_ORIGIN) && content === undefined)
      throw new Error(`Unexpected metadata path ${address}`);
    const response = new Response(
      address.startsWith(IM_ORIGIN)
        ? content
        : init?.method === 'HEAD'
          ? null
          : bytes,
      {
        headers: address.startsWith(IM_ORIGIN)
          ? { 'content-type': 'text/html' }
          : {
              'content-type': 'application/pdf',
              etag: '"pinned"',
              'last-modified': 'Wed, 14 Dec 2022 12:29:18 GMT',
              'content-length': String(bytes.length),
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
function memory(seed?: CatalogSyncCheckpoint) {
  let current = seed;
  const saves: CatalogSyncCheckpoint[] = [];
  const withdrawUnseen = vi.fn(async () => 0);
  const store: CatalogSyncStore = {
    getCheckpoint: async () => current,
    saveCheckpoint: async (value) => {
      current = JSON.parse(JSON.stringify(value));
      saves.push(JSON.parse(JSON.stringify(value)));
    },
    upsert: vi.fn(async () => {}),
    withdrawUnseen,
  };
  return {
    store,
    saves,
    withdrawUnseen,
    get current() {
      return current;
    },
  };
}

describe('round4 accepted IM blockers', () => {
  it('F1: fails closed rather than rounding an unsafe aggregate occurrence total', async () => {
    const state = memory({
      ...checkpoint,
      cursor: 'retry',
      failures: [
        { code: 'same', message: 'historic', count: Number.MAX_SAFE_INTEGER },
      ],
    });
    await expect(
      new CatalogSyncService(state.store, 0, 1).sync(providerId, {
        enumerate: async () => ({
          records: [],
          complete: false,
          paused: true,
          exclusions: [{ code: 'same', message: 'new error' }],
        }),
      }),
    ).rejects.toThrow('safe integer bound');
    expect(state.saves).toEqual([]);
    expect(state.withdrawUnseen).not.toHaveBeenCalled();
  });

  it.each([
    'coarse-k5',
    'unconfirmed-oer',
  ])('F1 compatibility: preserves valid %s records while pausing unconfirmed coverage', async (source) => {
    const state = memory();
    const html = [
      'kindergarten',
      'grade-1',
      'grade-2',
      'grade-3',
      'grade-4',
      'grade-5',
    ]
      .map((grade) => `<a href="/K5/families/${grade}/units.html">${grade}</a>`)
      .join('');
    const fetch = async (url: string) => ({
      ok: true,
      status: 200,
      url,
      headers: {
        get: (key: string) => (key === 'etag' ? 'source-revision' : null),
      },
      text: async () =>
        source === 'coarse-k5'
          ? html
          : '<rss><channel><item><guid>oer-1</guid><title>Fractions</title><link>https://www.oercommons.org/courseware/lesson/1</link></item></channel></rss>',
    });
    const adapter =
      source === 'coarse-k5'
        ? createPublicIllustrativeMathematicsK5Adapter({ fetch })
        : createOerCommonsRssAdapter({
            fetch,
            feedUrl: 'https://authorized.example/oer.rss',
          });
    const result = await new CatalogSyncService(state.store, 0, 1).sync(
      source === 'coarse-k5' ? providerId : 'oer-commons',
      adapter,
    );
    expect(result).toMatchObject({
      complete: false,
      paused: true,
      failures: [],
      exclusionSummary: {
        total: 1,
        byCode: [{ code: 'partial_provider_coverage', count: 1 }],
        otherCount: 0,
      },
      failureSummary: { currentCount: 0, total: 0 },
    });
    expect(state.store.upsert).toHaveBeenCalledTimes(
      source === 'coarse-k5' ? 6 : 1,
    );
    expect(state.withdrawUnseen).not.toHaveBeenCalled();
  });
  it.each([
    'policy-shortcut',
    'policy-outside-boundary',
    'missing-revision',
    'inaccessible-target',
  ])('F1 compatibility: distinguishes Drive %s policy from current operational errors', async (reason) => {
    const good = {
      id: 'valid',
      name: 'Worksheet',
      mimeType: 'application/pdf',
      parents: ['root'],
      revisionId: 'rev1',
    };
    const entry =
      reason === 'missing-revision'
        ? {
            id: 'broken',
            name: 'No revision',
            mimeType: 'application/pdf',
            parents: ['root'],
          }
        : {
            ...good,
            id: 'shortcut',
            mimeType: 'application/vnd.google-apps.shortcut',
            shortcutDetails: {
              targetId: 'other',
              targetMimeType:
                reason === 'policy-shortcut'
                  ? 'application/pdf'
                  : 'application/vnd.google-apps.folder',
            },
          };
    const drive: GoogleDriveFilesClient = {
      listMetadataPage: vi.fn(async () => ({ entries: [good, entry] })),
      getMetadataById: vi.fn(async () => {
        if (reason === 'policy-outside-boundary')
          return {
            id: 'other',
            name: 'Outside',
            mimeType: 'application/vnd.google-apps.folder',
            parents: [],
            revisionId: 'outside-rev',
          };
        throw new Error('No access');
      }),
      acquireById: vi.fn(async () => {
        throw new Error('Discovery must not acquire');
      }),
    };
    const state = memory();
    const adapter = new GoogleDriveCurriculumAdapter(drive, {
      roots: [{ id: 'root' }],
    });
    const result = await new CatalogSyncService(state.store, 0, 1).sync(
      'google-drive',
      adapter,
    );
    if (reason.startsWith('policy-')) {
      expect(result).toMatchObject({
        complete: true,
        failures: [],
        exclusionSummary: {
          total: 1,
          byCode: [
            {
              code:
                reason === 'policy-shortcut'
                  ? 'shortcut-target-unsupported'
                  : 'shortcut-target-outside-boundary',
              count: 1,
            },
          ],
        },
      });
      expect(state.store.upsert).toHaveBeenCalledTimes(
        reason === 'policy-shortcut' ? 1 : 2,
      );
      expect(state.withdrawUnseen).toHaveBeenCalledOnce();
    } else {
      expect(result).toMatchObject({
        complete: false,
        paused: true,
        failureSummary: { currentCount: 1 },
      });
      expect(state.store.upsert).not.toHaveBeenCalled();
      expect(state.withdrawUnseen).not.toHaveBeenCalled();
    }
    expect(drive.acquireById).not.toHaveBeenCalled();
  });

  it('P1: malformed, unclosed and over-deep role structures fail closed', async () => {
    for (const body of [
      `<div data-class="im-c-row__flex-resource"><h4>Student Task Statements</h4>${link()}</div>`,
      `<div class="im-c-row__flex-resource"><h4>Student Task Statements</h4>${link()}`,
      `<div class="im-c-row__flex-resource"><h4>Student Task Statements</h4><span>${link()}</div>`,
    ])
      expect(
        parseImFirstEditionPage(page(body), lesson).artifacts[0]?.allowed,
      ).toBe(false);
    const f = setup({
      [lesson]: page('<div>'.repeat(258) + block() + '</div>'.repeat(258)),
    });
    const result = await f.adapter.enumerate({ cursor: cursor(), checkpoint });
    expect(result).toMatchObject({
      complete: false,
      paused: true,
      records: [],
    });
    expect(f.fetch.mock.calls).toHaveLength(1);
  });
  it('F1: report policy codes never expose malformed path-like values', async () => {
    const state = memory();
    const result = await new CatalogSyncService(state.store, 0, 1).sync(
      providerId,
      {
        enumerate: async () => ({
          records: [],
          complete: true,
          policyExclusions: [
            { code: 'https://private.example/path', message: 'not forwarded' },
          ],
        }),
      },
    );
    expect(result.exclusionSummary).toEqual({
      total: 1,
      byCode: [{ code: 'invalid-policy-code', count: 1 }],
      otherCount: 0,
    });
    expect(state.current?.failures).toEqual([]);
  });

  it('F1: legacy coarse no-cursor history resumes the new adapter root and withdraws only at actual terminal', async () => {
    const state = memory({
      ...checkpoint,
      importedCount: 6,
      failures: [
        {
          code: 'partial_provider_coverage',
          message: 'Old coarse index covered six grades.',
        },
      ],
    });
    const paths = [
      '/k5/teachers/grade-4/units.html',
      '/MS/teachers/1/index.html',
      '/HS/teachers/1/index.html',
    ];
    const units = [
      '/k5/teachers/grade-4/unit-1/lessons.html',
      '/MS/teachers/1/1/index.html',
      '/HS/teachers/1/1/index.html',
    ];
    const lessons = [
      lesson,
      '/MS/teachers/1/1/1/preparation.html',
      '/HS/teachers/1/1/1/preparation.html',
    ];
    const pages: Record<string, string> = { '/': page('') };
    ['/k5/curriculum.html', '/MS/index.html', '/HS/index.html'].forEach(
      (root, i) => {
        pages[root] = page(`<a href="${paths[i]}">Course</a>`);
        pages[paths[i]] = page(`<a href="${units[i]}">Unit</a>`);
        pages[units[i]] = page(`<a href="${lessons[i]}">Lesson</a>`);
        pages[lessons[i]] = page(
          `<table><tr><td>Student Handouts</td><td>${link()}</td></tr></table>`,
        );
      },
    );
    const f = setup(pages);
    let terminal = false;
    for (let i = 0; i < 20 && !terminal; i++) {
      const result = await new CatalogSyncService(state.store, 0, 1).sync(
        providerId,
        f.adapter,
      );
      expect(result.failureSummary).toMatchObject({
        historical: true,
        historicalCount: 1,
        currentCount: 0,
        total: 1,
      });
      expect(result.failures[0].code).toBe('partial_provider_coverage');
      expect(result.paused).not.toBe(true);
      terminal = result.complete;
      if (!terminal) expect(state.withdrawUnseen).not.toHaveBeenCalled();
    }
    expect(f.fetch.mock.calls[0][0]).toBe(`${IM_ORIGIN}/`);
    expect(terminal).toBe(true);
    expect(state.withdrawUnseen).toHaveBeenCalledOnce();
    expect(state.current?.importedCount).toBeGreaterThan(6);
  });
  it('F1: rejects a current operational error on an otherwise terminal page without advancing or writing resources', async () => {
    const state = memory({ ...checkpoint, cursor: 'retry', runId: 'run' });
    const result = await new CatalogSyncService(state.store, 0, 1).sync(
      providerId,
      {
        enumerate: async () => ({
          records: [
            {
              providerId,
              stableId: 'bad-partial',
              revision: 'v1',
              canonicalUrl: IM_ORIGIN,
              title: 'partial',
              visibility: 'teacher',
              licenseEvidence: { state: 'unknown' },
            },
          ],
          complete: true,
          exclusions: [
            { code: 'parse-failed', message: 'Current malformed response' },
          ],
        }),
      },
    );
    expect(result).toMatchObject({
      complete: false,
      paused: true,
      cursor: 'retry',
      failureSummary: { currentCount: 1, historicalCount: 0, total: 1 },
    });
    expect(state.store.upsert).not.toHaveBeenCalled();
    expect(state.withdrawUnseen).not.toHaveBeenCalled();
  });
  it('F1: preserves valid weighted counts and explicitly handles malformed legacy count values', async () => {
    const state = memory({
      ...checkpoint,
      cursor: 'retry',
      failures: [
        { code: 'same', message: 'same fact', count: 5 },
        { code: 'same', message: 'same fact', count: 3 },
        { code: 'invalid-a', message: 'legacy', count: -5 },
        { code: 'invalid-b', message: 'legacy', count: Number.NaN },
      ],
    });
    const result = await new CatalogSyncService(state.store, 0, 1).sync(
      providerId,
      {
        enumerate: async () => ({
          records: [],
          complete: false,
          paused: true,
          exclusions: [{ code: 'active', message: 'failed' }],
        }),
      },
    );
    expect(result.failureSummary).toMatchObject({
      historicalCount: 10,
      currentCount: 1,
      total: 11,
    });
    expect(result.failures.find((f) => f.code === 'same')).toMatchObject({
      count: 8,
      omittedDetailCount: 0,
    });
    expect(
      result.failures
        .filter((f) => f.code.startsWith('invalid-'))
        .every((f) =>
          f.message.includes('Invalid legacy occurrence count; counted once.'),
        ),
    ).toBe(true);
    expect(state.withdrawUnseen).not.toHaveBeenCalled();
  });
  it('F1: compacts oversized diagnostic text explicitly without truncating the durable resume cursor', async () => {
    const resume = 'r'.repeat(1000);
    const state = memory({
      ...checkpoint,
      cursor: resume,
      failures: [
        { code: 'legacy', message: 'm'.repeat(2000), cursor: 'x'.repeat(1000) },
      ],
    });
    const result = await new CatalogSyncService(state.store, 0, 1).sync(
      providerId,
      {
        enumerate: async ({ cursor }) => {
          expect(cursor).toBe(resume);
          return {
            records: [],
            complete: false,
            paused: true,
            exclusions: [{ code: 'failed', message: 'current' }],
          };
        },
      },
    );
    expect(result.cursor).toBe(resume);
    expect(result.failures[0].message.length).toBeLessThanOrEqual(512);
    expect(result.failures[0].cursor?.length).toBeLessThanOrEqual(256);
    expect(result.failures[0].omittedDetailCount).toBe(1);
  });

  it.each([
    '<h2>Teacher Guide</h2>',
    '<p>Teacher Guide</p>',
    '',
  ])('P1: does not inherit a student label into a separate unknown or teacher section: %s', async (teacherHeading) => {
    const html = page(
      `${block()}<section>${teacherHeading}${link(otherId)}</section>`,
    );
    const parsed = parseImFirstEditionPage(html, lesson);
    expect(parsed.artifacts.find((a) => a.id === otherId)?.allowed).toBe(false);
    const f = setup({ [lesson]: html });
    const result = await f.adapter.enumerate({ cursor: cursor(), checkpoint });
    expect(
      result.records
        .filter((r) => r.visibility === 'catalog')
        .map((r) => r.stableId),
    ).toEqual([`im-first-edition:${lesson}#${id}`]);
    expect(
      f.fetch.mock.calls.some(([url]) => String(url).endsWith(otherId)),
    ).toBe(false);
  });
  it('P1: denies nested ambiguous contexts but preserves exact official table and block positives', () => {
    for (const body of [
      `<table><tr><td>Student Handouts</td><h2>Teacher Guide</h2><td>${link()}</td></tr></table>`,
      `<div class="im-c-row__flex-resource"><h4>Student Task Statements</h4><section><h2>Teacher Guide</h2>${link()}</section></div>`,
      `<div class="im-c-row__flex-resource"><h4>Student Task Statements</h4><h2>Teacher Guide</h2>${link()}</div>`,
      `<div class="im-c-row__flex-resource"><h4>Student Task Statements</h4><h4>Family Materials</h4>${link()}</div>`,
    ])
      expect(
        parseImFirstEditionPage(page(body), lesson).artifacts[0]?.allowed,
      ).toBe(false);
    for (const body of [
      block(),
      `<table><tr><td>Student Handouts</td><td>${link()}</td></tr></table>`,
    ])
      expect(
        parseImFirstEditionPage(page(body), lesson).artifacts[0]?.allowed,
      ).toBe(true);
  });
  it('P1: rejects a previously selected PDF moved into an unlabeled teacher section before any PDF GET', async () => {
    const original = setup({ [lesson]: page(block()) });
    const found = await original.adapter.enumerate({
      cursor: cursor(),
      checkpoint,
    });
    const selected = found.records.find((r) => r.visibility === 'catalog');
    if (!selected) throw new Error('Missing valid student fixture');
    const changed = setup({
      [lesson]: page(
        `<div class="im-c-row__flex-resource"><h4>Student Task Statements</h4></div><section><h2>Teacher Guide</h2>${link()}</section>`,
      ),
    });
    await expect(
      changed.adapter.acquire({
        providerId,
        stableId: selected.stableId,
        revision: selected.revision,
        format: 'pdf',
      }),
    ).rejects.toThrow('changed');
    expect(changed.fetch.mock.calls).toHaveLength(1);
  });
  it('P2: resumes course to intermediate family unit to family materials without reverse cycles or PDF GET', async () => {
    const course = '/k5/families/grade-4/units.html';
    const unit = '/k5/families/grade-4/unit-1/lessons.html';
    const family = '/k5/families/grade-4/unit-1/family-materials.html';
    const f = setup({
      [course]: page(`<a href="${unit}">Unit1</a>`),
      [unit]: page(
        `<a href="${family}">Family materials</a><a href="${course}">back</a><a href="${unit}">self</a>`,
      ),
      [family]: page(
        `<table><tr><td>Family Materials</td><td>${link()}</td></tr></table><a href="${unit}">back</a><a href="${family}">self</a>`,
      ),
    });
    let next = cursor(course);
    let complete = false;
    const paths: string[] = [];
    const records = [];
    for (let i = 0; i < 3; i++) {
      const fresh = createPublicIllustrativeMathematicsFirstEditionAdapter({
        fetch: f.fetch,
      });
      const result = await fresh.enumerate({ cursor: next, checkpoint });
      records.push(...result.records);
      complete = result.complete;
      paths.push(JSON.parse(next).todo[0]);
      next = result.nextCursor ?? '';
    }
    expect(paths).toEqual([course, unit, family]);
    expect(complete).toBe(true);
    expect(next).toBe('');
    expect(records.filter((r) => r.visibility === 'catalog')).toHaveLength(1);
    expect(
      f.fetch.mock.calls.filter(
        ([url, init]) =>
          String(url).startsWith(IM_ASSET_ORIGIN) && init?.method === 'GET',
      ),
    ).toHaveLength(0);
  });
  it('F1: emits page-wide policy exclusions once across artifact chunks and keeps healthy durable failures empty', async () => {
    const rows = Array.from(
      { length: 9 },
      (_, i) =>
        `<tr><td>Student Handouts</td><td>${link(`${id}${i}`)}</td></tr>`,
    ).join('');
    const f = setup({
      [lesson]: page(
        `<a href="/oauth_im/login">Sign in</a><table>${rows}</table>`,
      ),
    });
    const state = memory({
      ...checkpoint,
      cursor: cursor(),
      runId: 'same-run',
    });
    const reports = [];
    for (let i = 0; i < 3; i++)
      reports.push(
        await new CatalogSyncService(state.store, 0, 1).sync(
          providerId,
          f.adapter,
        ),
      );
    expect(reports.map((r) => r.exclusionSummary?.total)).toEqual([1, 0, 0]);
    expect(reports.every((r) => r.failures.length === 0)).toBe(true);
    expect(state.current?.failures).toEqual([]);
    expect(reports.at(-1)?.complete).toBe(true);
    expect(state.withdrawUnseen).toHaveBeenCalledOnce();
  });
  it('F1: policy summaries are bounded report-only counts across multiple pages and resumes', async () => {
    const state = memory();
    let calls = 0;
    const adapter = {
      enumerate: async () => {
        calls++;
        return {
          records: [],
          complete: calls === 4,
          nextCursor: calls < 4 ? String(calls) : undefined,
          policyExclusions: Array.from({ length: 100 }, (_, i) => ({
            code: `policy-${i}`,
            message: `Excluded ${i}`,
          })),
        };
      },
    };
    const first = await new CatalogSyncService(state.store, 0, 2).sync(
      providerId,
      adapter,
    );
    const terminal = await new CatalogSyncService(state.store, 0, 2).sync(
      providerId,
      adapter,
    );
    for (const report of [first, terminal]) {
      expect(report.failures).toEqual([]);
      expect(report.exclusionSummary?.total).toBe(200);
      expect(report.exclusionSummary?.byCode.length).toBeLessThanOrEqual(32);
      expect(
        (report.exclusionSummary?.byCode.reduce((sum, x) => sum + x.count, 0) ??
          0) + (report.exclusionSummary?.otherCount ?? 0),
      ).toBe(200);
    }
    expect(state.saves.every((s) => !('exclusionSummary' in s))).toBe(true);
    expect(terminal.complete).toBe(true);
  });
  it('F1: bounds historical failure facts explicitly and preserves counts, cursor and real pause without withdrawal', async () => {
    const seed = {
      ...checkpoint,
      cursor: 'resume',
      runId: 'legacy-run',
      importedCount: 7,
      failures: Array.from({ length: 200 }, (_, i) => ({
        code: `legacy-${i % 40}`,
        message: `Historical fact ${i}`,
        cursor: `old-${i}`,
      })),
    };
    const state = memory(seed);
    const result = await new CatalogSyncService(state.store, 0, 1).sync(
      providerId,
      {
        enumerate: async () => ({
          records: [],
          complete: false,
          paused: true,
          nextCursor: 'resume',
          exclusions: [{ code: 'upstream-failed', message: 'HTTP 503' }],
        }),
      },
    );
    expect(result).toMatchObject({
      complete: false,
      paused: true,
      cursor: 'resume',
      runId: 'legacy-run',
      importedCount: 7,
    });
    expect(result.failures.length).toBeLessThanOrEqual(32);
    expect(result.failures.reduce((sum, f) => sum + (f.count ?? 1), 0)).toBe(
      201,
    );
    expect(result.failures.some((f) => f.omittedDetailCount)).toBe(true);
    expect(result.failureSummary?.historical).toBe(true);
    expect(state.withdrawUnseen).not.toHaveBeenCalled();
    const resumed = await new CatalogSyncService(state.store, 0, 1).sync(
      providerId,
      {
        enumerate: async () => ({
          records: [],
          complete: false,
          paused: true,
          nextCursor: 'resume',
          exclusions: [{ code: 'upstream-failed', message: 'HTTP 503' }],
        }),
      },
    );
    expect(resumed.failures.reduce((sum, f) => sum + (f.count ?? 1), 0)).toBe(
      202,
    );
    expect(resumed.failures.length).toBeLessThanOrEqual(32);
  });
});

describe('round5 localized descendant-heading blocker', () => {
  const nestedCases = [1, 2, 3, 4, 5, 6].flatMap((level) =>
    ['before', 'after'].map((position) => ({ level, position })),
  );
  it.each(
    nestedCases,
  )('denies nested h$level $position a direct PDF before any asset request', async ({
    level,
    position,
  }) => {
    const nested = `<div><section><h${level}>Teacher Guide</h${level}></section></div>`;
    const body = `<div class="im-c-row__flex-resource"><h4>Student Task Statements</h4>${position === 'before' ? nested : ''}${link()}${position === 'after' ? nested : ''}</div>`;
    const html = page(body);
    expect(parseImFirstEditionPage(html, lesson).artifacts[0]?.allowed).toBe(
      false,
    );
    const f = setup({ [lesson]: html });
    const result = await f.adapter.enumerate({ cursor: cursor(), checkpoint });
    expect(
      result.records.filter((record) => record.visibility === 'catalog'),
    ).toEqual([]);
    expect(
      result.policyExclusions?.some(
        (omission) => omission.code === 'teacher_or_unknown_role',
      ),
    ).toBe(true);
    expect(f.fetch.mock.calls).toHaveLength(1);
  });
  it('rejects an old selected revision after a nested sibling teacher heading appears, without a PDF GET', async () => {
    const original = setup({ [lesson]: page(block()) });
    const found = await original.adapter.enumerate({
      cursor: cursor(),
      checkpoint,
    });
    const selected = found.records.find(
      (record) => record.visibility === 'catalog',
    );
    if (!selected)
      throw new Error('Valid official resource-block fixture missing');
    const changed = setup({
      [lesson]: page(
        `<div class="im-c-row__flex-resource"><h4 class="im-c-row__resource">Student Task Statements</h4><div><h4>Teacher Guide</h4></div>${link()}</div>`,
      ),
    });
    await expect(
      changed.adapter.acquire({
        providerId,
        stableId: selected.stableId,
        revision: selected.revision,
        format: 'pdf',
      }),
    ).rejects.toThrow('changed');
    expect(changed.fetch.mock.calls).toHaveLength(1);
  });
  it('preserves direct sole labels and rejects a sole nested label or heading hidden behind a nested resource block', () => {
    for (const body of [
      block(),
      `<table><tr><td>Student Task Statements</td><td>${link()}</td></tr></table>`,
    ]) {
      expect(
        parseImFirstEditionPage(page(body), lesson).artifacts[0]?.allowed,
      ).toBe(true);
    }
    for (const body of [
      `<div class="im-c-row__flex-resource"><div><h4>Student Task Statements</h4></div>${link()}</div>`,
      `<div class="im-c-row__flex-resource"><h4>Student Task Statements</h4><div class="im-c-row__flex-resource"><h4>Teacher Guide</h4></div>${link()}</div>`,
    ])
      expect(
        parseImFirstEditionPage(page(body), lesson).artifacts[0]?.allowed,
      ).toBe(false);
  });
  it.each([
    'missing-revision',
    'inaccessible-target',
  ])('Drive contract recovery: same adapter and cursor resume after fixture %s metadata is repaired', async (reason) => {
    let repaired = false;
    const good = {
      id: 'valid',
      name: 'Worksheet',
      mimeType: 'application/pdf',
      parents: ['root'],
      revisionId: 'valid-rev',
    };
    const drive: GoogleDriveFilesClient = {
      listMetadataPage: vi.fn(async ({ folderId, pageToken } = {}) => {
        if (folderId === 'other') return { entries: [] };
        if (pageToken === 'next')
          return {
            entries: [{ ...good, id: 'later', revisionId: 'later-rev' }],
          };
        const entry =
          reason === 'missing-revision'
            ? {
                id: 'broken',
                name: 'Revision repaired in source',
                mimeType: 'application/pdf',
                parents: ['root'],
                ...(repaired ? { revisionId: 'repaired-rev' } : {}),
              }
            : {
                ...good,
                id: 'shortcut',
                mimeType: 'application/vnd.google-apps.shortcut',
                shortcutDetails: {
                  targetId: 'other',
                  targetMimeType: 'application/vnd.google-apps.folder',
                },
              };
        return { entries: [good, entry], nextPageToken: 'next' };
      }),
      getMetadataById: vi.fn(async () => {
        if (!repaired) throw new Error('Source target inaccessible');
        return {
          id: 'other',
          name: 'Reauthorized target',
          mimeType: 'application/vnd.google-apps.folder',
          parents: [],
          revisionId: 'target-rev',
        };
      }),
      acquireById: vi.fn(async () => {
        throw new Error('Metadata recovery must not acquire content');
      }),
    };
    const initialCursor = Buffer.from(
      JSON.stringify({
        version: 1,
        roots: ['root'],
        pendingFolders: [{ folderId: 'root', visibility: 'catalog' }],
        visitedFolders: [],
      }),
    ).toString('base64url');
    let current: CatalogSyncCheckpoint = {
      providerId: 'google-drive',
      cursor: initialCursor,
      runId: 'same-recovery-run',
      importedCount: 1,
      failures: [],
      complete: false,
    };
    const rows = new Map([['existing', 'old-run']]);
    const withdraw = vi.fn(async (_providerId: string, runId: string) => {
      let count = 0;
      for (const [stableId, seenRun] of rows)
        if (seenRun !== runId) {
          rows.delete(stableId);
          count++;
        }
      return count;
    });
    const store: CatalogSyncStore = {
      getCheckpoint: async () => current,
      saveCheckpoint: async (value) => {
        current = value;
      },
      upsert: vi.fn(async (record, runId) => {
        rows.set(record.stableId, runId);
      }),
      withdrawUnseen: withdraw,
    };
    const adapter = new GoogleDriveCurriculumAdapter(drive, {
      roots: [{ id: 'root' }],
      authorizeShortcutTarget: async () => true,
    });
    const paused = await new CatalogSyncService(store, 0, 1).sync(
      'google-drive',
      adapter,
    );
    expect(paused).toMatchObject({
      paused: true,
      complete: false,
      cursor: initialCursor,
      runId: 'same-recovery-run',
      failureSummary: { currentCount: 1 },
    });
    expect([...rows]).toEqual([['existing', 'old-run']]);
    expect(withdraw).not.toHaveBeenCalled();
    expect(store.upsert).not.toHaveBeenCalled();
    repaired = true;
    const resumed = await new CatalogSyncService(store, 0, 1).sync(
      'google-drive',
      adapter,
    );
    expect(resumed).toMatchObject({
      complete: false,
      paused: false,
      runId: 'same-recovery-run',
      failureSummary: { currentCount: 0, historicalCount: 1 },
    });
    expect(drive.listMetadataPage).toHaveBeenNthCalledWith(1, {
      folderId: 'root',
    });
    expect(drive.listMetadataPage).toHaveBeenNthCalledWith(2, {
      folderId: 'root',
    });
    expect(rows.has('existing')).toBe(true);
    expect(withdraw).not.toHaveBeenCalled();
    let terminal = resumed;
    for (let step = 0; step < 3 && !terminal.complete; step++) {
      terminal = await new CatalogSyncService(store, 0, 1).sync(
        'google-drive',
        adapter,
      );
      if (!terminal.complete) {
        expect(rows.has('existing')).toBe(true);
        expect(withdraw).not.toHaveBeenCalled();
      }
    }
    expect(terminal.complete).toBe(true);
    expect(withdraw).toHaveBeenCalledOnce();
    expect(rows.has('later')).toBe(true);
    expect(drive.acquireById).not.toHaveBeenCalled();
  });
});

describe('round6 malformed descendant owner invariants', () => {
  const lexicalCases = [
    `<div class="im-c-row__flex-resource"><h4>Student Task Statements</h4><span data-x=<h4>Teacher Guide</span>${link()}</div>`,
    `<div class="im-c-row__flex-resource" data-x=<h4><h4>Student Task Statements</h4>${link()}</div>`,
    `<div class="im-c-row__flex-resource"><h4>Student Task Statements</h4><span data-x=a="<h4>">Teacher Guide</span>${link()}</div>`,
  ];
  it.each(
    lexicalCases,
  )('rejects unquoted markup hidden inside a matched tag token without metadata asset requests', async (body) => {
    const f = setup({ [lesson]: page(body) });
    const result = await f.adapter.enumerate({ cursor: cursor(), checkpoint });
    expect(
      result.records.filter((record) => record.visibility === 'catalog'),
    ).toEqual([]);
    expect(f.fetch.mock.calls).toHaveLength(1);
  });
  it.each(
    lexicalCases,
  )('rejects an old selection when malformed own/descendant tag token appears without PDF GET', async (body) => {
    const original = setup({ [lesson]: page(block()) });
    const found = await original.adapter.enumerate({
      cursor: cursor(),
      checkpoint,
    });
    const selected = found.records.find(
      (record) => record.visibility === 'catalog',
    );
    if (!selected) throw new Error('Valid original source fixture missing');
    const changed = setup({ [lesson]: page(body) });
    await expect(
      changed.adapter.acquire({
        providerId,
        stableId: selected.stableId,
        revision: selected.revision,
        format: 'pdf',
      }),
    ).rejects.toThrow('changed');
    expect(changed.fetch.mock.calls).toHaveLength(1);
  });
  it.each([
    '"<h4>quoted markup</h4>"',
    "'<h4>quoted markup</h4>'",
  ])('preserves properly quoted attribute markup %s', async (value) => {
    const f = setup({
      [lesson]: page(
        `<div class="im-c-row__flex-resource" data-x=${value}><h4>Student Task Statements</h4><span data-y=${value}>Description</span>${link()}</div>`,
      ),
    });
    const result = await f.adapter.enumerate({ cursor: cursor(), checkpoint });
    expect(
      result.records.filter((record) => record.visibility === 'catalog'),
    ).toHaveLength(1);
    expect(f.fetch.mock.calls.map(([, init]) => init?.method)).toEqual([
      'GET',
      'HEAD',
    ]);
  });

  it.each([
    1, 2, 3, 4, 5, 6,
  ])('rejects a truncated nested h%i start before wrapper close rather than silently ignoring malformed markup', async (level) => {
    const html = page(
      `<div class="im-c-row__flex-resource"><h4>Student Task Statements</h4><div><h${level}</div>${link()}</div>`,
    );
    const f = setup({ [lesson]: html });
    const result = await f.adapter.enumerate({ cursor: cursor(), checkpoint });
    expect(
      result.records.filter((record) => record.visibility === 'catalog'),
    ).toEqual([]);
    expect(f.fetch.mock.calls).toHaveLength(1);
  });

  const cases = [1, 2, 3, 4, 5, 6].flatMap((level) =>
    ['before', 'after'].flatMap((position) =>
      ['wrapper-close', 'wrong-heading-close', 'eof'].map((shape) => ({
        level,
        position,
        shape,
      })),
    ),
  );
  function malformedBody(
    level: number,
    position: string,
    shape: string,
  ): string {
    const opening = `<div class="im-c-row__flex-resource"><h4>Student Task Statements</h4>`;
    const prefix = position === 'after' ? link() : '';
    if (shape === 'eof')
      return `${opening}${prefix}<div><h${level}>Teacher Guide${position === 'before' ? link() : ''}`;
    const nested = `<div><h${level}>Teacher Guide${shape === 'wrong-heading-close' ? `</h${(level % 6) + 1}>` : ''}</div>`;
    return `${opening}${prefix}${nested}${position === 'before' ? link() : ''}</div>`;
  }
  it.each(
    cases,
  )('denies malformed h$level $position PDF ($shape) without asset HEAD/GET', async ({
    level,
    position,
    shape,
  }) => {
    const html = page(malformedBody(level, position, shape));
    expect(parseImFirstEditionPage(html, lesson).artifacts[0]?.allowed).toBe(
      false,
    );
    const f = setup({ [lesson]: html });
    const result = await f.adapter.enumerate({ cursor: cursor(), checkpoint });
    expect(
      result.records.filter((record) => record.visibility === 'catalog'),
    ).toEqual([]);
    expect(f.fetch.mock.calls).toHaveLength(1);
  });
  it.each(
    [1, 2, 3, 4, 5, 6].flatMap((level) =>
      ['before', 'after'].map((position) => ({ level, position })),
    ),
  )('denies old-selection acquisition after dangling h$level $position PDF without PDF GET', async ({
    level,
    position,
  }) => {
    const original = setup({ [lesson]: page(block()) });
    const found = await original.adapter.enumerate({
      cursor: cursor(),
      checkpoint,
    });
    const selected = found.records.find(
      (record) => record.visibility === 'catalog',
    );
    if (!selected) throw new Error('Valid original source fixture missing');
    const changed = setup({
      [lesson]: page(malformedBody(level, position, 'wrapper-close')),
    });
    await expect(
      changed.adapter.acquire({
        providerId,
        stableId: selected.stableId,
        revision: selected.revision,
        format: 'pdf',
      }),
    ).rejects.toThrow('changed');
    expect(changed.fetch.mock.calls).toHaveLength(1);
  });
  it('invalidates every containing resource owner for malformed non-heading descendants, not just the discarded wrapper', async () => {
    const bodies = [
      `<div class="im-c-row__flex-resource"><h4>Student Task Statements</h4><div><span>Malformed descendant</div>${link()}</div>`,
      `<div class="im-c-row__flex-resource"><h4>Student Task Statements</h4><div class="im-c-row__flex-resource"><h4>Student Task Statements</h4><div><span>Malformed descendant</div>${link()}</div>${link(otherId)}</div>`,
      `<div class="im-c-row__flex-resource"><h4>Student Task Statements</h4></unknown>${link()}</div>`,
      `<table><tr><td>Student Task Statements</td><td><div><h4>Teacher Guide</div>${link()}</td></tr></table>`,
    ];
    for (const body of bodies) {
      const f = setup({ [lesson]: page(body) });
      const result = await f.adapter.enumerate({
        cursor: cursor(),
        checkpoint,
      });
      expect(
        result.records.filter((record) => record.visibility === 'catalog'),
      ).toEqual([]);
      expect(f.fetch.mock.calls).toHaveLength(1);
    }
  });
  it.each([
    1, 2, 3, 4, 5, 6,
  ])('a sole unclosed or misnested direct h%i never supplies a valid label', (level) => {
    for (const body of [
      `<div class="im-c-row__flex-resource"><h${level}>Student Task Statements${link()}</div>`,
      `<div class="im-c-row__flex-resource"><h${level}>Student Task Statements<div></h${level}>${link()}</div>`,
      `<div class="im-c-row__flex-resource"><h${level}/>Student Task Statements${link()}</div>`,
    ])
      expect(
        parseImFirstEditionPage(page(body), lesson).artifacts[0]?.allowed,
      ).toBe(false);
  });
  it('keeps properly closed sole direct official labels and exact table rows eligible', async () => {
    for (const body of [
      block(),
      `<div class="im-c-row__flex-resource"><h4>Student Task Statements</h4><p>Compare 1 < 2 and &lt;escaped&gt; text.</p>${link()}</div>`,
      `<div class="im-c-row__flex-resource"><h3>Student Handouts</h3>${link()}</div>`,
      `<table><tr><td>Family Materials</td><td>${link()}</td></tr></table>`,
    ]) {
      const f = setup({ [lesson]: page(body) });
      const result = await f.adapter.enumerate({
        cursor: cursor(),
        checkpoint,
      });
      expect(
        result.records.filter((record) => record.visibility === 'catalog'),
      ).toHaveLength(1);
      expect(f.fetch.mock.calls.map(([, init]) => init?.method)).toEqual([
        'GET',
        'HEAD',
      ]);
    }
  });
});

describe('format-neutral strict local role boundary', () => {
  const nonPdf = `<a class="im-c-filetype--docx" href="${IM_ASSET_ORIGIN}/${id}">docx</a>`;
  const guarded = (inner: string) =>
    `<div class="im-c-row__flex-resource">${inner}</div>`;
  for (const level of [1, 2, 3, 4, 5, 6])
    for (const position of ['before', 'after']) {
      it(`denies DOCX with malformed nested h${level} ${position} link without any asset request`, async () => {
        const malformed = `<div><h${level}>Teacher Guide</div>`;
        const html = page(
          guarded(
            `<h4>Student Task Statements</h4>${position === 'before' ? malformed : ''}${nonPdf}${position === 'after' ? malformed : ''}`,
          ),
        );
        const f = setup({ [lesson]: html });
        const result = await f.adapter.enumerate({
          cursor: cursor(),
          checkpoint,
        });
        expect(
          result.records.filter((r) => r.visibility === 'catalog'),
        ).toHaveLength(0);
        expect(f.fetch.mock.calls.map(([, init]) => init?.method)).toEqual([
          'GET',
        ]);
      });
    }
  it.each([
    'Teacher Guide',
    'Unknown role',
  ])('keeps %s DOCX denied with no HEAD/GET', async (label) => {
    const f = setup({ [lesson]: page(guarded(`<h4>${label}</h4>${nonPdf}`)) });
    const result = await f.adapter.enumerate({ cursor: cursor(), checkpoint });
    expect(
      result.records.filter((r) => r.visibility === 'catalog'),
    ).toHaveLength(0);
    expect(f.fetch).toHaveBeenCalledOnce();
  });
  it('denies the same asset in conflicting student DOCX and teacher PDF roles', async () => {
    const html = page(
      guarded(`<h4>Student Task Statements</h4>${nonPdf}`) +
        guarded(`<h4>Teacher Guide</h4>${link()}`),
    );
    expect(parseImFirstEditionPage(html, lesson).artifacts).toMatchObject([
      { allowed: false },
    ]);
    const f = setup({ [lesson]: html });
    const result = await f.adapter.enumerate({ cursor: cursor(), checkpoint });
    expect(
      result.records.filter((r) => r.visibility === 'catalog'),
    ).toHaveLength(0);
    expect(f.fetch).toHaveBeenCalledOnce();
  });
  it('preserves exact local table/block positives independent of icon and rejects nested/lexically malformed ownership', () => {
    for (const body of [
      guarded(`<h4>Student Task Statements</h4>${nonPdf}`),
      `<table><tr><td>Family Materials</td><td>${nonPdf}</td></tr></table>`,
    ])
      expect(
        parseImFirstEditionPage(page(body), lesson).artifacts[0]?.allowed,
      ).toBe(true);
    for (const body of [
      guarded(`<div><h4>Student Task Statements</h4></div>${nonPdf}`),
      guarded(
        `<h4>Student Task Statements</h4><span data-x=<h4>Teacher</span>${nonPdf}`,
      ),
      guarded(`<h4>Student Task Statements${nonPdf}`),
    ])
      expect(
        parseImFirstEditionPage(page(body), lesson).artifacts[0]?.allowed,
      ).toBe(false);
  });
});
