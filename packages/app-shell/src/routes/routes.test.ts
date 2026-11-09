// The JSON routes, called as functions with a fake SvelteKit event. The owner
// session is the only way in; the verified principal comes from `locals`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { App } from '../lib/models/App.ts';
import { type ShellEvent, subscribe } from '../lib/server/events.ts';
import { getHost } from '../lib/server/host.ts';
import { runAs } from '../lib/server/owner.ts';
import { openShell, type ShellHarness } from '../lib/server/test-support.ts';
import * as appRoute from './api/app/[...path]/+server.ts';
import * as eventsRoute from './api/events/+server.ts';
import * as approvalsRoute from './api/shell/approvals/+server.ts';
import * as approvalRoute from './api/shell/approvals/[id]/+server.ts';
import * as describeRoute from './api/shell/describe/+server.ts';
import * as historyRoute from './api/shell/history/+server.ts';
import * as recordsRoute from './api/shell/records/[model]/+server.ts';
import * as recordRoute from './api/shell/records/[model]/[id]/+server.ts';
import * as undoRoute from './api/shell/undo/+server.ts';

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
  } = {},
) {
  const url = new URL(path, ORIGIN);
  const headers: Record<string, string> = {
    origin: ORIGIN,
    ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
    ...opts.headers,
  };
  return {
    request: new Request(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
    url,
    params: opts.params ?? {},
    locals: who
      ? { user: { id: who.id }, tenantId: who.tenantId, permissions: [] }
      : { user: null, tenantId: null, permissions: [] },
  } as never;
}

describe('every route needs the owner session', () => {
  const calls: [string, (who: Who) => Response | Promise<Response>][] = [
    [
      'GET describe',
      (w) => describeRoute.GET(event(w, 'GET', '/api/shell/describe')),
    ],
    [
      'GET history',
      (w) => historyRoute.GET(event(w, 'GET', '/api/shell/history')),
    ],
    ['POST undo', (w) => undoRoute.POST(event(w, 'POST', '/api/shell/undo'))],
    [
      'GET approvals',
      (w) => approvalsRoute.GET(event(w, 'GET', '/api/shell/approvals')),
    ],
    [
      'POST decide',
      (w) =>
        approvalRoute.POST(
          event(w, 'POST', '/api/shell/approvals/x', {
            body: { approve: true },
            params: { id: 'x' },
          }),
        ),
    ],
    [
      'GET records',
      (w) =>
        recordsRoute.GET(
          event(w, 'GET', '/api/shell/records/Chore', {
            params: { model: 'Chore' },
          }),
        ),
    ],
    [
      'POST records',
      (w) =>
        recordsRoute.POST(
          event(w, 'POST', '/api/shell/records/Chore', {
            body: { title: 'x' },
            params: { model: 'Chore' },
          }),
        ),
    ],
    [
      'PUT record',
      (w) =>
        recordRoute.PUT(
          event(w, 'PUT', '/api/shell/records/Chore/1', {
            body: {},
            params: { model: 'Chore', id: '1' },
          }),
        ),
    ],
    [
      'DELETE record',
      (w) =>
        recordRoute.DELETE(
          event(w, 'DELETE', '/api/shell/records/Chore/1', {
            params: { model: 'Chore', id: '1' },
          }),
        ),
    ],
    [
      'GET app rest',
      (w) =>
        appRoute.GET(
          event(w, 'GET', '/api/app/chores', { params: { path: 'chores' } }),
        ),
    ],
    [
      'DELETE app rest',
      (w) =>
        appRoute.DELETE(
          event(w, 'DELETE', '/api/app/chores/1', {
            params: { path: 'chores/1' },
          }),
        ),
    ],
    ['GET events', (w) => eventsRoute.GET(event(w, 'GET', '/api/events'))],
  ];
  for (const [name, call] of calls) {
    it(`${name}: 401 anonymous, 403 member`, async () => {
      expect((await call(null)).status).toBe(401);
      expect((await call(h.member)).status).toBe(403);
      expect((await call(h.stranger)).status).toBe(403);
    });
  }
  it('writes from another origin are refused even for the owner', async () => {
    const res = await recordsRoute.POST(
      event(h.owner, 'POST', '/api/shell/records/Chore', {
        body: { title: 'x' },
        params: { model: 'Chore' },
        headers: { origin: 'http://evil.example' },
      }),
    );
    expect(res.status).toBe(403);
    expect((await (await getHost()).list('Chore')).length).toBe(0);
  });
});

describe('owner flows', () => {
  let recordId = '';

  it('describe, records and history', async () => {
    const d = await (
      await describeRoute.GET(event(h.owner, 'GET', '/api/shell/describe'))
    ).json();
    expect(d.models.Chore.fields.title).toBeTruthy();
    expect(d.pendingApprovals).toBe(0);
    const created = await recordsRoute.POST(
      event(h.owner, 'POST', '/api/shell/records/Chore', {
        body: { title: 'mop' },
        params: { model: 'Chore' },
      }),
    );
    expect(created.status).toBe(201);
    recordId = (await created.json()).id;
    const list = await (
      await recordsRoute.GET(
        event(h.owner, 'GET', '/api/shell/records/Chore', {
          params: { model: 'Chore' },
        }),
      )
    ).json();
    expect(list.records.map((r: { title: string }) => r.title)).toEqual([
      'mop',
    ]);
    const put = await recordRoute.PUT(
      event(h.owner, 'PUT', `/api/shell/records/Chore/${recordId}`, {
        body: { title: 'mopped' },
        params: { model: 'Chore', id: recordId },
      }),
    );
    expect((await put.json()).title).toBe('mopped');
    const hist = await (
      await historyRoute.GET(event(h.owner, 'GET', '/api/shell/history'))
    ).json();
    expect(hist.versions.at(-1).current).toBe(true);
  });

  it('request bodies are validated', async () => {
    const noJson = await recordsRoute.POST(
      event(h.owner, 'POST', '/api/shell/records/Chore', {
        params: { model: 'Chore' },
        headers: { 'content-type': 'text/plain' },
      }),
    );
    expect(noJson.status).toBe(415);
    const arr = await recordsRoute.POST(
      event(h.owner, 'POST', '/api/shell/records/Chore', {
        body: [1],
        params: { model: 'Chore' },
      }),
    );
    expect(arr.status).toBe(400);
    const badModel = await recordsRoute.GET(
      event(h.owner, 'GET', '/api/shell/records/..%2Fx', {
        params: { model: '../x' },
      }),
    );
    expect(badModel.status).toBe(400);
    const noModel = await recordsRoute.GET(
      event(h.owner, 'GET', '/api/shell/records/Nope', {
        params: { model: 'Nope' },
      }),
    );
    expect(noModel.status).toBeGreaterThanOrEqual(400);
    const bad = await approvalRoute.POST(
      event(h.owner, 'POST', '/api/shell/approvals/x', {
        body: { approve: 'yes' },
        params: { id: 'x' },
      }),
    );
    expect(bad.status).toBe(400);
  });

  it('app REST passes through; paths cannot escape', async () => {
    const post = await appRoute.POST(
      event(h.owner, 'POST', '/api/app/chores', {
        body: { title: 'via rest' },
        params: { path: 'chores' },
      }),
    );
    expect(post.status).toBeLessThan(300);
    const get = await appRoute.GET(
      event(h.owner, 'GET', '/api/app/chores', { params: { path: 'chores' } }),
    );
    expect(JSON.stringify(await get.json())).toContain('via rest');
    for (const path of ['../shell/describe', 'chores/../..', '']) {
      const res = await appRoute.GET(
        event(h.owner, 'GET', '/api/app/x', { params: { path } }),
      );
      expect(res.status).toBe(400);
    }
  });

  it('DELETE (record and REST) waits for approval; approve deletes', async () => {
    const host = await getHost();
    const seen: ShellEvent[] = [];
    const off = subscribe((e) => seen.push(e));
    const res = await recordRoute.DELETE(
      event(h.owner, 'DELETE', `/api/shell/records/Chore/${recordId}`, {
        params: { model: 'Chore', id: recordId },
      }),
    );
    expect(res.status).toBe(202);
    const pending = await res.json();
    expect(pending.status).toBe('pending_approval');
    expect((await host.get('Chore', recordId)).id).toBe(recordId);
    const viaRest = await appRoute.DELETE(
      event(h.owner, 'DELETE', `/api/app/chores/${recordId}`, {
        params: { path: `chores/${recordId}` },
      }),
    );
    expect(viaRest.status).toBe(202);
    expect((await host.get('Chore', recordId)).id).toBe(recordId);

    const listed = await (
      await approvalsRoute.GET(
        event(h.owner, 'GET', '/api/shell/approvals?status=pending'),
      )
    ).json();
    expect(listed.pending).toBe(2);
    expect(listed.approvals.map((a: { id: string }) => a.id)).toContain(
      pending.approvalId,
    );

    const denied = await approvalRoute.POST(
      event(h.owner, 'POST', `/api/shell/approvals/${pending.approvalId}`, {
        body: { approve: false },
        params: { id: pending.approvalId },
      }),
    );
    expect((await denied.json()).status).toBe('denied');
    expect((await host.get('Chore', recordId)).id).toBe(recordId);
    const again = await approvalRoute.POST(
      event(h.owner, 'POST', `/api/shell/approvals/${pending.approvalId}`, {
        body: { approve: true },
        params: { id: pending.approvalId },
      }),
    );
    expect(again.status).toBe(409);

    const restId = (await viaRest.json()).approvalId;
    const approved = await approvalRoute.POST(
      event(h.owner, 'POST', `/api/shell/approvals/${restId}`, {
        body: { approve: true },
        params: { id: restId },
      }),
    );
    expect((await approved.json()).status).toBe('approved');
    await expect(host.get('Chore', recordId)).rejects.toThrow();
    off();
    expect(
      seen
        .filter((e) => e.type === 'approval')
        .map((e) => (e as { status: string }).status),
    ).toEqual(expect.arrayContaining(['pending', 'denied', 'approved']));
    expect(seen.some((e) => e.type === 'records')).toBe(true);
  });

  it('`approved` in a request body or query cannot bypass the gate', async () => {
    const host = await getHost();
    const made = await host.create('Chore', { title: 'keep' });
    const res = await appRoute.DELETE(
      event(h.owner, 'DELETE', `/api/app/chores/${made.id}?approved=true`, {
        params: { path: `chores/${made.id}` },
        body: { approved: true },
        headers: { 'x-approved': 'true' },
      }),
    );
    expect(res.status).toBe(202);
    expect((await host.get('Chore', made.id as string)).id).toBe(made.id);
  });

  it('undo reverses the last change', async () => {
    const before = (await getHost()).version;
    await runAs(h.owner, () =>
      App.addField('Chore', 'extra', { type: 'text' }),
    );
    const res = await undoRoute.POST(event(h.owner, 'POST', '/api/shell/undo'));
    expect(res.status).toBe(200);
    expect((await getHost()).version).toBe(before);
    expect((await getHost()).describe().models.Chore.fields).not.toHaveProperty(
      'extra',
    );
  });

  it('events: SSE streams ready and live changes', async () => {
    const ac = new AbortController();
    const e = event(h.owner, 'GET', '/api/events') as {
      request: Request;
      url: URL;
    };
    e.request = new Request(e.url, { signal: ac.signal });
    const res = await eventsRoute.GET(e as never);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let text = dec.decode((await reader.read()).value);
    expect(text).toContain('event: ready');
    await runAs(h.owner, () => App.addField('Chore', 'live', { type: 'text' }));
    while (!text.includes('"type":"changed"'))
      text += dec.decode((await reader.read()).value);
    expect(text).toContain('event: shell');
    ac.abort();
  });
});
