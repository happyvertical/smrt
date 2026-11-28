// Requests that never reach core's generated routes are still counted (#5199),
// and a refusal by a cap or limit is announced to the owner (#5198). SQLite.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { hostOwner } from '../test/engine-principal.ts';
import {
  AppHost,
  ApprovalRequiredError,
  type LimitNotice,
  MemoryVersionStore,
} from './index.ts';

type Meter = {
  tenantId: string | null;
  callerKind: string | null;
  limited: boolean;
  refused: string | null;
};

const dirs: string[] = [];
const hosts: AppHost[] = [];
afterAll(async () => {
  for (const h of hosts) await h.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function open(extra: Partial<Parameters<typeof AppHost.open>[1]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'request-funnel-'));
  dirs.push(dir);
  const seen: Meter[] = [];
  const notices: LimitNotice[] = [];
  const host = await AppHost.open(dir, {
    store: new MemoryVersionStore(),
    database: { kind: 'sqlite' },
    onRequest: (m) => seen.push(m),
    ...extra,
  });
  host.on('limit', (n: LimitNotice) => notices.push(n));
  hosts.push(host);
  await host.execute(
    hostOwner(host),
    { type: 'defineModel', name: 'Note', fields: { t: { type: 'text' } } },
    { author: 't', approved: true },
  );
  return { host, seen, notices };
}

describe('requests outside the generated routes', () => {
  it('counts a 404 before core under no tenant, once, with a reason', async () => {
    const { host, seen } = await open();
    const r = await host.rest(hostOwner(host), {
      method: 'GET',
      url: '/api/nowhere',
    });
    expect(r.status).toBe(404);
    expect(seen).toEqual([
      {
        tenantId: null,
        callerKind: hostOwner(host).kind,
        limited: false,
        refused: 'not_found',
      },
    ]);
  });

  it('counts a DELETE parked for approval as refused, and the approved replay as served once', async () => {
    const { host, seen } = await open();
    const owner = hostOwner(host);
    const made = await host.rest(owner, {
      method: 'POST',
      url: '/api/notes',
      body: JSON.stringify({ t: 'a' }),
    });
    const id = JSON.parse(made.body).id;
    seen.length = 0;
    await expect(
      host.rest(owner, { method: 'DELETE', url: `/api/notes/${id}` }),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect(seen.map((m) => [m.tenantId, m.refused])).toEqual([
      [null, 'approval_required'],
    ]);
    seen.length = 0;
    await host.rest(
      owner,
      { method: 'DELETE', url: `/api/notes/${id}` },
      { approved: true },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].refused).toBeNull();
  });

  it('reports a thrown call once as refused with no tenant', async () => {
    const { host, seen } = await open();
    await expect(
      host.rest(
        { ...hostOwner(host), tenantId: 'someone-else' },
        { method: 'GET', url: '/api/notes' },
      ),
    ).rejects.toThrow();
    expect(seen.map((m) => [m.tenantId, m.refused])).toEqual([[null, 'error']]);
  });

  it('a served request is reported once by core', async () => {
    const { host, seen } = await open();
    await host.rest(hostOwner(host), { method: 'GET', url: '/api/notes' });
    expect(seen).toHaveLength(1);
    expect(seen[0].refused).toBeNull();
  });
});

describe('owner notice and the period cap', () => {
  it('a REST create over a row cap tells the owner', async () => {
    const { host, notices } = await open({ appLimits: { maxRows: 1 } });
    const owner = hostOwner(host);
    const post = () =>
      host.rest(owner, {
        method: 'POST',
        url: '/api/notes',
        body: JSON.stringify({ t: 'x' }),
      });
    expect((await post()).status).toBe(201);
    const refused = await post();
    expect(refused.status).toBe(403);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: 'cap', cap: 'maxRows' });
    expect(notices[0].message).toMatch(/1 record of the 1 allowed/);
  });

  it('a worker call over a cap tells the owner', async () => {
    const { host, notices } = await open({ appLimits: { maxRows: 1 } });
    const owner = hostOwner(host);
    await host.create(owner, 'Note', { t: '1' });
    await expect(host.create(owner, 'Note', { t: '2' })).rejects.toThrow(
      /app limit reached/,
    );
    expect(notices.map((n) => n.cap)).toEqual(['maxRows']);
  });

  it('the period cap answers 429 before the app, is counted as refused and tells the owner', async () => {
    let calls = 0;
    const { host, seen, notices } = await open({
      requestCap: async () =>
        ++calls > 1
          ? {
              message: 'over the plan',
              limit: 1,
              used: 1,
              resetsAt: '2026-12-01T00:00:00.000Z',
            }
          : null,
    });
    const owner = hostOwner(host);
    const ok = await host.rest(owner, { method: 'GET', url: '/api/notes' });
    expect(ok.status).toBe(200);
    const over = await host.rest(owner, { method: 'GET', url: '/api/notes' });
    expect(over.status).toBe(429);
    expect(JSON.parse(over.body)).toMatchObject({
      code: 'app_limit',
      cap: 'maxRequests',
      limit: 1,
    });
    expect(seen.map((m) => m.refused)).toEqual([null, 'period_cap']);
    expect(notices).toEqual([
      { kind: 'period', cap: 'maxRequests', message: 'over the plan' },
    ]);
  });

  it('a failing cap lookup admits the request', async () => {
    const { host } = await open({
      requestCap: async () => {
        throw new Error('db down');
      },
    });
    const r = await host.rest(hostOwner(host), {
      method: 'GET',
      url: '/api/notes',
    });
    expect(r.status).toBe(200);
  });

  it('with no cap option nothing is asked and nothing is announced', async () => {
    const { host, notices } = await open();
    await host.rest(hostOwner(host), { method: 'GET', url: '/api/notes' });
    expect(notices).toEqual([]);
  });
});

describe('route limits of the generated routes', () => {
  it('a caller over its limit gets a 429 that never reaches the database, is counted as refused and tells the owner', async () => {
    const { host, seen, notices } = await open({
      appLimits: {
        routeLimits: { client: { maxEvents: 2, windowMs: 60_000 } },
      },
    });
    const owner = hostOwner(host);
    const get = () => host.rest(owner, { method: 'GET', url: '/api/notes' });
    expect((await get()).status).toBe(200);
    expect((await get()).status).toBe(200);
    const over = await get();
    expect(over.status).toBe(429);
    expect(seen.map((m) => m.refused)).toEqual([null, null, 'rate_limited']);
    expect(notices.map((n) => n.kind)).toEqual(['route']);
  });
});
