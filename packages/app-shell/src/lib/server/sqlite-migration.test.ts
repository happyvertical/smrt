// The explicit SQLite-to-PostgreSQL move of one tenant's app (#5193): the
// cloud profile's refusal lifts only after it, the SQLite file stays, waiting
// changes and working copies refuse it, and a neighbour is untouched. PGlite
// stands in for the server; a real one is CI's `test:postgres` lane.
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { importPGlite } from '@happyvertical/sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseConfig, PGliteClient } from '../../engine/db/index.ts';
import { App } from '../objects/App.ts';
import { ApprovalCollection } from '../objects/Approval.ts';
import { ownerTenantFor } from './accounts.ts';
import { applyOwnBatch } from './approvals.ts';
import {
  addChangeCard,
  changesState,
  discardChanges,
  flushChecks,
} from './changes.ts';
import {
  CLOUD_MASTER_KEY,
  type CloudHarness,
  openCloudShell,
} from './cloud-test-support.ts';
import {
  appSchemaName,
  closeHost,
  configureShell,
  getHost,
  migrateOwnAppToPostgres,
  tenantAppDirs,
} from './host.ts';
import { type Principal, runAs } from './owner.ts';

let h: CloudHarness;
let pg: PGliteClient;

const provider = {
  config: (schema: string): DatabaseConfig => ({
    kind: 'pglite',
    schema,
    client: pg,
  }),
  provision: async (schema: string) => {
    await pg.exec(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  },
};
async function useShell(withPostgres: boolean) {
  await closeHost();
  configureShell({
    profile: async () => 'cloud' as const,
    db: async () => h.db,
    dataRoot: async () => h.dir,
    secretMasterKey: async () => CLOUD_MASTER_KEY,
    ...(withPostgres ? { appDatabase: provider } : {}),
  });
}
const schemas = async () =>
  (
    (await pg.query(
      `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'app\\_%' ORDER BY 1`,
    )) as { rows: { nspname: string }[] }
  ).rows.map((r) => r.nspname);

async function applyWaiting(owner: Principal) {
  await runAs(owner, () => changesState());
  await flushChecks();
  const state = await runAs(owner, () => changesState());
  return runAs(owner, () => applyOwnBatch(state.digest));
}

beforeAll(async () => {
  const { PGlite } = await importPGlite();
  pg = (await PGlite.create()) as PGliteClient;
  h = await openCloudShell({});
});
afterAll(async () => {
  await h.close();
  await pg.close();
});

describe('migrating a tenant app from SQLite to PostgreSQL', () => {
  it('moves the rows, lifts the refusal, keeps the file, and is rerunnable', async () => {
    const mk = async (email: string, name: string) => {
      const user = await h.newUser(email);
      const tenantId = await ownerTenantFor(h.db, { id: user.id, name });
      return { id: user.id, tenantId };
    };
    const cy = await mk('cy@example.test', 'cy');
    const di = await mk('di@example.test', 'di');
    // Built while no PostgreSQL server is configured: SQLite apps.
    await useShell(false);
    for (const [who, model, title] of [
      [cy, 'Chore', 'cy-secret'],
      [di, 'Invoice', 'di-secret'],
    ] as const) {
      await runAs(who, () =>
        App.defineModel(model, { title: { type: 'text' } }),
      );
      await applyWaiting(who);
      await runAs(who, async () => (await getHost()).create(model, { title }));
    }
    const dir = (await runAs(cy, () => getHost())).dataDir;
    const file = join(dir, 'app.db');

    // A working copy (waiting change) refuses the move before anything is written.
    await runAs(cy, () =>
      addChangeCard({
        commands: [{ type: 'defineModel', name: 'Later', fields: {} } as never],
        source: 'api',
      }),
    );
    await flushChecks();
    await useShell(true);
    const cyApp = appSchemaName(cy.tenantId, await appIdOf(cy));
    await expect(runAs(cy, () => migrateOwnAppToPostgres())).rejects.toThrow(
      /working copy|waiting/,
    );
    expect(await schemas()).not.toContain(cyApp);
    await useShell(false);
    await runAs(cy, () => discardChanges());
    await useShell(true);

    // Refused to open until migrated.
    await expect(runAs(cy, () => getHost())).rejects.toThrow(/SQLite file/);

    const first = await runAs(cy, () => migrateOwnAppToPostgres());
    expect(first.status).toBe('migrated');
    expect(existsSync(file)).toBe(true);
    // Only cy's schema exists; di's app is untouched and still refused.
    expect(await schemas()).toEqual([cyApp]);
    await expect(runAs(di, () => getHost())).rejects.toThrow(/SQLite file/);

    const rows = await runAs(cy, async () => (await getHost()).list('Chore'));
    expect(rows.map((r) => r.title)).toEqual(['cy-secret']);

    // Rerun: no duplicates.
    await closeHost();
    const again = await runAs(cy, () => migrateOwnAppToPostgres());
    expect(again.status).toBe('already-migrated');
    expect(
      (await runAs(cy, async () => (await getHost()).list('Chore'))).length,
    ).toBe(1);
  });

  it('refuses without a PostgreSQL provider, and without a signed-in owner', async () => {
    await useShell(false);
    await expect(migrateOwnAppToPostgres()).rejects.toThrow(
      /sign in first|no PostgreSQL/,
    );
    await useShell(true);
    await expect(migrateOwnAppToPostgres()).rejects.toThrow(/sign in first/);
  });
});

describe('what refuses the move', () => {
  const seed = async (email: string) => {
    const user = await h.newUser(email);
    const tenantId = await ownerTenantFor(h.db, { id: user.id, name: email });
    const who = { id: user.id, tenantId };
    await useShell(false);
    await runAs(who, () =>
      App.defineModel('Note', { title: { type: 'text' } }),
    );
    await applyWaiting(who);
    await runAs(who, async () =>
      (await getHost()).create('Note', { title: 'x' }),
    );
    const appId = await appIdOf(who);
    const { draft } = tenantAppDirs(h.dir, tenantId, appId);
    return { who, draft, appId };
  };

  it('waiting changes with no working copy on disk, named as changes', async () => {
    const { who, draft } = await seed('wait@example.test');
    await runAs(who, () =>
      addChangeCard({
        commands: [{ type: 'defineModel', name: 'Later', fields: {} } as never],
        source: 'api',
      }),
    );
    await flushChecks();
    await closeHost();
    rmSync(draft, { recursive: true, force: true });
    await useShell(true);
    await expect(runAs(who, () => migrateOwnAppToPostgres())).rejects.toThrow(
      /changes are waiting/,
    );
  });

  it('an open working copy with no waiting changes, named as a draft', async () => {
    const { who, draft } = await seed('draft@example.test');
    await closeHost();
    mkdirSync(draft, { recursive: true });
    await useShell(true);
    await expect(runAs(who, () => migrateOwnAppToPostgres())).rejects.toThrow(
      /open draft/,
    );
  });

  it('an approved approval with no result (a crashed execution) counts as unsettled', async () => {
    const { who } = await seed('crashed@example.test');
    await runAs(who, async () =>
      (await ApprovalCollection.create({ db: h.db })).create({
        command: '{}',
        actionKey: 'k2',
        summary: 's',
        preview: '{}',
        status: 'approved',
        result: '',
        requestedBy: who.id,
      } as never),
    );
    await useShell(true);
    await expect(runAs(who, () => migrateOwnAppToPostgres())).rejects.toThrow(
      /approval is unsettled/,
    );
  });

  it('an unsettled approval, named as an approval', async () => {
    const { who } = await seed('approval@example.test');
    await runAs(who, async () =>
      (await ApprovalCollection.create({ db: h.db })).create({
        command: '{}',
        actionKey: 'k',
        summary: 's',
        preview: '{}',
        status: 'pending',
        requestedBy: who.id,
      } as never),
    );
    await useShell(true);
    await expect(runAs(who, () => migrateOwnAppToPostgres())).rejects.toThrow(
      /approval is unsettled/,
    );
  });
});

async function appIdOf(who: Principal): Promise<string> {
  const host = await runAs(who, () => getHostSafe());
  return host;
}
async function getHostSafe(): Promise<string> {
  const { ShellVersionStore } = await import('./version-store.ts');
  const db = await (await import('./host.ts')).getShellDb();
  const tenantId = (
    await import('@happyvertical/smrt-tenancy')
  ).getCurrentTenant()?.tenantId;
  return (await new ShellVersionStore(db, tenantId ?? null).appRow())
    .id as string;
}
