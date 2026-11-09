// importTemplate carrying method code is risky: over REST it is a 202 too.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { appsRestHandle } from './apps-rest.ts';
import { getHost } from './host.ts';
import { openShell, type ShellHarness } from './test-support.ts';

let h: ShellHarness;
beforeAll(async () => {
  h = await openShell();
});
afterAll(async () => {
  await h.close();
});

it('answers 202 for a template with code and applies nothing', async () => {
  const ORIGIN = 'http://localhost:5173';
  const url = new URL('/api/apps/importTemplate', ORIGIN);
  const data = {
    format: 1,
    definition: {
      format: 1,
      name: 'Tmpl',
      recipes: [],
      models: {
        Chore: {
          fields: { title: { type: 'text' } },
          methods: {
            bump: { description: 'bump', code: 'return 1;' },
          },
        },
      },
    },
  };
  const res = await appsRestHandle({
    event: {
      request: new Request(url, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ data }),
      }),
      url,
      locals: {
        user: { id: h.owner.id },
        tenantId: h.owner.tenantId,
        permissions: [],
      },
    } as never,
    resolve: (async () => new Response('x')) as never,
  });
  const out = (await res.json()) as { status?: string; error?: string };
  expect(res.status, JSON.stringify(out)).toBe(202);
  expect(out.status).toBe('pending_approval');
  expect(Object.keys((await getHost()).describe().models)).toEqual([]);
});
