import * as config from '@happyvertical/smrt-config';
import { setInferenceResolver } from '@happyvertical/smrt-core';
import { resolveWorkProfile } from '@happyvertical/smrt-inference';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configuredAssistantAI } from './sveltekit.js';

afterEach(() => {
  setInferenceResolver(undefined);
  vi.restoreAllMocks();
});
describe('configured assistant profile tier', () => {
  it.each([
    ['assist', 'best'],
    ['design', 'best'],
    ['background', 'cheap'],
  ] as const)('resolves %s using %s', async (profile, tier) => {
    vi.spyOn(config, 'getConfig').mockReturnValue({});
    const stop = new Error('stop before provider connection');
    const resolve = vi.fn(async (_request: unknown) => {
      throw stop;
    });
    setInferenceResolver({ resolve });
    await expect(
      configuredAssistantAI({
        principal: {
          userId: 'owner',
          profileId: 'profile',
          tenantId: 'tenant',
        },
        event: { request: new Request('http://app.test') } as never,
        workProfile: resolveWorkProfile({ engine: 'api', profile }),
      }),
    ).rejects.toBe(stop);
    expect(resolve.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ tier }),
    );
  });
});
