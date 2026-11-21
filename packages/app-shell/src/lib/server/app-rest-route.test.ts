// The owner's /api/app/* route relays the app's REST answers, except a server
// error: the runtime's own 500 text is not ours to vouch for (#5464).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const answer = vi.hoisted(() => ({
  value: { status: 200, contentType: 'application/json', body: '{}' },
}));
vi.mock('$lib/server/builder', () => ({
  isPending: () => false,
  runRest: async () => answer.value,
}));
vi.mock('$lib/server/http', async (orig) => ({
  ...(await orig<typeof import('./http.ts')>()),
  ownerOf: async () => ({ id: 'owner', tenantId: null }),
}));

import { GET } from '../../routes/api/app/[...path]/+server.ts';

const call = () =>
  GET({
    request: new Request('http://localhost/api/app/chores', {
      headers: { host: 'localhost' },
    }),
    url: new URL('http://localhost/api/app/chores'),
    params: { path: 'chores' },
    locals: {},
  } as never);

describe('/api/app relays the app, but not its server errors', () => {
  beforeEach(() => {
    answer.value = { status: 200, contentType: 'application/json', body: '{}' };
  });

  it('replaces a 5xx body with a fixed one', async () => {
    answer.value = {
      status: 500,
      contentType: 'application/json',
      body: '{"error":"connect ECONNREFUSED db.internal.example:5432"}',
    };
    const res = await call();
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toMatch(/db\.internal|ECONNREFUSED/);
    expect(JSON.parse(text).error).toBeTruthy();
  });

  it('relays a typed 4xx and a success untouched', async () => {
    answer.value = {
      status: 400,
      contentType: 'application/json',
      body: '{"error":{"code":"VALIDATION","message":"title is required"}}',
    };
    const res = await call();
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('title is required');
    answer.value = {
      status: 200,
      contentType: 'application/json',
      body: '[1]',
    };
    expect(await (await call()).text()).toBe('[1]');
  });
});
