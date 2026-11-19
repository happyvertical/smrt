// The generated REST path for the builder operations (`POST /api/apps/<op>`):
// the same owner check as MCP, structural operations wait as changes for the
// owner (nothing reaches live), and failures that are logged.
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { App } from '../objects/App.ts';
import { appsRestHandle } from './apps-rest.ts';
import { discardChanges } from './changes.ts';
import { getHost } from './host.ts';
import { runAs } from './owner.ts';
import { applyWaiting, openShell, type ShellHarness } from './test-support.ts';

let h: ShellHarness;
beforeAll(async () => {
  h = await openShell();
  await runAs(h.owner, async () => {
    await App.defineModel('Chore', {
      title: { type: 'text' },
      points: { type: 'text' },
    });
  });
  await applyWaiting(h.owner);
  const host = await getHost();
  await host.create('Chore', { title: 'a', points: '3' });
  await host.create('Chore', { title: 'b', points: 'lots' });
});
afterAll(async () => {
  await h.close();
});
afterEach(async () => {
  await runAs(h.owner, () => discardChanges()).catch(() => {});
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

describe('risky builder operations over REST wait as changes and apply nothing', () => {
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
  ];
  for (const [op, body] of risky)
    it(`${op}`, async () => {
      const before = (await getHost()).version;
      const res = await rest(h.owner, op, body);
      expect(res.status).toBe(200);
      const out = (await res.json()) as {
        action: string;
        result: { status: string; waiting: boolean; count: number };
      };
      expect(out.result).toMatchObject({
        status: 'change_waiting',
        waiting: true,
        count: 1,
      });
      expect((await getHost()).version).toBe(before);
    });

  it("clean up is the owner's from History, never an API call", async () => {
    const res = await rest(h.owner, 'cleanUp', { keep: 0 });
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain('History');
  });
});

describe('REST and MCP agree on the parameter names', () => {
  it('changeFieldType takes `definition` (the documented name) and still accepts `to`', async () => {
    for (const body of [
      { model: 'Chore', field: 'points', definition: { type: 'integer' } },
      { model: 'Chore', field: 'points', to: { type: 'integer' } },
    ]) {
      const res = await rest(h.owner, 'changeFieldType', body);
      expect(res.status).toBe(200);
      await runAs(h.owner, () => discardChanges());
    }
  });

  it('a wrong-shaped body is a 400 that says what to send, never a 500', async () => {
    const bad = await rest(h.owner, 'changeFieldType', {
      model: 'Chore',
      field: 'points',
      foo: { type: 'integer' },
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe(
      "definition must be an object like {type: 'integer'}",
    );
    const noModel = await rest(h.owner, 'removeField', { field: 'points' });
    expect(noModel.status).toBe(400);
    expect(JSON.stringify(await noModel.json())).toContain('model must be');
    const text = await rest(h.owner, 'addField', {
      model: 'Chore',
      field: 'x',
      definition: 'text',
    });
    expect(text.status).toBe(400);
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
    // it waits for the owner: live has no such field until Apply
    expect((await getHost()).describe().models.Chore.fields).not.toHaveProperty(
      'notes',
    );
    await applyWaiting(h.owner);
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
