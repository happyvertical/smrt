// The draft routes, called as functions with a fake SvelteKit event: owner only
// (401/403 for everyone else), the copy named by the request, and the whole
// start -> build -> preview -> publish-by-approval -> undo -> discard cycle.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { App } from '../lib/objects/App.ts';
import { appsRestHandle } from '../lib/server/apps-rest.ts';
import { type ShellEvent, subscribe } from '../lib/server/events.ts';
import { getDraftSlot, getHost } from '../lib/server/host.ts';
import { runAs } from '../lib/server/owner.ts';
import { openShell, type ShellHarness } from '../lib/server/test-support.ts';
import * as appRoute from './api/app/[...path]/+server.ts';
import * as approvalRoute from './api/shell/approvals/[id]/+server.ts';
import * as describeRoute from './api/shell/describe/+server.ts';
import * as draftRoute from './api/shell/draft/+server.ts';
import * as discardRoute from './api/shell/draft/discard/+server.ts';
import * as previewRoute from './api/shell/draft/preview/+server.ts';
import * as publishRoute from './api/shell/draft/publish/+server.ts';
import * as viewRoute from './api/shell/draft/view/+server.ts';
import * as historyRoute from './api/shell/history/+server.ts';
import * as recordsRoute from './api/shell/records/[model]/+server.ts';
import * as recordRoute from './api/shell/records/[model]/[id]/+server.ts';
import * as undoRoute from './api/shell/undo/+server.ts';
import * as undoToRoute from './api/shell/undo-to/+server.ts';

