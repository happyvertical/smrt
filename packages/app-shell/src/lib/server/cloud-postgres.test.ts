// The cloud profile's user apps on PostgreSQL (#5191): each tenant's app in a
// schema of its own, its working copy (draft) in a side schema, none of it a
// SQLite file. The shell's own database is the SQLite of the harness; the apps'
// server is an in-process PGlite (the engine's PostgreSQL twin). A real server
// is the CI lane's (`pnpm test:postgres`); see cloud-profile.md.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { importPGlite } from '@happyvertical/sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseConfig, PGliteClient } from '../../engine/db/index.ts';
import { App } from '../objects/App.ts';
import { applyOwnBatch } from './approvals.ts';
import {
  addChangeCard,
  changesState,
  discardChanges,
  flushChecks,
  waitingCount,
} from './changes.ts';
import { type CloudHarness, openCloudShell } from './cloud-test-support.ts';
import {
  appSchemaName,
  closeHost,
  getDraftSlot,
  getHost,
  safeId,
} from './host.ts';
import { type Principal, runAs } from './owner.ts';

let h: CloudHarness;
let pg: PGliteClient;
const provisioned: string[] = [];

beforeAll(async () => {
  const { PGlite } = await importPGlite();
  pg = (await PGlite.create()) as PGliteClient;
  h = await openCloudShell({
    appDatabase: {
      config: (schema): DatabaseConfig => ({
        kind: 'pglite',
        schema,
        client: pg,
      }),
      provision: async (schema) => {
        provisioned.push(schema);
        await pg.exec(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
      },
    },
  });
});
afterAll(async () => {
  await h.close();
  await pg.close();
});

const schemas = async (): Promise<string[]> =>
  (
    (await pg.query(
      `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'app\\_%' ORDER BY 1`,
    )) as { rows: { nspname: string }[] }
  ).rows.map((r) => r.nspname);
const tablesOf = async (schema: string): Promise<string[]> =>
  (
    (await pg.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1`,
      [schema],
    )) as { rows: { table_name: string }[] }
  ).rows.map((r) => r.table_name);

async function applyWaiting(owner: Principal) {
  await runAs(owner, () => changesState());
  await flushChecks();
  const state = await runAs(owner, () => changesState());
  return runAs(owner, () => applyOwnBatch(state.digest));
}

describe('the schema name of an app', () => {
  it('is derived from the validated tenant and app ids, one per pair', () => {
    const t1 = '11111111-1111-4111-8111-111111111111';
    const t2 = '22222222-2222-4222-8222-222222222222';
    const a1 = '33333333-3333-4333-8333-333333333333';
    const a2 = '44444444-4444-4444-8444-444444444444';
    const names = [
      appSchemaName(t1, a1),
      appSchemaName(t1, a2),
      appSchemaName(t2, a1),
    ];
    expect(new Set(names).size).toBe(3);
    for (const n of names) expect(n).toMatch(/^app_[0-9a-f]{32}$/);
    expect(appSchemaName(t1, a1)).toBe(appSchemaName(t1.toUpperCase(), a1));
    expect(() => appSchemaName("x'; DROP SCHEMA public;--", a1)).toThrow();
    expect(() => appSchemaName(t1, '../a')).toThrow();
    expect(safeId(t1, 'tenant')).toBe(t1);
  });
});

describe('two owners on PostgreSQL', () => {
  it('each app lives in its own schema, with no SQLite file and no shared table', async () => {
    await runAs(h.a, () =>
      App.defineModel('Chore', { title: { type: 'text' } }),
    );
    await runAs(h.b, () =>
      App.defineModel('Invoice', { number: { type: 'text' } }),
    );
    await applyWaiting(h.a);
    await applyWaiting(h.b);
    await runAs(h.a, async () =>
      (await getHost()).create('Chore', { title: 'ann-secret' }),
    );
    await runAs(h.b, async () =>
      (await getHost()).create('Invoice', { number: 'bob-0001' }),
    );
    expect(
      (await runAs(h.a, async () => (await getHost()).list('Chore'))).map(
        (r) => r.title,
      ),
    ).toEqual(['ann-secret']);
    await expect(
      runAs(h.b, async () => (await getHost()).list('Chore')),
    ).rejects.toThrow();

    expect(provisioned).toHaveLength(2);
    expect(new Set(provisioned).size).toBe(2);
    const live = await schemas();
    for (const s of provisioned) expect(live).toContain(s);
    const [aTables, bTables] = await Promise.all(provisioned.map(tablesOf));
    const aOwn = (await runAs(h.a, () => getHost())).dataDir;
    const bOwn = (await runAs(h.b, () => getHost())).dataDir;
    for (const dir of [aOwn, bOwn])
      expect(existsSync(join(dir, 'app.db'))).toBe(false);
    // Exactly one of the two schemas holds each model's table.
    const holding = (t: string) =>
      [aTables, bTables].filter((tables) => tables.some((n) => n.includes(t)));
    expect(holding('chore')).toHaveLength(1);
    expect(holding('invoice')).toHaveLength(1);
    expect(holding('chore')[0]).not.toBe(holding('invoice')[0]);
  });

  it('the working copy is a side schema that is dropped on apply', async () => {
    const before = await schemas();
    await runAs(h.a, () =>
      addChangeCard({
        commands: [{ type: 'defineModel', name: 'Extra', fields: {} } as never],
        source: 'api',
      }),
    );
    const slot = await runAs(h.a, () => getDraftSlot());
    expect(slot?.dir).toContain(h.a.tenantId);
    const during = await schemas();
    expect(during.length).toBeGreaterThan(before.length);
    expect(during.filter((s) => s.includes('__d')).length).toBe(1);
    await applyWaiting(h.a);
    expect((await schemas()).filter((s) => s.includes('__d'))).toHaveLength(0);
    expect(await runAs(h.b, () => waitingCount())).toBe(0);
  });

  it('adopts the open working copy after a restart, and discards it with its schema', async () => {
    await runAs(h.b, () =>
      addChangeCard({
        commands: [{ type: 'defineModel', name: 'Later', fields: {} } as never],
        source: 'api',
      }),
    );
    expect((await schemas()).filter((s) => s.includes('__d'))).toHaveLength(1);
    await flushChecks();
    await closeHost(); // the process restarts: every holder is gone
    const adopted = await runAs(h.b, () => getDraftSlot());
    expect(adopted?.problem).toBeNull();
    expect(adopted?.host).not.toBeNull();
    expect(await runAs(h.b, () => waitingCount())).toBe(1);
    await runAs(h.b, () => discardChanges());
    expect((await schemas()).filter((s) => s.includes('__d'))).toHaveLength(0);
    expect(await runAs(h.b, () => getDraftSlot())).toBeNull();
  });
});
