import * as config from '@happyvertical/smrt-config';
import { setInferenceResolver } from '@happyvertical/smrt-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configuredAssistantAI } from './sveltekit.js';

afterEach(() => {
  setInferenceResolver(undefined);
  vi.restoreAllMocks();
});
describe('configured assistant tier', () => {
  it.each([
    'best',
    'cheap',
  ] as const)('resolves the API client on the %s tier the selection asks for', async (tier) => {
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
        selection: { engine: 'api', tier },
      }),
    ).rejects.toBe(stop);
    expect(resolve.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ tier }),
    );
  });
});
