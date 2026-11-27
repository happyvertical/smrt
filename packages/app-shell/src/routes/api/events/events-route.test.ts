import { beforeEach, expect, it, vi } from 'vitest';

const caller = (tenantId: string) => ({
  kind: 'owner' as const,
  principal: { id: 'o', tenantId },
});
const mocks = vi.hoisted(() => ({
  owner: vi.fn(async () => ({
    kind: 'owner' as const,
    principal: { id: 'o', tenantId: 't' },
  })),
}));
vi.mock('$lib/server/http', () => ({
  callerOf: mocks.owner,
  errorResponse: (e: unknown) => new Response(String(e), { status: 500 }),
}));

let events: typeof import('$lib/server/events');
let GET: typeof import('./+server').GET;
beforeEach(async () => {
  vi.resetModules();
  events = await import('$lib/server/events');
  ({ GET } = await import('./+server'));
});

const call = () =>
  GET({ request: new Request('http://x/api/events') } as never);

it('answers 503 with Retry-After once shutdown began', async () => {
  events.closeAllStreams();
  const res = await call();
  expect(res.status).toBe(503);
  expect(res.headers.get('retry-after')).toBe('5');
});

it('ends an open stream when shutdown begins', async () => {
  const res = await call();
  const reader = res.body!.getReader();
  await reader.read(); // event: ready
  events.closeAllStreams();
  expect((await reader.read()).done).toBe(true);
});

it('ends at once a stream whose owner check finished after shutdown began', async () => {
  let release!: () => void;
  mocks.owner.mockImplementationOnce(
    () => new Promise((r) => (release = () => r(caller('t')))),
  );
  const pending = call();
  events.closeAllStreams(); // while callerOf is still running
  release();
  const res = await pending;
  const reader = res.body!.getReader();
  expect((await reader.read()).done).toBe(true);
});
