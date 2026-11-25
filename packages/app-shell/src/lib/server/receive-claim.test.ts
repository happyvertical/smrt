// A receive when another process holds the tenant's app (#5193): the claim is
// refused before anything is staged; and a claim refused during the cleanup
// still gives the staged history back. PGlite has no claim (a server's lane
// covers the real one), so the engine's claim calls are replaced here.
import { importPGlite } from '@happyvertical/sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DatabaseConfig, PGliteClient } from '../../engine/db/index.ts';
import { EngineError } from '../../engine/index.ts';

const claim = vi.hoisted(() => ({
  unclaimed: null as null | (() => never),
  discard: null as null | (() => never),
  importFails: false,
}));
vi.mock('../../engine/index.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../engine/index.ts')>();
  return {
    ...real,
    assertAppUnclaimed: async (db: DatabaseConfig) => {
      if (claim.unclaimed) claim.unclaimed();
      return real.assertAppUnclaimed(db);
    },
    discardUnfilledImport: async (o: never) => {
      if (claim.discard) claim.discard();
      return real.discardUnfilledImport(o);
    },
    importUserApp: async (o: never) => {
      if (claim.importFails)
        throw new real.EngineError(
          'another host already runs the app',
          'refused',
        );
      return real.importUserApp(o);
    },
  };
});

const { exportUserApp } = await import('../../engine/index.ts');
const { hostOwner } = await import('../../test/engine-principal.ts');
const { App } = await import('../objects/App.ts');
const { ownerTenantFor } = await import('./accounts.ts');
const { applyOwnBatch } = await import('./approvals.ts');
const { changesState, flushChecks } = await import('./changes.ts');
const { CLOUD_MASTER_KEY, openCloudShell } = await import(
  './cloud-test-support.ts'
);
const { closeHost, configureShell, getHost, getShellDb, tenantAppDirs } =
  await import('./host.ts');
const { runAs } = await import('./owner.ts');
const { receiveOwnUserApp } = await import('./receive-user-app.ts');
const { ShellVersionStore } = await import('./version-store.ts');

let h: Awaited<ReturnType<typeof openCloudShell>>;
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
const useShell = async (withPostgres: boolean) => {
  await closeHost();
  configureShell({
    profile: async () => 'cloud' as const,
    db: async () => h.db,
    dataRoot: async () => h.dir,
    secretMasterKey: async () => CLOUD_MASTER_KEY,
    ...(withPostgres ? { appDatabase: provider } : {}),
  });
};
const tenantOf = async (email: string) => {
  const user = await h.newUser(email);
  return {
    id: user.id,
    tenantId: await ownerTenantFor(h.db, { id: user.id, name: email }),
  };
};
const history = (who: { id: string; tenantId: string }) =>
  runAs(who, async () =>
    new ShellVersionStore(await getShellDb(), who.tenantId).list(),
  );

async function desktopBundle(email: string) {
  const who = await tenantOf(email);
  await useShell(false);
  await runAs(who, () => App.defineModel('Chore', { title: { type: 'text' } }));
  await runAs(who, () => changesState());
  await flushChecks();
  const state = await runAs(who, () => changesState());
  await runAs(who, () => applyOwnBatch(state.digest));
  await runAs(who, async () =>
    (await getHost()).create(hostOwner(await getHost()), 'Chore', {
      title: 'x',
    }),
  );
  await closeHost();
  const appId = await runAs(
    who,
    async () =>
      (await new ShellVersionStore(await getShellDb(), who.tenantId).appRow())
        .id as string,
  );
  return exportUserApp({
    dataDir: tenantAppDirs(h.dir, who.tenantId, appId).live,
    versions: await history(who),
  });
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

describe("another process holds the tenant's app", () => {
  it('is refused before anything is staged', async () => {
    const bundle = await desktopBundle('deskh@example.test');
    const who = await tenantOf('held@example.test');
    await useShell(true);
    await runAs(who, () => getHost()); // the tenant's own empty app: version 0
    const before = await history(who);
    claim.unclaimed = () => {
      throw new EngineError('another host already runs the app', 'refused');
    };
    try {
      await expect(runAs(who, () => receiveOwnUserApp(bundle))).rejects.toThrow(
        /another host/,
      );
    } finally {
      claim.unclaimed = null;
    }
    expect(await history(who)).toEqual(before);
  });

  it('a claim taken between the check and the import keeps the history and a rerun converges', async () => {
    const bundle = await desktopBundle('deskr@example.test');
    const who = await tenantOf('raced@example.test');
    await useShell(true);
    claim.importFails = true;
    claim.discard = () => {
      throw new EngineError('another host already runs the app', 'refused');
    };
    try {
      await expect(runAs(who, () => receiveOwnUserApp(bundle))).rejects.toThrow(
        /another host has this app open/,
      );
    } finally {
      claim.importFails = false;
      claim.discard = null;
    }
    // A host that booted in the gap runs on this history: it stays.
    expect((await history(who)).length).toBe(bundle.versions.length);
    const done = await runAs(who, () => receiveOwnUserApp(bundle));
    expect(done.verified).toBe(true);
  });
});
