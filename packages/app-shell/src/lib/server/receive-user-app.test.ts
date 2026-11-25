// The hosted receiver (#5193): a desktop user app bundle (SQLite) installed as
// ONE tenant's app in the shared PostgreSQL, in that tenant's own schema.
// PGlite stands in for the server; a real one is CI's `test:postgres` lane.
import { rmSync } from 'node:fs';
import { importPGlite } from '@happyvertical/sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseConfig, PGliteClient } from '../../engine/db/index.ts';
import {
  exportUserApp,
  importUserApp,
  type PortableUserApp,
} from '../../engine/index.ts';
import { POST } from '../../routes/api/shell/app/receive/+server.ts';
import { hostOwner } from '../../test/engine-principal.ts';
import { App } from '../objects/App.ts';
import { ApprovalCollection } from '../objects/Approval.ts';
import { ownerTenantFor } from './accounts.ts';
import { applyOwnBatch } from './approvals.ts';
import { addChangeCard, changesState, flushChecks } from './changes.ts';
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
  getShellDb,
  tenantAppDirs,
} from './host.ts';
import { type Principal, runAs } from './owner.ts';
import { receiveOwnUserApp } from './receive-user-app.ts';
import { ShellVersionStore } from './version-store.ts';

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
async function useShell(
  withPostgres: boolean,
  profile: 'cloud' | 'local' = 'cloud',
) {
  await closeHost();
  configureShell({
    profile: async () => profile,
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

const tenantOf = async (email: string): Promise<Principal> => {
  const user = await h.newUser(email);
  return {
    id: user.id,
    tenantId: await ownerTenantFor(h.db, { id: user.id, name: email }),
  };
};
const appIdOf = (who: Principal) =>
  runAs(
    who,
    async () =>
      (await new ShellVersionStore(await getShellDb(), who.tenantId).appRow())
        .id as string,
  );

/** A desktop-shaped app: its own SQLite file with a model, two versions and rows. */
async function desktopBundle(email: string): Promise<PortableUserApp> {
  const who = await tenantOf(email);
  await useShell(false);
  await runAs(who, () =>
    App.defineModel('Chore', {
      title: { type: 'text' },
      done: { type: 'boolean' },
    }),
  );
  const apply = async () => {
    await runAs(who, () => changesState());
    await flushChecks();
    const state = await runAs(who, () => changesState());
    await runAs(who, () => applyOwnBatch(state.digest));
  };
  await apply();
  await runAs(who, () => App.defineModel('Tag', { name: { type: 'text' } }));
  await apply();
  await runAs(who, async () => {
    const host = await getHost();
    const owner = hostOwner(host);
    await host.create(owner, 'Chore', { title: 'wash', done: false });
    await host.create(owner, 'Chore', { title: 'dry', done: true });
    await host.create(owner, 'Tag', { name: 'home' });
  });
  await closeHost();
  const appId = await appIdOf(who);
  const { live } = tenantAppDirs(h.dir, who.tenantId, appId);
  const versions = await runAs(who, async () =>
    new ShellVersionStore(await getShellDb(), who.tenantId).list(),
  );
  return exportUserApp({ dataDir: live, versions });
}

beforeAll(async () => {
  const { PGlite } = await importPGlite();
  pg = (await PGlite.create()) as PGliteClient;
  h = await openCloudShell({});
});
afterAll(async () => {
  await closeHost();
  await h.close();
  await pg.close();
});

describe('receiving a desktop app into the shared PostgreSQL', () => {
  it("places it in the tenant's own schema, with history, verified, and reruns converge", async () => {
    const bundle = await desktopBundle('desk@example.test');
    const cy = await tenantOf('cy@example.test');
    const di = await tenantOf('di@example.test');
    await useShell(true);
    // The receiving owner has already opened their (empty) app: the engine's start.
    await runAs(cy, () => getHost());
    const cyApp = appSchemaName(cy.tenantId, await appIdOf(cy));

    const first = await runAs(cy, () => receiveOwnUserApp(bundle));
    expect(first).toMatchObject({
      status: 'received',
      verified: true,
      digest: bundle.digest,
    });
    expect(first.rows).toBeGreaterThan(0);
    expect(await schemas()).toEqual([cyApp]);

    const rows = await runAs(cy, async () =>
      (await getHost()).list(hostOwner(await getHost()), 'Chore'),
    );
    expect(rows.map((r) => r.title).sort()).toEqual(['dry', 'wash']);
    const history = await runAs(cy, async () =>
      new ShellVersionStore(await getShellDb(), cy.tenantId).list(),
    );
    expect(history.map((v) => v.version)).toEqual(
      bundle.versions.map((v) => v.version),
    );

    // The round trip: re-exported from PostgreSQL, every table digest is the desktop's.
    const { live } = tenantAppDirs(h.dir, cy.tenantId, await appIdOf(cy));
    await closeHost();
    const back = await exportUserApp({
      dataDir: live,
      versions: history,
      database: provider.config(cyApp),
    });
    const digests = (b: PortableUserApp) =>
      Object.fromEntries(
        b.tables
          .filter((t) => !t.name.startsWith('_smrt_'))
          .map((t) => [t.name, `${t.rows.length}:${t.digest}`]),
      );
    expect(digests(back)).toEqual(digests(bundle));

    // Rerun: nothing duplicated.
    const again = await runAs(cy, () => receiveOwnUserApp(bundle));
    expect(again.status).toBe('already-received');
    expect(
      (
        await runAs(cy, async () =>
          (await getHost()).list(hostOwner(await getHost()), 'Chore'),
        )
      ).length,
    ).toBe(2);

    // The neighbour who never received anything is untouched and has no schema of its own yet.
    expect(await schemas()).toEqual([cyApp]);
    expect(
      (
        await runAs(di, async () =>
          new ShellVersionStore(await getShellDb(), di.tenantId).list(),
        )
      ).length,
    ).toBeLessThanOrEqual(1);
  });

  it('converges after a crash between the rows and the history', async () => {
    const bundle = await desktopBundle('desk2@example.test');
    const who = await tenantOf('crash@example.test');
    await useShell(true);
    const appId = await appIdOf(who);
    const schema = appSchemaName(who.tenantId, appId);
    const { live } = tenantAppDirs(h.dir, who.tenantId, appId);
    await provider.provision(schema);
    // The rows went in; the process died before the version history was written.
    await importUserApp({
      dataDir: live,
      database: provider.config(schema),
      bundle,
      tenantId: who.tenantId,
    });
    expect(
      (
        await runAs(who, async () =>
          new ShellVersionStore(await getShellDb(), who.tenantId).list(),
        )
      ).length,
    ).toBe(0);
    const done = await runAs(who, () => receiveOwnUserApp(bundle));
    expect(done.verified).toBe(true);
    const rows = await runAs(who, async () =>
      (await getHost()).list(hostOwner(await getHost()), 'Chore'),
    );
    expect(rows.length).toBe(2);
  });
});

describe('the window between the history and the rows', () => {
  it('an app opened in it boots on empty tables and the rerun still fills it', async () => {
    const bundle = await desktopBundle('desk6@example.test');
    const who = await tenantOf('window@example.test');
    await useShell(true);
    // The history is in; the process died before the rows.
    await runAs(who, async () =>
      new ShellVersionStore(await getShellDb(), who.tenantId).commit(
        bundle.versions,
        bundle.version,
      ),
    );
    // The owner reloads the page: the app opens at the bundle's version, empty.
    await runAs(who, async () => {
      const host = await getHost();
      expect(await host.list(hostOwner(host), 'Chore')).toEqual([]);
    });
    await closeHost();
    const done = await runAs(who, () => receiveOwnUserApp(bundle));
    expect(done).toMatchObject({ verified: true, status: 'received' });
    const rows = await runAs(who, async () =>
      (await getHost()).list(hostOwner(await getHost()), 'Chore'),
    );
    expect(rows.map((r) => r.title).sort()).toEqual(['dry', 'wash']);
  });
});

describe('what the receiver refuses', () => {
  it('a tenant whose app already has content, leaving it untouched', async () => {
    const bundle = await desktopBundle('desk3@example.test');
    const who = await tenantOf('busy@example.test');
    await useShell(true);
    await runAs(who, () =>
      App.defineModel('Mine', { title: { type: 'text' } }),
    );
    await runAs(who, () => changesState());
    await flushChecks();
    const state = await runAs(who, () => changesState());
    await runAs(who, () => applyOwnBatch(state.digest));
    await runAs(who, async () =>
      (await getHost()).create(hostOwner(await getHost()), 'Mine', {
        title: 'keep',
      }),
    );
    const before = await schemas();
    await expect(runAs(who, () => receiveOwnUserApp(bundle))).rejects.toThrow(
      /already has an app with content/,
    );
    expect(await schemas()).toEqual(before);
    const kept = await runAs(who, async () =>
      (await getHost()).list(hostOwner(await getHost()), 'Mine'),
    );
    expect(kept.map((r) => r.title)).toEqual(['keep']);
  });

  it('waiting changes and an unsettled approval, each named, with nothing written', async () => {
    const bundle = await desktopBundle('desk7@example.test');
    const who = await tenantOf('pending@example.test');
    await useShell(true);
    await runAs(who, () =>
      addChangeCard({
        commands: [{ type: 'defineModel', name: 'Later', fields: {} } as never],
        source: 'api',
      }),
    );
    await flushChecks();
    const before = await schemas();
    await expect(runAs(who, () => receiveOwnUserApp(bundle))).rejects.toThrow(
      /open draft|changes are waiting/,
    );
    // Waiting changes with no working copy on disk are named as changes.
    await closeHost();
    rmSync(tenantAppDirs(h.dir, who.tenantId, await appIdOf(who)).draft, {
      recursive: true,
      force: true,
    });
    await useShell(true);
    await expect(runAs(who, () => receiveOwnUserApp(bundle))).rejects.toThrow(
      /changes are waiting/,
    );
    expect(await schemas()).toEqual(before);
    const other = await tenantOf('pending2@example.test');
    await runAs(other, async () =>
      (await ApprovalCollection.create({ db: h.db })).create({
        command: '{}',
        actionKey: 'rk',
        summary: 's',
        preview: '{}',
        status: 'pending',
        result: '',
        requestedBy: other.id,
      } as never),
    );
    await expect(runAs(other, () => receiveOwnUserApp(bundle))).rejects.toThrow(
      /approval is unsettled/,
    );
    expect(await schemas()).toEqual(before);
  });

  it('an engine refusal after the history was written takes the history back', async () => {
    const mine = await desktopBundle('desk8@example.test');
    const other = await desktopBundle('desk9@example.test');
    const who = await tenantOf('refused@example.test');
    await useShell(true);
    const appId = await appIdOf(who);
    const schema = appSchemaName(who.tenantId, appId);
    const { live } = tenantAppDirs(h.dir, who.tenantId, appId);
    await provider.provision(schema);
    // The schema already holds another app's rows (not from this tenant's history).
    await importUserApp({
      dataDir: live,
      database: provider.config(schema),
      bundle: other,
      tenantId: who.tenantId,
    });
    const history = () =>
      runAs(who, async () =>
        new ShellVersionStore(await getShellDb(), who.tenantId).list(),
      );
    await expect(runAs(who, () => receiveOwnUserApp(mine))).rejects.toThrow(
      /different/,
    );
    expect(await history()).toEqual([]);
    expect(
      await runAs(who, async () =>
        new ShellVersionStore(await getShellDb(), who.tenantId).current(),
      ),
    ).toBeNull();
  });

  it('a bundle that does not match its own digests, a non-owner, and the desktop profile', async () => {
    const bundle = await desktopBundle('desk4@example.test');
    const who = await tenantOf('guard@example.test');
    const stranger = await h.newUser('stranger2@example.test');
    await useShell(true);
    const tampered = structuredClone(bundle);
    const table = tampered.tables.find((t) => t.rows.length > 0);
    if (!table) throw new Error('fixture has no rows');
    table.rows[0] = { ...table.rows[0], title: 'changed' };
    const before = await schemas();
    await expect(runAs(who, () => receiveOwnUserApp(tampered))).rejects.toThrow(
      /not usable/,
    );
    await expect(
      runAs({ id: stranger.id, tenantId: who.tenantId }, () =>
        receiveOwnUserApp(bundle),
      ),
    ).rejects.toThrow(/owner/);
    await useShell(true, 'local');
    await expect(runAs(who, () => receiveOwnUserApp(bundle))).rejects.toThrow(
      /not available/,
    );
    await useShell(false);
    await expect(runAs(who, () => receiveOwnUserApp(bundle))).rejects.toThrow(
      /no PostgreSQL/,
    );
    expect(await schemas()).toEqual(before);
  });
});

describe('POST /api/shell/app/receive', () => {
  const ORIGIN = 'http://localhost:5173';
  const call = (
    who: Principal | null,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    POST({
      request: new Request(`${ORIGIN}/api/shell/app/receive`, {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          'content-type': 'application/json',
          ...headers,
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
      url: new URL(`${ORIGIN}/api/shell/app/receive`),
      locals: who
        ? { user: { id: who.id }, tenantId: who.tenantId, permissions: [] }
        : {},
    } as never);

  it("places the owner's bundle, and answers the refusals with their statuses", async () => {
    const bundle = await desktopBundle('desk5@example.test');
    const who = await tenantOf('route@example.test');
    await useShell(true);
    expect((await call(null, { bundle })).status).toBe(401);
    expect(
      (await call(who, { bundle }, { origin: 'http://evil.test' })).status,
    ).toBe(403);
    expect((await call(who, {})).status).toBe(400);
    const ok = await call(who, { bundle });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      status: 'received',
      verified: true,
    });
    const again = await call(who, { bundle });
    expect(await again.json()).toMatchObject({ status: 'already-received' });
    const other = await call(await tenantOf('route2@example.test'), {
      bundle: { ...bundle, tables: [] },
    });
    expect(other.status).toBe(400);
  });
});
