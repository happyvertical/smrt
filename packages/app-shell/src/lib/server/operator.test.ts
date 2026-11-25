// The operator command that moves a tenant's SQLite app into PostgreSQL
// (#5193). It runs as the tenant's VERIFIED owner or not at all: a user who is
// not the owner, an owner of another tenant, and ids that exist nowhere are one
// refusal that touches nothing. PGlite stands in for the server.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { importPGlite } from '@happyvertical/sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseConfig, PGliteClient } from '../../engine/db/index.ts';
import { hostOwner } from '../../test/engine-principal.ts';
import { App } from '../objects/App.ts';
import { ownerTenantFor } from './accounts.ts';
import { applyOwnBatch } from './approvals.ts';
import { changesState, flushChecks } from './changes.ts';
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
  tenantAppDirs,
} from './host.ts';
import {
  MIGRATE_COMMAND,
  migrateAppToPostgresAsOperator,
  parseMigrateArgs,
  runOperatorCommand,
} from './operator.ts';
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

async function seedApp(email: string, title: string) {
  const user = await h.newUser(email);
  const tenantId = await ownerTenantFor(h.db, { id: user.id, name: email });
  const who: Principal = { id: user.id, tenantId };
  await useShell(false);
  await runAs(who, () => App.defineModel('Note', { title: { type: 'text' } }));
  await runAs(who, () => changesState());
  await flushChecks();
  const state = await runAs(who, () => changesState());
  await runAs(who, () => applyOwnBatch(state.digest));
  await runAs(who, async () =>
    (await getHost()).create(hostOwner(await getHost()), 'Note', { title }),
  );
  const appId = await runAs(who, async () => {
    const { ShellVersionStore } = await import('./version-store.ts');
    const db = await (await import('./host.ts')).getShellDb();
    return (await new ShellVersionStore(db, tenantId).appRow()).id as string;
  });
  return {
    who,
    appId,
    file: join(tenantAppDirs(h.dir, tenantId, appId).live, 'app.db'),
  };
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

describe('the migrate command line', () => {
  it('reads --tenant and --user, in either form', () => {
    expect(parseMigrateArgs(['--tenant', 't', '--user=u', '--json'])).toEqual({
      tenantId: 't',
      userId: 'u',
      json: true,
    });
  });
  it.each([
    [[], /required/],
    [['--tenant', 't'], /required/],
    [['--tenant', 't', '--user'], /needs a value/],
    [['--tenant', 't', '--user', '--json'], /needs a value/],
    [['--tenant', 't', '--tenant', 'x', '--user', 'u'], /twice/],
    [['--tenant', 't', '--user', 'u', '--force'], /unknown argument/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseMigrateArgs(argv as string[])).toThrow(message);
  });

  it('exits 2 on a usage error and writes nothing', async () => {
    const lines: string[] = [];
    const io = {
      out: (l: string) => lines.push(l),
      err: (l: string) => lines.push(l),
    };
    expect(await runOperatorCommand(['nope'], io)).toBe(2);
    expect(await runOperatorCommand([MIGRATE_COMMAND], io)).toBe(2);
    expect(lines.join('\n')).toMatch(
      /usage: smrt-app-shell migrate-to-postgres/,
    );
  });
});

describe('migrating as the verified owner', () => {
  it("moves the owner's app, names the outcome, and is rerunnable", async () => {
    const { who, appId, file } = await seedApp('own@example.test', 'mine');
    await useShell(true);
    const lines: string[] = [];
    const io = {
      out: (l: string) => lines.push(l),
      err: (l: string) => lines.push(l),
    };
    const code = await runOperatorCommand(
      [MIGRATE_COMMAND, '--tenant', who.tenantId, '--user', who.id, '--json'],
      io,
    );
    expect(code).toBe(0);
    expect(JSON.parse(lines[0])).toMatchObject({
      ok: true,
      tenantId: who.tenantId,
      status: 'migrated',
    });
    expect(existsSync(file)).toBe(true);
    expect(await schemas()).toContain(appSchemaName(who.tenantId, appId));
    const rows = await runAs(who, async () =>
      (await getHost()).list(hostOwner(await getHost()), 'Note'),
    );
    expect(rows.map((r) => r.title)).toEqual(['mine']);

    await closeHost();
    expect(
      (
        await migrateAppToPostgresAsOperator({
          tenantId: who.tenantId,
          userId: who.id,
        })
      ).status,
    ).toBe('already-migrated');
  });
});

describe('what the operator cannot do', () => {
  it("a member who is not the owner, another tenant's owner, and unknown ids are one refusal that writes nothing", async () => {
    const { who, appId } = await seedApp('victim@example.test', 'v');
    const stranger = await h.newUser('stranger@example.test');
    await useShell(true);
    const before = await schemas();
    for (const input of [
      { tenantId: who.tenantId, userId: stranger.id },
      { tenantId: who.tenantId, userId: h.b.id },
      { tenantId: h.b.tenantId, userId: who.id },
      {
        tenantId: who.tenantId,
        userId: '00000000-0000-4000-8000-000000000000',
      },
      {
        tenantId: '00000000-0000-4000-8000-000000000000',
        userId: who.id,
      },
    ])
      await expect(migrateAppToPostgresAsOperator(input)).rejects.toThrow(
        'that user is not the owner of that tenant',
      );
    await expect(
      migrateAppToPostgresAsOperator({ tenantId: '../x', userId: who.id }),
    ).rejects.toThrow(/not a valid id/);
    expect(await schemas()).toEqual(before);
    expect(await schemas()).not.toContain(appSchemaName(who.tenantId, appId));
    // Still refused to open: nothing moved.
    await expect(runAs(who, () => getHost())).rejects.toThrow(/SQLite file/);
  });

  it('refuses on the desktop profile and says so on stderr with exit 1', async () => {
    const { who } = await seedApp('desk@example.test', 'd');
    await useShell(true, 'local');
    const err: string[] = [];
    const code = await runOperatorCommand(
      [MIGRATE_COMMAND, '--tenant', who.tenantId, '--user', who.id],
      { out: () => err.push('OUT'), err: (l) => err.push(l) },
    );
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/hosted-profile operation/);
    expect(err).not.toContain('OUT');
  });

  it("keeps the app's own refusals (a waiting change) as exit 1", async () => {
    const { who } = await seedApp('wait@example.test', 'w');
    await runAs(who, async () => {
      const { addChangeCard } = await import('./changes.ts');
      await addChangeCard({
        commands: [{ type: 'defineModel', name: 'Later', fields: {} } as never],
        source: 'api',
      });
    });
    await flushChecks();
    await closeHost();
    await useShell(true);
    const err: string[] = [];
    const code = await runOperatorCommand(
      [MIGRATE_COMMAND, '--tenant', who.tenantId, '--user', who.id],
      { out: () => {}, err: (l) => err.push(l) },
    );
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/waiting|working copy/);
  });
});
