// The assistant's HTTP surface, called as functions with a fake SvelteKit
// event (like routes.test.ts). The model is always a stub.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TurnEvent } from '../lib/assistant/events.ts';
import { App } from '../lib/models/App.ts';
import { mountAssistantRoutes } from '../lib/server/assistant/routes.ts';
import { call, say, scripted } from '../lib/server/assistant/test-helpers.ts';
import { getHost } from '../lib/server/host.ts';
import { runAs } from '../lib/server/owner.ts';
import { openShell, type ShellHarness } from '../lib/server/test-support.ts';

let h: ShellHarness;
beforeAll(async () => {
  h = await openShell();
  await runAs(h.owner, () =>
    App.defineModel('Chore', { title: { type: 'text' } }),
  );
});
afterAll(async () => {
  await h.close();
});

const ORIGIN = 'http://localhost:5173';
type Who = { id: string; tenantId: string } | null;

function event(
  who: Who,
  method: string,
  path: string,
  opts: {
    body?: unknown;
    params?: Record<string, string>;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
) {
  const url = new URL(path, ORIGIN);
  return {
    request: new Request(url, {
      method,
      headers: {
        origin: ORIGIN,
        ...(opts.body !== undefined
          ? { 'content-type': 'application/json' }
          : {}),
        ...opts.headers,
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      ...(opts.signal ? { signal: opts.signal } : {}),
    }),
    url,
    params: opts.params ?? {},
    locals: who
      ? { user: { id: who.id }, tenantId: who.tenantId, permissions: [] }
      : { user: null, tenantId: null, permissions: [] },
  } as never;
}

async function sse(res: Response): Promise<TurnEvent[]> {
  const body = await res.text();
  return body
    .split('\n\n')
    .map((chunk) => chunk.split('\n').find((l) => l.startsWith('data: ')))
    .filter((l): l is string => !!l)
    .map((l) => JSON.parse(l.slice(6)) as TurnEvent);
}

const stub = (steps: Parameters<typeof scripted>[0]) => {
  const s = scripted(steps);
  return mountAssistantRoutes({ modelFactory: async () => s.model, env: {} });
};

describe('every assistant endpoint needs the owner session', () => {
  const routes = stub([() => say('hi')]);
  const calls: [string, (who: Who) => Promise<Response>][] = [
    ['status', (w) => routes.status(event(w, 'GET', '/api/assistant/status'))],
    [
      'threads',
      (w) => routes.threads(event(w, 'GET', '/api/assistant/threads')),
    ],
    [
      'thread',
      (w) =>
        routes.thread(
          event(w, 'GET', '/api/assistant/threads/x', { params: { id: 'x' } }),
        ),
    ],
    [
      'turn',
      (w) =>
        routes.turn(
          event(w, 'POST', '/api/assistant/turn', { body: { message: 'hi' } }),
        ),
    ],
  ];
  for (const [name, run] of calls) {
    it(`${name}: 401 signed out, 403 for a member and a stranger`, async () => {
      expect((await run(null)).status).toBe(401);
      expect((await run(h.member)).status).toBe(403);
      expect((await run(h.stranger)).status).toBe(403);
    });
  }

  it('turn: refuses a cross-origin POST and a non-JSON body', async () => {
    const cross = await routes.turn(
      event(h.owner, 'POST', '/api/assistant/turn', {
        body: { message: 'hi' },
        headers: { origin: 'https://evil.example' },
      }),
    );
    expect(cross.status).toBe(403);
    const bad = await routes.turn(
      event(h.owner, 'POST', '/api/assistant/turn', { body: { message: '' } }),
    );
    expect(bad.status).toBe(400);
  });
});

describe('not configured', () => {
  it('status and turn answer a typed state, not a crash', async () => {
    const routes = mountAssistantRoutes({ env: {} });
    const status = await routes.status(
      event(h.owner, 'GET', '/api/assistant/status'),
    );
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      configured: false,
      code: 'assistant_not_configured',
    });
    const turn = await routes.turn(
      event(h.owner, 'POST', '/api/assistant/turn', {
        body: { message: 'hi' },
      }),
    );
    expect(turn.status).toBe(503);
    expect(await turn.json()).toMatchObject({
      type: 'unavailable',
      configured: false,
      code: 'assistant_not_configured',
    });
  });

  it('a subscription provider in config reads as refused, never configured', async () => {
    const routes = mountAssistantRoutes({
      env: { SMRT_AI_PROVIDER: 'claude-cli' },
    });
    const status = await routes.status(
      event(h.owner, 'GET', '/api/assistant/status'),
    );
    expect(await status.json()).toMatchObject({
      configured: false,
      code: 'assistant_provider_refused',
    });
    const turn = await routes.turn(
      event(h.owner, 'POST', '/api/assistant/turn', {
        body: { message: 'hi' },
      }),
    );
    expect(turn.status).toBe(503);
  });

  it('with a key configured, status says so and never carries the key', async () => {
    const routes = mountAssistantRoutes({
      env: { ANTHROPIC_API_KEY: 'sk-ant-SECRETKEY123' },
    });
    const status = await routes.status(
      event(h.owner, 'GET', '/api/assistant/status'),
    );
    const body = await status.text();
    expect(JSON.parse(body)).toEqual({ configured: true });
    expect(body).not.toContain('SECRETKEY123');
  });
});

