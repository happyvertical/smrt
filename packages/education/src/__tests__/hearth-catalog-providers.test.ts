import { describe, expect, it } from 'vitest';
import type { CatalogSyncCheckpoint } from '../catalog-contracts.js';
import type { AuthorizedCatalogFeed } from '../hearth-catalog-providers.js';
import {
  createCk12Adapter,
  createIllustrativeMathematicsAdapter,
  createOerCommonsAdapter,
  createOerCommonsRssAdapter,
  createPublicIllustrativeMathematicsK5Adapter,
} from '../hearth-catalog-providers.js';
import {
  grade4Courses,
  importEasyPeasyGrade4Course,
} from '../hearth-easy-peasy-grade4.js';
import { parseIllustrativeMathematicsK5Index } from '../sources/illustrative-mathematics-parser.js';
import { parseOerCommonsRssFeed } from '../sources/oer-commons-rss-parser.js';

const checkpoint: CatalogSyncCheckpoint = {
  providerId: 'ck12',
  complete: false,
  importedCount: 0,
  failures: [],
};

describe('Hearth catalog providers', () => {
  it('keeps every unprovisioned provider explicitly incomplete', async () => {
    for (const adapter of [
      createIllustrativeMathematicsAdapter(),
      createCk12Adapter(),
      createOerCommonsAdapter(),
    ]) {
      await expect(adapter.enumerate({ checkpoint })).resolves.toMatchObject({
        records: [],
        complete: false,
        exclusions: [{ code: 'provider_feed_not_configured' }],
      });
    }
  });

  it('does not report malformed or contradictory provider pages as complete', async () => {
    const feed: AuthorizedCatalogFeed = {
      providerId: 'ck12',
      metadataFeedUrl: 'https://authorized.example/feed',
      termsAccepted: true,
      async enumerate() {
        return {
          complete: true,
          nextCursor: 'next',
          records: [
            {
              providerId: 'ck12',
              stableId: 'flexbook-1',
              revision: 'v1',
              canonicalUrl: 'https://www.ck12.org/flexbook-1/',
              title: 'Algebra',
              licenseEvidence: { state: 'restricted' },
              visibility: 'catalog',
            },
          ],
        };
      },
    };
    await expect(
      createCk12Adapter(feed).enumerate({ checkpoint }),
    ).resolves.toMatchObject({
      complete: false,
      nextCursor: 'next',
      exclusions: [{ code: 'contradictory_terminal_page' }],
    });
  });

  it('retains a durable failure when provider metadata is malformed', async () => {
    const feed: AuthorizedCatalogFeed = {
      providerId: 'oer-commons',
      metadataFeedUrl: 'https://authorized.example/feed',
      termsAccepted: true,
      async enumerate() {
        return {
          complete: true,
          records: [
            {
              providerId: 'oer-commons',
              stableId: '',
              revision: 'v1',
              canonicalUrl: 'https://www.oercommons.org/resource/1',
              title: 'Missing source identifier',
              licenseEvidence: { state: 'unknown' },
              visibility: 'catalog',
            },
          ],
        };
      },
    };
    await expect(
      createOerCommonsAdapter(feed).enumerate({ checkpoint }),
    ).resolves.toMatchObject({
      complete: false,
      exclusions: [{ code: 'invalid_provider_metadata' }],
    });
  });

  it('parses only official IM family course metadata from the published K-5 index', () => {
    expect(
      parseIllustrativeMathematicsK5Index(
        '<a href="/K5/families/grade-4/units.html">Grade <span>4</span></a><a href="https://elsewhere.test/course">Elsewhere</a>',
        '2026-10-18T00:00:00.000Z',
      ),
    ).toEqual([
      expect.objectContaining({
        stableId: 'k5-family-grade-4',
        gradeRange: { min: '4', max: '4' },
        licenseEvidence: expect.objectContaining({ identifier: 'CC BY' }),
      }),
    ]);
  });

  it('parses configured OER Commons RSS/DC metadata without inferring a license', () => {
    expect(
      parseOerCommonsRssFeed(
        `<?xml version="1.0"?><rss xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><item><guid>oer-1</guid><title>Fractions</title><link>https://www.oercommons.org/courseware/lesson/1</link><dc:creator>Publisher</dc:creator><dc:subject>Mathematics</dc:subject><dc:language>en</dc:language></item></channel></rss>`,
        '2026-10-18T00:00:00.000Z',
      ),
    ).toEqual([
      expect.objectContaining({
        stableId: 'oer-1',
        subjects: ['Mathematics'],
        licenseEvidence: {
          state: 'unknown',
          retrievedAt: '2026-10-18T00:00:00.000Z',
        },
      }),
    ]);
    expect(() =>
      parseOerCommonsRssFeed(
        '<!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><rss/>',
        '2026-10-18T00:00:00.000Z',
      ),
    ).toThrow('DTDs or entities');
  });

  it('uses built-in HTTP parsers without claiming unconfirmed source coverage', async () => {
    const fetch = async (url: string) => ({
      ok: true,
      status: 200,
      url,
      headers: {
        get: (name: string) => (name === 'etag' ? 'revision-1' : null),
      },
      text: async () =>
        url.includes('kendallhunt')
          ? '<a href="/K5/families/grade-4/units.html">Grade 4</a>'
          : '<rss><channel><item><guid>oer-1</guid><title>Fractions</title><link>https://www.oercommons.org/courseware/lesson/1</link></item></channel></rss>',
    });
    await expect(
      createPublicIllustrativeMathematicsK5Adapter({ fetch }).enumerate({
        checkpoint,
      }),
    ).resolves.toMatchObject({
      complete: false,
      records: [{ stableId: 'k5-family-grade-4' }],
      exclusions: [{ code: 'partial_provider_coverage' }],
    });
    await expect(
      createOerCommonsRssAdapter({
        fetch,
        feedUrl: 'https://feed.example/oer.rss',
      }).enumerate({ checkpoint }),
    ).resolves.toMatchObject({
      complete: false,
      records: [{ stableId: 'oer-1' }],
      exclusions: [{ code: 'partial_provider_coverage' }],
    });
  });

  it('makes core import pointers available but never imports all shared themes', async () => {
    const calls: unknown[] = [];
    const service = {
      async importCourse(input: unknown) {
        calls.push(input);
        return { courseId: 'course', lessonIds: [] };
      },
    };
    await importEasyPeasyGrade4Course(service, {
      tenantId: 'tenant',
      actorUserId: 'guardian',
      sourceId: 'source',
      destination: 'private',
      courseRef: 'grade-4-math',
    });
    expect(calls).toEqual([
      expect.objectContaining({
        pageUrl: 'https://allinonehomeschool.com/ep-math-4/',
      }),
    ]);
    await expect(
      importEasyPeasyGrade4Course(service, {
        tenantId: 'tenant',
        actorUserId: 'guardian',
        sourceId: 'source',
        destination: 'private',
        courseRef: 'lower-elementary-theme-1',
      }),
    ).rejects.toThrow('Theme choices');
    expect(grade4Courses('shared-theme-choice')).toHaveLength(4);
  });
});
