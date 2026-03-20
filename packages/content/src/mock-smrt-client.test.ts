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
            isFactual: true,
            defaultFactRelationship: 'supports',
            reviewPolicies: [
              {
                key: 'editorial',
                label: 'Editorial Review',
                kind: 'custom',
                instructions: 'Check style and tone.',
              },
            ],
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
    expect(response.data.isFactual).toBe(true);
  });
});