describe('a turn over HTTP', () => {
  it('streams a thread, tool chips and text; creates a record; stores the thread', async () => {
    const routes = stub([
      () => say('Adding it.', call('chore_create', { title: 'sweep' })),
      () => say('Added sweep.'),
    ]);
    const res = await routes.turn(
      event(h.owner, 'POST', '/api/assistant/turn', {
        body: { message: 'add a chore called sweep' },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = await sse(res);
    expect(events[0].type).toBe('thread');
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['text', 'tool_call', 'tool_result', 'done']),
    );
    expect(events.at(-1)).toMatchObject({ type: 'done', stop: 'complete' });
    const rows = await (await getHost()).list('Chore');
    expect(rows.map((r) => r.title)).toContain('sweep');

    const threadId = (events[0] as { threadId: string }).threadId;
    const list = await (
      await routes.threads(event(h.owner, 'GET', '/api/assistant/threads'))
    ).json();
    expect(list.threads.map((t: { id: string }) => t.id)).toContain(threadId);
    const thread = await (
      await routes.thread(
        event(h.owner, 'GET', `/api/assistant/threads/${threadId}`, {
          params: { id: threadId },
        }),
      )
    ).json();
    expect(thread.messages[0]).toMatchObject({
      role: 'user',
      content: 'add a chore called sweep',
    });
    expect(
      thread.messages.find((m: { role: string }) => m.role === 'tool').tool,
    ).toMatchObject({ name: 'chore_create', ok: true });

    // the thread continues, and an unknown one is a 404
    const again = await routes.turn(
      event(h.owner, 'POST', '/api/assistant/turn', {
        body: { message: 'thanks', threadId },
      }),
    );
    expect((await sse(again))[0]).toMatchObject({ type: 'thread', threadId });
    const missing = await routes.thread(
      event(h.owner, 'GET', '/api/assistant/threads/nope', {
        params: { id: 'nope' },
      }),
    );
    expect(missing.status).toBe(404);
  });

  it('allows one turn at a time', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const routes = stub([
      async () => {
        await gate;
        return say('done');
      },
    ]);
    const first = routes.turn(
      event(h.owner, 'POST', '/api/assistant/turn', { body: { message: 'a' } }),
    );
    const res = await first;
    const reading = sse(res);
    await new Promise((r) => setTimeout(r, 30));
    const second = await routes.turn(
      event(h.owner, 'POST', '/api/assistant/turn', { body: { message: 'b' } }),
    );
    expect(second.status).toBe(409);
    release();
    await reading;
  });

  it('a model error reaches the client as a plain event, with no secret in it or in logs', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const routes = mountAssistantRoutes({
      env: {},
      modelFactory: async () => ({
        async complete() {
          throw new Error('bad key sk-ant-SECRETKEY123');
        },
      }),
    });
    const res = await routes.turn(
      event(h.owner, 'POST', '/api/assistant/turn', {
        body: { message: 'hi' },
      }),
    );
    const raw = JSON.stringify(await sse(res));
    expect(raw).toContain('model_error');
    expect(raw).not.toContain('SECRETKEY123');
    expect(JSON.stringify(log.mock.calls)).not.toContain('SECRETKEY123');
    log.mockRestore();
  });

  it('a factory that throws an unexpected error is a plain 503', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const routes = mountAssistantRoutes({
      env: {},
      modelFactory: async () => {
        throw new Error('boom sk-ant-SECRETKEY123');
      },
    });
    const res = await routes.turn(
      event(h.owner, 'POST', '/api/assistant/turn', {
        body: { message: 'hi' },
      }),
    );
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('SECRETKEY123');
    expect(JSON.stringify(log.mock.calls)).not.toContain('SECRETKEY123');
    log.mockRestore();
  });
});
