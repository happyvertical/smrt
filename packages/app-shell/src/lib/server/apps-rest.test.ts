// The generated REST path for the builder operations (`POST /api/apps/<op>`):
// the same owner check and approval gate as MCP, 202 for a risky operation, and
// failures that are logged.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from '../objects/App.ts';
import { appsRestHandle } from './apps-rest.ts';
import { getHost } from './host.ts';
import { runAs } from './owner.ts';
import { openShell, type ShellHarness } from './test-support.ts';

let h: ShellHarness;
beforeAll(async () => {
  h = await openShell();
  await runAs(h.owner, async () => {
    await App.defineModel('Chore', {
      title: { type: 'text' },
      points: { type: 'text' },
    });
  });
  const host = await getHost();
  await host.create('Chore', { title: 'a', points: '3' });
  await host.create('Chore', { title: 'b', points: 'lots' });
});
afterAll(async () => {
  await h.close();
});

const ORIGIN = 'http://localhost:5173';
type Who = { id: string; tenantId: string } | null;

async function rest(
  who: Who,
  op: string,
  body?: unknown,
  method = 'POST',
): Promise<Response> {
  const url = new URL(`/api/apps/${op}`, ORIGIN);
  const resolved = vi.fn(async () => new Response('generated route ran'));
  const response = await appsRestHandle({
    event: {
      request: new Request(url, {
        method,
        headers: {
          origin: ORIGIN,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      url,
      locals: who
        ? { user: { id: who.id }, tenantId: who.tenantId, permissions: [] }
        : { user: null, tenantId: null, permissions: [] },
    } as never,
    resolve: resolved as never,
  });
  return response;
}

describe('risky builder operations over REST answer 202 and apply nothing', () => {
  const risky: [string, Record<string, unknown>][] = [
    [
      'changeFieldType',
      { model: 'Chore', field: 'points', to: { type: 'integer' } },
    ],
    ['removeField', { model: 'Chore', field: 'points' }],
    ['removeModel', { model: 'Chore' }],
    [
      'addMethod',
      {
        model: 'Chore',
        name: 'bump',
        method: { description: 'bump', code: 'return 1;' },
      },
    ],
    ['cleanUp', { keep: 0 }],
  ];
  for (const [op, body] of risky)
    it(`${op}`, async () => {
      const before = (await getHost()).version;
      const res = await rest(h.owner, op, body);
      expect(res.status).toBe(202);
      const out = (await res.json()) as {
        status: string;
        approvalId: string;
        summary: string;
        preview?: unknown;
      };
      expect(out.status).toBe('pending_approval');
      expect(out.approvalId).toBeTruthy();
      expect(out.summary).toBeTruthy();
      expect((await getHost()).version).toBe(before);
    });

  it('changeFieldType carries the conversion preview', async () => {
    const res = await rest(h.owner, 'changeFieldType', {
      model: 'Chore',
      field: 'points',
      to: { type: 'integer' },
    });
    const out = (await res.json()) as { preview: Record<string, unknown> };
    expect(JSON.stringify(out.preview)).toMatch(/lots/);
  });
});

describe('the rest of the REST path', () => {
  it('a safe operation answers 200 with the result', async () => {
    const res = await rest(h.owner, 'addField', {
      model: 'Chore',
      field: 'notes',
      definition: { type: 'text' },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { action: string }).action).toBe('addField');
    expect((await getHost()).describe().models.Chore.fields).toHaveProperty(
      'notes',
    );
  });

  it('a rejected type answers 400 with the allowed types', async () => {
    const res = await rest(h.owner, 'addField', {
      model: 'Chore',
      field: 'due_date',
      definition: { type: 'string' },
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('use one of text');
  });

  it('refuses anyone who is not the signed-in owner', async () => {
    expect((await rest(null, 'describe', {})).status).toBe(401);
    expect(
      (await rest(h.member, 'removeModel', { model: 'Chore' })).status,
    ).toBe(403);
    expect((await getHost()).describe().models).toHaveProperty('Chore');
  });

  it('refuses a cross-origin write and other verbs', async () => {
    const url = new URL('/api/apps/removeModel', ORIGIN);
    const res = await appsRestHandle({
      event: {
        request: new Request(url, {
          method: 'POST',
          headers: {
            origin: 'http://evil.example',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ model: 'Chore' }),
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
    expect(res.status).toBe(403);
    expect((await rest(h.owner, 'describe', undefined, 'GET')).status).toBe(
      405,
    );
    expect((await rest(h.owner, 'nope', {})).status).toBe(404);
  });

  it('logs an unexpected failure without the request body', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const original = App.history;
    (App as unknown as { history: () => never }).history = () => {
      throw new Error('boom');
    };
    try {
      const res = await rest(h.owner, 'history', { secret: 'sk-do-not-log' });
      expect(res.status).toBe(500);
      expect(spy).toHaveBeenCalled();
      expect(JSON.stringify(spy.mock.calls)).toContain('boom');
      expect(JSON.stringify(spy.mock.calls)).not.toContain('sk-do-not-log');
    } finally {
      (App as unknown as { history: typeof original }).history = original;
      spy.mockRestore();
    }
  });

  it('passes other paths on to the app', async () => {
    const url = new URL('/api/shell/describe', ORIGIN);
    const res = await appsRestHandle({
      event: { request: new Request(url), url, locals: {} } as never,
      resolve: (async () => new Response('next')) as never,
    });
    expect(await res.text()).toBe('next');
  });
});
