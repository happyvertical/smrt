import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from './mock-smrt-client';

function mockJsonResponse(data: any, ok = true) {
  return {
    ok,
    json: vi.fn().mockResolvedValue(data),
    text: vi.fn().mockResolvedValue(JSON.stringify(data)),
  } as any;
}

describe('mock-smrt-client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reads v1 list responses from the data envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse({
          data: [{ id: 'content-1', title: 'Hello' }],
        }),
      ),
    );

    const client = createClient('/api/v1');
    const response = await client.contents.list();

    expect(response.data).toEqual([{ id: 'content-1', title: 'Hello' }]);
  });

  it('reads generated list responses from the items array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse({
          items: [{ id: 'content-2', title: 'World' }],
          count: 1,
        }),
      ),
    );

    const client = createClient('/api');
    const response = await client.contents.list();

    expect(response.data).toEqual([{ id: 'content-2', title: 'World' }]);
  });

  it('reads slug lookups for published content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse({
          action: 'getBySlug',
          result: {
            id: 'content-lookup',
            slug: 'bridge-update',
            status: 'published',
          },
        }),
      ),
    );

    const client = createClient('/api/v1');
    const response = await client.contents.getBySlug('bridge-update', {
      status: 'published',
    });

    expect(response.data).toMatchObject({
      id: 'content-lookup',
      slug: 'bridge-update',
      status: 'published',
    });
  });

  it('reads single-item responses whether they are wrapped or raw', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          mockJsonResponse({
            data: { id: 'content-3', title: 'Wrapped' },
          }),
        )
        .mockResolvedValueOnce(
          mockJsonResponse({ id: 'content-4', title: 'Raw' }),
        ),
    );

    const client = createClient('/api/v1');

    await expect(client.contents.get('content-3')).resolves.toMatchObject({
      data: { id: 'content-3', title: 'Wrapped' },
    });
    await expect(client.contents.get('content-4')).resolves.toMatchObject({
      data: { id: 'content-4', title: 'Raw' },
    });
  });

  it('reads generated review-profile list responses from the result array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse({
          action: 'listReviewProfilesAction',
          result: [
            {
              profileKey: 'publication',
              ready: true,
              complete: false,
              requirements: [],
            },
          ],
        }),
      ),
    );

    const client = createClient('/api/v1');
    const response = await client.contents.getReviewProfiles('content-5');

    expect(response.data).toEqual([
      {
        profileKey: 'publication',
        ready: true,
        complete: false,
        requirements: [],
      },
    ]);
  });

  it('reads governance state responses from the result envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse({
          action: 'getGovernanceStateAction',
          result: {
            isGoverned: true,
            factLinkingEnabled: true,
            transparencyEnabled: true,
            defaultFactRelationship: 'supports',
            publicationProfileKey: 'publication',
            correctionProfileKey: 'correction',
            enforcePublishReadiness: true,
            reviewPolicies: [
              {
                key: 'editorial',
                label: 'Editorial Review',
                kind: 'custom',
                instructions: 'Check style and tone.',
              },
            ],
            availableProfiles: [],
            reviewProfiles: [],
          },
        }),
      ),
    );

    const client = createClient('/api/v1');
    const response = await client.contents.getGovernanceState('content-6');

    expect(response.data.reviewPolicies[0]).toMatchObject({
      key: 'editorial',
      kind: 'custom',
    });
    expect(response.data.isGoverned).toBe(true);
    expect(response.data.publicationProfileKey).toBe('publication');
    expect(response.data.enforcePublishReadiness).toBe(true);
  });

  it('reads transparency responses for content preview and published snapshots', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          mockJsonResponse({
            action: 'previewTransparencyAction',
            result: {
              snapshotKind: 'preview',
              factsUsed: [{ id: 'fact-1' }],
              references: [],
            },
          }),
        )
        .mockResolvedValueOnce(
          mockJsonResponse({
            action: 'getPublishedTransparencyAction',
            result: {
              snapshotKind: 'published',
              publicationVersion: {
                id: 'version-1',
                version: 2,
              },
              factsUsed: [],
              references: [{ id: 'reference-1' }],
            },
          }),
        ),
    );

    const client = createClient('/api/v1');
    const preview = await client.contents.getTransparencyPreview('content-7');
    const published =
      await client.contents.getPublishedTransparency('content-7');

    expect(preview.data?.snapshotKind).toBe('preview');
    expect(preview.data?.factsUsed).toHaveLength(1);
    expect(published.data?.snapshotKind).toBe('published');
    expect(published.data?.publicationVersion?.version).toBe(2);
  });

  it('reads transparency for a specific content version', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse({
          action: 'getTransparencyAction',
          result: {
            snapshotKind: 'published',
            publicationVersion: {
              id: 'version-2',
              version: 4,
            },
            versionHistory: [],
          },
        }),
      ),
    );

    const client = createClient('/api/v1');
    const response = await client.contentVersions.getTransparency('version-2');

    expect(response.data.publicationVersion?.id).toBe('version-2');
    expect(response.data.publicationVersion?.version).toBe(4);
  });

  it('builds request paths, verbs, and bodies for the remaining client surface', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({
        data: {},
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient('/api/v1');

    await client.contents.create({ title: 'Created' });
    await client.contents.update('content-1', { title: 'Updated' });
    await client.contents.delete('content-1');
    await client.contents.browseFacts('bridge', {
      limit: 5,
      minSimilarity: 0.8,
      includeSuperseded: true,
      latestOnly: false,
    });
    await client.contents.getFacts('content-1', 'supports');
    await client.contents.syncFacts('content-1', {
      factIds: ['fact-1'],
      relationship: 'supports',
    });
    await client.contents.getReviews('content-1', 'facts');
    await client.contents.getGovernanceDefinitions();
    await client.contents.resolveGovernance({
      type: 'article',
      variant: 'news',
    });
    await client.contents.getReviewProfile('content-1', 'publication');
    await client.contents.runReview('content-1', { kind: 'facts' });
    await client.contents.getCorrections('content-1');
    await client.contents.issueCorrection('content-1', {
      summary: 'Fix claim',
    });
    await client.contents.getVersions('content-1');
    await client.contents.createVersion('content-1', { kind: 'manual' });
    await client.contents.restoreVersion('content-1', 3);
    await client.contentGovernancePolicies.list();
    await client.contentGovernancePolicies.get('policy-1');
    await client.contentGovernancePolicies.create({ key: 'editorial' });
    await client.contentGovernancePolicies.update('policy-1', {
      label: 'Editorial',
    });
    await client.contentGovernancePolicies.delete('policy-1');
    await client.contentGovernanceProfiles.list();
    await client.contentGovernanceProfiles.get('profile-1');
    await client.contentGovernanceProfiles.create({ key: 'publication' });
    await client.contentGovernanceProfiles.update('profile-1', {
      label: 'Publication',
    });
    await client.contentGovernanceProfiles.delete('profile-1');
    await client.contentGovernanceAssignments.list();
    await client.contentGovernanceAssignments.get('assignment-1');
    await client.contentGovernanceAssignments.create({
      contentType: 'article',
    });
    await client.contentGovernanceAssignments.update('assignment-1', {
      label: 'Article Assignment',
    });
    await client.contentGovernanceAssignments.delete('assignment-1');

    const calls = fetchMock.mock.calls.map(([url, options]) => ({
      url,
      method: options?.method || 'GET',
      body: options?.body ? JSON.parse(String(options.body)) : null,
    }));

    expect(calls).toEqual(
      expect.arrayContaining([
        {
          url: '/api/v1/contents',
          method: 'POST',
          body: { title: 'Created' },
        },
        {
          url: '/api/v1/contents/content-1',
          method: 'PUT',
          body: { title: 'Updated' },
        },
        {
          url: '/api/v1/contents/content-1',
          method: 'DELETE',
          body: null,
        },
        {
          url: '/api/v1/contents/facts?q=bridge&limit=5&minSimilarity=0.8&includeSuperseded=true&latestOnly=false',
          method: 'GET',
          body: null,
        },
        {
          url: '/api/v1/contents/content-1/facts?relationship=supports',
          method: 'GET',
          body: null,
        },
        {
          url: '/api/v1/contents/content-1/facts',
          method: 'PUT',
          body: { factIds: ['fact-1'], relationship: 'supports' },
        },
        {
          url: '/api/v1/contents/content-1/reviews?kind=facts',
          method: 'GET',
          body: null,
        },
        {
          url: '/api/v1/contents/governance',
          method: 'GET',
          body: null,
        },
        {
          url: '/api/v1/contents/governance/resolve?type=article&variant=news',
          method: 'GET',
          body: null,
        },
        {
          url: '/api/v1/contents/content-1/review-profiles/publication',
          method: 'GET',
          body: null,
        },
        {
          url: '/api/v1/contents/content-1/reviews',
          method: 'POST',
          body: { kind: 'facts' },
        },
        {
          url: '/api/v1/contents/content-1/corrections',
          method: 'POST',
          body: { summary: 'Fix claim' },
        },
        {
          url: '/api/v1/contents/content-1/versions',
          method: 'POST',
          body: { kind: 'manual' },
        },
        {
          url: '/api/v1/contents/content-1/versions',
          method: 'POST',
          body: { action: 'restore', versionNumber: 3 },
        },
        {
          url: '/api/v1/contentgovernancepolicies/policy-1',
          method: 'DELETE',
          body: null,
        },
        {
          url: '/api/v1/contentgovernanceprofiles/profile-1',
          method: 'DELETE',
          body: null,
        },
        {
          url: '/api/v1/contentgovernanceassignments/assignment-1',
          method: 'DELETE',
          body: null,
        },
      ]),
    );
  });

  it('throws on failed item, list, and delete requests', async () => {
    const failedResponse = {
      ok: false,
      json: vi.fn(),
      text: vi.fn().mockResolvedValue('bad request'),
    } as any;

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(failedResponse));
    const client = createClient('/api/v1');

    await expect(client.contents.get('content-404')).rejects.toThrow(
      'bad request',
    );
    await expect(client.contents.list()).rejects.toThrow('bad request');
    await expect(client.contents.delete('content-404')).rejects.toThrow(
      'bad request',
    );
  });
});