let h: ShellHarness;
const seen: ShellEvent[] = [];
let off = () => {};
beforeAll(async () => {
  h = await openShell();
  off = subscribe((e) => seen.push(e));
  await runAs(h.owner, () =>
    App.defineModel('Chore', { title: { type: 'text' } }),
  );
  await (await getHost()).create('Chore', { title: 'live-1' });
});
afterAll(async () => {
  off();
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

async function body(res: Response | Promise<Response>) {
  const r = await res;
  return { status: r.status, json: (await r.json()) as Record<string, any> };
}

const MODEL = { params: { model: 'Chore' } };

describe('every new route and target needs the owner session', () => {
  const calls: [string, (who: Who) => Response | Promise<Response>][] = [
    ['GET draft', (w) => draftRoute.GET(event(w, 'GET', '/api/shell/draft'))],
    [
      'POST draft',
      (w) =>
        draftRoute.POST(event(w, 'POST', '/api/shell/draft', { body: {} })),
    ],
    [
      'POST preview',
      (w) => previewRoute.POST(event(w, 'POST', '/api/shell/draft/preview')),
    ],
    [
      'POST publish',
      (w) =>
        publishRoute.POST(
          event(w, 'POST', '/api/shell/draft/publish', { body: {} }),
        ),
    ],
    [
      'POST discard',
      (w) =>
        discardRoute.POST(
          event(w, 'POST', '/api/shell/draft/discard', { body: {} }),
        ),
    ],
    [
      'GET view',
      (w) => viewRoute.GET(event(w, 'GET', '/api/shell/draft/view')),
    ],
    [
      'PUT view',
      (w) =>
        viewRoute.PUT(
          event(w, 'PUT', '/api/shell/draft/view', { body: { view: 'live' } }),
        ),
    ],
    [
      'POST undo-to',
      (w) =>
        undoToRoute.POST(
          event(w, 'POST', '/api/shell/undo-to', { body: { version: 0 } }),
        ),
    ],
    [
      'GET describe draft',
      (w) =>
        describeRoute.GET(event(w, 'GET', '/api/shell/describe?target=draft')),
    ],
    [
      'GET history draft',
      (w) =>
        historyRoute.GET(event(w, 'GET', '/api/shell/history?target=draft')),
    ],
    [
      'POST undo draft',
      (w) => undoRoute.POST(event(w, 'POST', '/api/shell/undo?target=draft')),
    ],
    [
      'GET records draft',
      (w) =>
        recordsRoute.GET(
          event(w, 'GET', '/api/shell/records/Chore?target=draft', MODEL),
        ),
    ],
    [
      'POST records draft',
      (w) =>
        recordsRoute.POST(
          event(w, 'POST', '/api/shell/records/Chore?target=draft', {
            ...MODEL,
            body: { title: 'x' },
          }),
        ),
    ],
    [
      'DELETE record draft',
      (w) =>
        recordRoute.DELETE(
          event(w, 'DELETE', '/api/shell/records/Chore/1?target=draft', {
            params: { model: 'Chore', id: '1' },
          }),
        ),
    ],
    [
      'app rest with the draft header',
      (w) =>
        appRoute.GET(
          event(w, 'GET', '/api/app/chores', {
            params: { path: 'chores' },
            headers: { 'x-shell-target': 'draft' },
          }),
        ),
    ],
  ];
  for (const [name, call] of calls)
    it(`${name}: 401 signed out, 403 for a member and a stranger`, async () => {
      expect((await call(null)).status).toBe(401);
      expect((await call(h.member)).status).toBe(403);
      expect((await call(h.stranger)).status).toBe(403);
    });

  it('the generated draft operations are owner only too', async () => {
    for (const op of [
      'startDraft',
      'previewPublish',
      'publishDraft',
      'discardDraft',
      'undoTo',
    ]) {
      for (const [who, status] of [
        [null, 401],
        [h.member, 403],
        [h.stranger, 403],
      ] as const) {
        const url = new URL(`/api/apps/${op}?target=draft`, ORIGIN);
        const res = await appsRestHandle({
          event: {
            ...(event(who, 'POST', url.pathname + url.search, {
              body: {},
            }) as object),
          } as never,
          resolve: (async () => new Response('generated route ran')) as never,
        });
        expect(res.status, `${op} ${status}`).toBe(status);
      }
    }
  });
});

describe('the cycle', () => {
  let draftId = '';
  let liveBase = 0;

  it('no draft: GET draft says so; target=draft is a 404 with a clear message', async () => {
    const got = await body(
      draftRoute.GET(event(h.owner, 'GET', '/api/shell/draft')),
    );
    expect(got).toMatchObject({
      status: 200,
      json: { draft: null, view: 'live' },
    });
    const d = await body(
      describeRoute.GET(
        event(h.owner, 'GET', '/api/shell/describe?target=draft'),
      ),
    );
    expect(d.status).toBe(404);
    expect(d.json.error).toMatch(/no draft open/);
    const bad = await body(
      describeRoute.GET(
        event(h.owner, 'GET', '/api/shell/describe?target=nope'),
      ),
    );
    expect(bad.status).toBe(400);
    const live = await body(
      describeRoute.GET(event(h.owner, 'GET', '/api/shell/describe')),
    );
    expect(live.json).toMatchObject({
      mode: 'live',
      draft: null,
      frozen: false,
    });
  });

  it('starts a draft: 201 with the DraftInfo, live frozen, events say draft started', async () => {
    liveBase = (await getHost()).version;
    const res = await body(
      draftRoute.POST(
        event(h.owner, 'POST', '/api/shell/draft', {
          body: { name: 'Route draft' },
        }),
      ),
    );
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      name: 'Route draft',
      status: 'open',
      baseVersion: liveBase,
      changes: 0,
      liveFrozen: true,
      publishable: true,
    });
    draftId = res.json.id;
    expect(seen.some((e) => e.type === 'draft' && e.status === 'started')).toBe(
      true,
    );
    const again = await body(
      draftRoute.POST(event(h.owner, 'POST', '/api/shell/draft', { body: {} })),
    );
    expect(again.status).toBe(409);
    expect(again.json.error).toMatch(/already open/);
  });

  it('describe answers for each copy with mode and draft', async () => {
    const live = await body(
      describeRoute.GET(
        event(h.owner, 'GET', '/api/shell/describe?target=live'),
      ),
    );
    expect(live.json).toMatchObject({
      mode: 'live',
      frozen: true,
      draft: { id: draftId, name: 'Route draft' },
    });
    const draft = await body(
      describeRoute.GET(
        event(h.owner, 'GET', '/api/shell/describe?target=draft'),
      ),
    );
    expect(draft.json).toMatchObject({
      mode: 'draft',
      frozen: false,
      draft: { id: draftId },
    });
  });

  it('structure: live is refused naming the draft; the draft takes it (generated REST and undo)', async () => {
    const liveTry = await appsRestHandle({
      event: event(h.owner, 'POST', '/api/apps/addField', {
        body: { model: 'Chore', field: 'points', definition: { type: 'text' } },
      }),
      resolve: (async () => new Response('generated')) as never,
    });
    expect(liveTry.status).toBe(409);
    expect(((await liveTry.json()) as { error: string }).error).toMatch(
      /draft "Route draft" is open/,
    );
    const explicitLive = await appsRestHandle({
      event: event(h.owner, 'POST', '/api/apps/addField?target=live', {
        body: { model: 'Chore', field: 'points', definition: { type: 'text' } },
      }),
      resolve: (async () => new Response('generated')) as never,
    });
    expect(explicitLive.status).toBe(409);
    const ok = await appsRestHandle({
      event: event(h.owner, 'POST', '/api/apps/addField?target=draft', {
        body: { model: 'Chore', field: 'points', definition: { type: 'text' } },
      }),
      resolve: (async () => new Response('generated')) as never,
    });
    expect(ok.status).toBe(200);
    // a risky one applies in the draft, no 202
    const risky = await appsRestHandle({
      event: event(h.owner, 'POST', '/api/apps/removeField?target=draft', {
        body: { model: 'Chore', field: 'points' },
      }),
      resolve: (async () => new Response('generated')) as never,
    });
    expect(risky.status).toBe(200);
    await appsRestHandle({
      event: event(h.owner, 'POST', '/api/apps/addField?target=draft', {
        body: { model: 'Chore', field: 'points', definition: { type: 'text' } },
      }),
      resolve: (async () => new Response('generated')) as never,
    });
    const undoLive = await body(
      undoRoute.POST(event(h.owner, 'POST', '/api/shell/undo')),
    );
    expect(undoLive.status).toBe(409);
    expect((await getHost()).version).toBe(liveBase);
  });

  it('records: each copy has its own; delete is a 202 Approval on live and 200 on the draft', async () => {
    const liveMade = await body(
      recordsRoute.POST(
        event(h.owner, 'POST', '/api/shell/records/Chore', {
          ...MODEL,
          body: { title: 'live-2' },
        }),
      ),
    );
    expect(liveMade.status).toBe(201);
    const draftMade = await body(
      recordsRoute.POST(
        event(h.owner, 'POST', '/api/shell/records/Chore?target=draft', {
          ...MODEL,
          body: { title: 'draft-1', points: '3' },
        }),
      ),
    );
    expect(draftMade.status).toBe(201);
    const list = async (q: string) =>
      (
        await body(
          recordsRoute.GET(
            event(h.owner, 'GET', `/api/shell/records/Chore${q}`, MODEL),
          ),
        )
      ).json.records
        .map((r: { title: string }) => r.title)
        .sort();
    expect(await list('')).toEqual(['live-1', 'live-2']);
    expect(await list('?target=draft')).toEqual(['draft-1', 'live-1']);
    // an update names its copy too: the draft's id does not exist on live
    const upd = await body(
      recordRoute.PUT(
        event(h.owner, 'PUT', `/api/shell/records/Chore/${draftMade.json.id}`, {
          params: { model: 'Chore', id: draftMade.json.id },
          body: { title: 'draft-1b' },
        }),
      ),
    );
    expect([400, 404]).toContain(upd.status); // not found on live: it is not routed to the draft
    // the app REST pass-through: header names the copy
    const viaApp = await appRoute.GET(
      event(h.owner, 'GET', '/api/app/chores', {
        params: { path: 'chores' },
        headers: { 'x-shell-target': 'draft' },
      }),
    );
    expect(viaApp.status).toBe(200);
    expect(JSON.stringify(await viaApp.json())).toContain('draft-1');
    const viaLive = await appRoute.GET(
      event(h.owner, 'GET', '/api/app/chores', { params: { path: 'chores' } }),
    );
    expect(JSON.stringify(await viaLive.json())).not.toContain('draft-1');
    const delLive = await body(
      recordRoute.DELETE(
        event(
          h.owner,
          'DELETE',
          `/api/shell/records/Chore/${liveMade.json.id}`,
          {
            params: { model: 'Chore', id: liveMade.json.id },
          },
        ),
      ),
    );
    expect(delLive.status).toBe(202);
    expect(delLive.json.status).toBe('pending_approval');
    expect(await list('')).toEqual(['live-1', 'live-2']);
    const delDraft = await body(
      recordRoute.DELETE(
        event(
          h.owner,
          'DELETE',
          `/api/shell/records/Chore/${draftMade.json.id}?target=draft`,
          {
            params: { model: 'Chore', id: draftMade.json.id },
          },
        ),
      ),
    );
    expect(delDraft).toMatchObject({
      status: 200,
      json: { deleted: draftMade.json.id },
    });
    expect(await list('?target=draft')).toEqual(['live-1']);
    // the app's own DELETE through the pass-through: live asks, the draft does not
    const appDelLive = await body(
      appRoute.DELETE(
        event(h.owner, 'DELETE', `/api/app/chores/${liveMade.json.id}`, {
          params: { path: `chores/${liveMade.json.id}` },
        }),
      ),
    );
    expect(appDelLive.status).toBe(202);
  });

  it('history: the draft lists only its changes; the view is saved per owner', async () => {
    const h1 = await body(
      historyRoute.GET(
        event(h.owner, 'GET', '/api/shell/history?target=draft'),
      ),
    );
    expect(h1.json.mode).toBe('draft');
    expect(h1.json.versions.length).toBe(3);
    expect(
      h1.json.versions.map((v: { version: number }) => v.version),
    ).not.toContain(liveBase);
    expect(
      (
        await body(
          viewRoute.PUT(
            event(h.owner, 'PUT', '/api/shell/draft/view', {
              body: { view: 'draft' },
            }),
          ),
        )
      ).json,
    ).toEqual({ view: 'draft' });
    expect(
      (await body(draftRoute.GET(event(h.owner, 'GET', '/api/shell/draft'))))
        .json.view,
    ).toBe('draft');
    const badView = await body(
      viewRoute.PUT(
        event(h.owner, 'PUT', '/api/shell/draft/view', { body: { view: 'x' } }),
      ),
    );
    expect(badView.status).toBe(400);
    await viewRoute.PUT(
      event(h.owner, 'PUT', '/api/shell/draft/view', {
        body: { view: 'live' },
      }),
    );
  });

  let digest = '';
  it('preview shows the rehearsal; publish is ALWAYS a 202 Approval pinned to its digest', async () => {
    const prev = await body(
      previewRoute.POST(event(h.owner, 'POST', '/api/shell/draft/preview')),
    );
    expect(prev.status).toBe(200);
    digest = prev.json.preview.digest;
    expect(prev.json.draft.changes).toBe(3);
    expect(prev.json.preview.versions.length).toBe(3);
    expect(Array.isArray(prev.json.preview.methods)).toBe(true);
    const stale = await body(
      publishRoute.POST(
        event(h.owner, 'POST', '/api/shell/draft/publish', {
          body: { expect: 'old' },
        }),
      ),
    );
    expect(stale.status).toBe(409);
    const asked = await body(
      publishRoute.POST(
        event(h.owner, 'POST', '/api/shell/draft/publish', {
          body: { expect: digest },
        }),
      ),
    );
    expect(asked.status).toBe(202);
    expect(asked.json.status).toBe('pending_approval');
    expect((await getHost()).version).toBe(liveBase); // nothing applied
    // approving through the ordinary approvals route publishes
    const decided = await body(
      approvalRoute.POST(
        event(
          h.owner,
          'POST',
          `/api/shell/approvals/${asked.json.approvalId}`,
          {
            params: { id: asked.json.approvalId },
            body: { approve: true },
          },
        ),
      ),
    );
    expect(decided.json.status).toBe('approved');
    expect((await getHost()).version).toBeGreaterThan(liveBase);
    expect(await getDraftSlot()).toBeNull();
    expect(
      seen.some((e) => e.type === 'draft' && e.status === 'published'),
    ).toBe(true);
    const after = await body(
      draftRoute.GET(event(h.owner, 'GET', '/api/shell/draft')),
    );
    expect(after.json).toEqual({ draft: null, view: 'live' });
  });

  it('history groups the publish; undo-to takes it back in one step', async () => {
    const hist = await body(
      historyRoute.GET(event(h.owner, 'GET', '/api/shell/history')),
    );
    const grouped = hist.json.versions.filter(
      (v: { publish: unknown }) => v.publish !== null,
    );
    expect(grouped.length).toBe(3);
    expect(new Set(grouped.map((v: any) => v.publish.draftId)).size).toBe(1);
    expect(grouped[0].publish).toMatchObject({ draftId, name: 'Route draft' });
    const undone = await body(
      undoToRoute.POST(
        event(h.owner, 'POST', '/api/shell/undo-to', {
          body: { version: grouped[0].parent },
        }),
      ),
    );
    expect(undone.status).toBe(200);
    expect((await getHost()).version).toBe(grouped[0].parent);
    const bad = await body(
      undoToRoute.POST(
        event(h.owner, 'POST', '/api/shell/undo-to', {
          body: { version: 'x' },
        }),
      ),
    );
    expect(bad.status).toBe(400);
  });

  it('discard is the owner direct action: 200, live thawed, copy gone', async () => {
    await draftRoute.POST(
      event(h.owner, 'POST', '/api/shell/draft', { body: { name: 'Gone' } }),
    );
    expect((await getHost()).frozen).toBe(true);
    const wrong = await body(
      discardRoute.POST(
        event(h.owner, 'POST', '/api/shell/draft/discard', {
          body: { draftId: 'other' },
        }),
      ),
    );
    expect(wrong.status).toBe(409);
    const gone = await body(
      discardRoute.POST(
        event(h.owner, 'POST', '/api/shell/draft/discard', { body: {} }),
      ),
    );
    expect(gone).toMatchObject({ status: 200, json: { discarded: 'Gone' } });
    expect((await getHost()).frozen).toBe(false);
    expect(
      seen.some((e) => e.type === 'draft' && e.status === 'discarded'),
    ).toBe(true);
    const none = await body(
      discardRoute.POST(
        event(h.owner, 'POST', '/api/shell/draft/discard', { body: {} }),
      ),
    );
    expect(none.status).toBe(404);
  });
});
