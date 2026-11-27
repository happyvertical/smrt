// A REST write names the model it changed in its `records` event (#5197), so
// the staff event filter, which only forwards events of a model the member may
// read, can forward it. An unresolvable url stays null (never forwarded).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { hostOwner } from '../test/engine-principal.ts';
import { restModelFor } from './definition.ts';
import { type AppDefinition, AppHost, MemoryVersionStore } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'engine-rest-event-'));
let host: AppHost;
afterAll(async () => {
  await host?.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

describe('REST write events', () => {
  it('tag the model; reads and failed writes emit nothing', async () => {
    host = await AppHost.open(dir, { store: new MemoryVersionStore() });
    await host.execute(
      hostOwner(host),
      {
        type: 'defineModel',
        name: 'Chore',
        fields: { title: { type: 'text' } },
      },
      { author: 't', approved: true },
    );
    const seen: (string | null)[] = [];
    host.on('records', (e) => seen.push(e.model));
    const route = 'chores';
    const ok = await host.rest(hostOwner(host), {
      method: 'POST',
      url: `/api/${route}`,
      body: JSON.stringify({ title: 'x' }),
    });
    expect(ok.status).toBeLessThan(300);
    await host.rest(hostOwner(host), { method: 'GET', url: `/api/${route}` });
    await host.rest(hostOwner(host), {
      method: 'POST',
      url: '/api/_nope',
      body: '{}',
    });
    expect(seen).toEqual(['Chore']);
  });

  it('restModelFor never guesses: a shared route or unknown url is null', () => {
    const def = {
      models: {
        A: { fields: {} },
        B: { fields: {}, table: 'a' },
      },
    } as unknown as AppDefinition;
    expect(restModelFor(def, '/api/zzz')).toBeNull();
    expect(restModelFor(def, 'not a url')).toBeNull();
    expect(restModelFor(def, '/other/as')).toBeNull();
  });
});
