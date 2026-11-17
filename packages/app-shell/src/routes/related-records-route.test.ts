// Related records: the records route filtered by a link field.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { App } from '../lib/objects/App.ts';
import { runAs } from '../lib/server/owner.ts';
import { openShell, type ShellHarness } from '../lib/server/test-support.ts';
import { FILTER_SCAN_LIMIT } from '../lib/ui/related.ts';
import * as recordsRoute from './api/shell/records/[model]/+server.ts';

let h: ShellHarness;
beforeAll(async () => {
  h = await openShell();
  await runAs(h.owner, async () => {
    await App.defineModel('Client', { name: { type: 'text' } });
    await App.defineModel('Visit', {
      client: { type: 'reference', ref: 'Client' },
    });
    await App.defineModel('Walk', {
      day: { type: 'text' },
      client: { type: 'reference', ref: 'Client' },
    });
  });
});
afterAll(async () => {
  await h.close();
});

const ORIGIN = 'http://localhost:5173';
function event(
  who: unknown,
  model: string,
  query = '',
  method = 'GET',
  body?: unknown,
) {
  const url = new URL(`/api/shell/records/${model}${query}`, ORIGIN);
  return {
    request: new Request(url, {
      method,
      headers: {
        origin: ORIGIN,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
    url,
    params: { model },
    locals: who
      ? {
          user: { id: (who as { id: string }).id },
          tenantId: (who as { tenantId: string }).tenantId,
          permissions: [],
        }
      : { user: null, tenantId: null, permissions: [] },
  } as never;
}

describe('records filtered by a link field', () => {
  it('returns the matching rows, the full count and a bounded page', async () => {
    const make = async (model: string, data: object) =>
      (
        await (
          await recordsRoute.POST(event(h.owner, model, '', 'POST', data))
        ).json()
      ).id as string;
    const ada = await make('Client', { name: 'Ada' });
    const bob = await make('Client', { name: 'Bob' });
    for (const day of ['mon', 'tue', 'wed']) {
      await make('Walk', { day, client: ada });
    }
    await make('Walk', { day: 'thu', client: bob });

    const res = await recordsRoute.GET(
      event(h.owner, 'Walk', `?field=client&equals=${ada}&limit=2`),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.total).toBe(3);
    expect(body.records).toHaveLength(2);
    expect(body.truncated).toBe(false);
    for (const r of body.records) expect(r.client).toBe(ada);

    const none = await (
      await recordsRoute.GET(
        event(h.owner, 'Walk', '?field=client&equals=missing'),
      )
    ).json();
    expect(none).toMatchObject({ total: 0, records: [] });
  });

  it('keeps the owner check and rejects unsafe values', async () => {
    expect(
      (await recordsRoute.GET(event(null, 'Walk', '?field=client&equals=a')))
        .status,
    ).toBe(401);
    expect(
      (
        await recordsRoute.GET(
          event(h.member, 'Walk', '?field=client&equals=a'),
        )
      ).status,
    ).toBe(403);
    expect(
      (await recordsRoute.GET(event(h.owner, 'Walk', '?field=client'))).status,
    ).toBe(400);
    expect(
      (await recordsRoute.GET(event(h.owner, 'Walk', '?field=a%20b&equals=x')))
        .status,
    ).toBe(400);
  });

  it('flags a lower bound when the model has more rows than the scan reads', async () => {
    const post = async (model: string, data: object) =>
      (
        await (
          await recordsRoute.POST(event(h.owner, model, '', 'POST', data))
        ).json()
      ).id as string;
    const old = await post('Client', { name: 'Old' });
    const busy = await post('Client', { name: 'Busy' });
    await post('Visit', { client: old });
    // Exactly the scan limit of rows: nothing is hidden yet.
    for (let i = 0; i < FILTER_SCAN_LIMIT - 1; i++)
      await post('Visit', { client: busy });
    const full = await (
      await recordsRoute.GET(
        event(h.owner, 'Visit', `?field=client&equals=${old}`),
      )
    ).json();
    expect(full).toMatchObject({ total: 1, truncated: false });

    // One more row pushes the oldest out of the scan: the count is a lower bound.
    await post('Visit', { client: busy });
    const over = await (
      await recordsRoute.GET(
        event(h.owner, 'Visit', `?field=client&equals=${old}`),
      )
    ).json();
    expect(over.truncated).toBe(true);
    expect(over.total).toBe(0);
    const hot = await (
      await recordsRoute.GET(
        event(h.owner, 'Visit', `?field=client&equals=${busy}&limit=5`),
      )
    ).json();
    expect(hot).toMatchObject({ total: FILTER_SCAN_LIMIT, truncated: true });
    expect(hot.records).toHaveLength(5);
  }, 120_000);
});
