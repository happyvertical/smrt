import { expect, it, vi } from 'vitest';
import { description, draftInfo } from '../../../test/draft-fixtures.ts';
import { load } from './+page.server.ts';

it('rechecks draft readiness even when parent data was loaded before Start draft finished', async () => {
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ draft: draftInfo, view: 'live' })),
  );
  const out = await load({
    parent: async () => ({
      description: { ...description('live'), draft: null },
    }),
    depends: vi.fn(),
    fetch,
  } as never);
  expect(out).toMatchObject({ description: { draft: draftInfo } });
  expect(fetch).toHaveBeenCalledWith(
    '/api/shell/draft?target=live',
    expect.anything(),
  );
});

it('returns to the app without a preview or an error page while no draft exists', async () => {
  const fetch = vi.fn(
    async () => new Response(JSON.stringify({ draft: null, view: 'live' })),
  );
  await expect(
    load({
      parent: async () => ({ description: description('live') }),
      depends: vi.fn(),
      fetch,
    } as never),
  ).rejects.toMatchObject({ status: 303, location: '/' });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('retains the owner check before reading current draft state', async () => {
  const fetch = vi.fn();
  await expect(
    load({
      parent: async () => ({ description: null }),
      depends: vi.fn(),
      fetch,
    } as never),
  ).rejects.toMatchObject({ status: 401 });
  expect(fetch).not.toHaveBeenCalled();
});
