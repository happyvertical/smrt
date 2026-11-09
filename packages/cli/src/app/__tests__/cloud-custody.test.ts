/**
 * Cloud link and migration custody (#4806) against a real local installation:
 * linking needs custody, and starting a migration retires the location so the
 * local copy cannot keep writing silently.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type CloudLinkPrincipal,
  type CloudLinkRecord,
  createCloudLinkService,
  createMemoryCloudLinkStore,
  initializeLocalApplicationRuntime,
  inspectInstallationCustody,
  openLocalCloudLinkIdentity,
  restoreInstallation,
  verifyCloudLinkReceipt,
} from '@happyvertical/smrt-app-runtime';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  beginCloudMigration,
  completeCloudMigration,
  planCloudMigration,
  readCloudLinkRecord,
  readCloudMigrationRecord,
  runSharedCloudMigration,
  writeCloudLinkRecord,
} from '../cloud-migration.js';
import type { ManifestTable } from '../portability.js';

const APP_ID = 'cloud-app';
const ORIGIN = 'https://cloud.example.test';
const ENV_KEYS = ['HOME', 'SMRT_DATA_DIR', 'XDG_STATE_HOME', 'SMRT_APP_ID'];
const saved: Record<string, string | undefined> = {};
const roots: string[] = [];
const lockPaths: string[] = [];

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  for (const lockPath of lockPaths.splice(0)) {
    for (const suffix of ['', '-journal', '-shm', '-wal']) {
      rmSync(`${lockPath}${suffix}`, { force: true });
    }
    try {
      rmdirSync(dirname(lockPath));
    } catch {
      // Shared or already removed.
    }
  }
});

async function installed() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-cloud-custody-')));
  roots.push(root);
  const app = join(root, 'app');
  const home = join(root, 'home');
  mkdirSync(app);
  mkdirSync(home, { mode: 0o700 });
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: APP_ID }));
  process.env.HOME = home;
  process.env.XDG_STATE_HOME = join(home, 'state');
  delete process.env.SMRT_APP_ID;
  const boot = async (data: string) => {
    process.env.SMRT_DATA_DIR = data;
    const identity = platform() === 'darwin' ? data.toLowerCase() : data;
    lockPaths.push(
      join(
        realpathSync('/tmp'),
        `.smrt-${process.getuid?.()}`,
        createHash('sha256').update(identity).digest('hex').slice(0, 32),
        'initialization.sqlite',
      ),
    );
    const { runtime } = await initializeLocalApplicationRuntime({
      appId: APP_ID,
      dataDirectory: data,
      sourceRoot: app,
      bindHost: '127.0.0.1',
      prepareDatabase: async (db) => {
        await getTestDatabase({ db });
      },
    });
    await runtime.db.close?.();
  };
  const data = join(root, 'data');
  await boot(data);
  const options = { appId: APP_ID, dataDirectory: data, sourceRoot: app };
  return { root, app, data, boot, options };
}

function principal(): CloudLinkPrincipal {
  return {
    sessionId: randomUUID(),
    accountId: randomUUID(),
    accountEmail: 'owner@cloud.test',
    tenantId: randomUUID(),
    tenantName: 'Family',
    profileId: randomUUID(),
    membershipId: randomUUID(),
    isTenantOwner: true,
    tenantOwnerCount: 1,
    tenantMemberCount: 1,
  };
}

async function linkInstallation(options: {
  appId: string;
  dataDirectory: string;
  sourceRoot: string;
}) {
  const service = createCloudLinkService({
    origin: ORIGIN,
    store: createMemoryCloudLinkStore(),
  });
  const local = await openLocalCloudLinkIdentity(options);
  const who = principal();
  const issued = await service.issueChallenge(who, {
    appId: APP_ID,
    installationId: local.installationId,
    linkPublicKey: local.linkPublicKey,
    target: 'shared',
  });
  const { challenge, signature } = await local.signProof(
    JSON.parse(JSON.stringify(issued)),
    {
      origin: ORIGIN,
      accountId: who.accountId,
      tenantId: who.tenantId,
      target: 'shared',
    },
  );
  const record = await service.completeChallenge(who, {
    challengeId: challenge.challengeId,
    localIdentities: local.identities,
    signature,
  });
  return verifyCloudLinkReceipt(record, challenge, local.identities);
}

describe('cloud link custody', () => {
  it('links an in-custody installation and signs nothing for an arrived copy', async () => {
    const { root, options } = await installed();
    const record = await linkInstallation(options);
    expect(record.localIdentities.tenantId).toMatch(/^[0-9a-f-]{36}$/);

    const copy = join(root, 'copy');
    cpSync(options.dataDirectory, copy, { recursive: true });
    chmodSync(copy, 0o700);
    await expect(
      openLocalCloudLinkIdentity({ ...options, dataDirectory: copy }),
    ).rejects.toMatchObject({ code: 'installation_unverified' });
  });

  it('refuses a challenge for another account before signing', async () => {
    const { options } = await installed();
    const local = await openLocalCloudLinkIdentity(options);
    const service = createCloudLinkService({
      origin: ORIGIN,
      store: createMemoryCloudLinkStore(),
    });
    const attacker = principal();
    const issued = await service.issueChallenge(attacker, {
      appId: APP_ID,
      installationId: local.installationId,
      linkPublicKey: local.linkPublicKey,
      target: 'shared',
    });
    await expect(
      local.signProof(issued, {
        origin: ORIGIN,
        accountId: randomUUID(),
        tenantId: attacker.tenantId,
        target: 'shared',
      }),
    ).rejects.toMatchObject({ code: 'challenge_mismatch' });
  });
});

const NOTES: ManifestTable[] = [
  {
    name: 'notes',
    columns: ['id', 'tenant_id', 'body', 'updated_at'],
    columnDefinitions: {
      id: { primaryKey: true },
      tenant_id: {},
      body: {},
      updated_at: {},
    },
    foreignKeys: [],
    primaryKeys: ['id'],
  },
];

function bundle(link: CloudLinkRecord, exportedAt: string) {
  return {
    schemaVersion: 2 as const,
    application: APP_ID,
    profile: 'local',
    exportedAt,
    tables: [
      {
        name: 'notes',
        columns: NOTES[0].columns,
        rows: [
          {
            id: NOTE,
            tenant_id: link.localIdentities.tenantId,
            body: 'hello',
            updated_at: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
    ],
    assets: {
      schemaVersion: 1,
      adapter: 'filesystem' as const,
      entries: [],
      payloads: [],
    },
  };
}

const NOTE = randomUUID();

describe('cloud migration custody', () => {
  it('checks the link before retiring anything', async () => {
    const { options } = await installed();
    const link = await linkInstallation(options);
    await expect(
      beginCloudMigration({
        ...options,
        target: 'shared',
        link: { ...link, installationId: randomUUID() },
      }),
    ).rejects.toMatchObject({ code: 'custody_refused' });
    expect((await inspectInstallationCustody(options)).status).toBe(
      'in-custody',
    );
    expect(readCloudMigrationRecord(options)).toBeNull();
  });

  it('retires the location at start and completes only on verified evidence', async () => {
    const { boot, data, root, options } = await installed();
    const link = await linkInstallation(options);
    expect(writeCloudLinkRecord(options, link)).toEqual(link);
    expect(readCloudLinkRecord(options)).toEqual(link);

    const early = planCloudMigration({
      bundle: bundle(link, new Date(Date.now() - 60_000).toISOString()),
      tables: NOTES,
      link,
    });
    const started = await beginCloudMigration({
      ...options,
      target: 'shared',
      link,
    });
    expect(started).toMatchObject({
      status: 'in-progress',
      linkId: link.linkId,
    });
    expect((await inspectInstallationCustody(options)).status).toBe('retired');
    // The local copy no longer starts, so it cannot keep writing silently.
    await expect(boot(data)).rejects.toMatchObject({
      code: 'installation_unverified',
    });
    expect(
      await beginCloudMigration({ ...options, target: 'shared', link }),
    ).toMatchObject({ startedAt: started.startedAt });

    const journalPath = join(root, 'journal.json');
    const target = {
      tables: [
        {
          name: 'notes',
          columns: NOTES[0].columns,
          rows: [
            {
              id: NOTE,
              tenant_id: link.hostedIdentities.tenantId,
              body: 'hello',
              updated_at: '2026-11-09T00:00:00.000Z',
            },
          ],
        },
      ],
      assets: early.bundle.assets,
    };
    // A bundle without a valid export time cannot complete.
    const undated = planCloudMigration({
      bundle: bundle(link, 'not a date'),
      tables: NOTES,
      link,
    });
    expect(() =>
      completeCloudMigration({
        ...options,
        plan: undated,
        link,
        target,
        journalPath,
      }),
    ).toThrow(/exported before/);
    // A bundle exported before the location was retired cannot complete.
    expect(() =>
      completeCloudMigration({
        ...options,
        plan: early,
        link,
        target,
        journalPath,
      }),
    ).toThrow(/exported before/);

    const plan = planCloudMigration({
      bundle: bundle(link, new Date(Date.now() + 1000).toISOString()),
      tables: NOTES,
      link,
    });
    // Not applied yet: no journal.
    expect(() =>
      completeCloudMigration({ ...options, plan, link, target, journalPath }),
    ).toThrow(/not been applied/);
    await runSharedCloudMigration({
      plan,
      segments: { notes: 'notes' },
      journalPath,
      transport: {
        putAsset: async () => 'stored',
        apply: async (request) => ({
          results: request.items.map((item) => ({
            itemId: item.itemId,
            id: item.id,
            status: 'applied' as const,
          })),
        }),
      },
    });
    expect(() =>
      completeCloudMigration({ ...options, plan, link, target, journalPath }),
    ).toThrow(/notes\.updated_at/);
    expect(() =>
      completeCloudMigration({
        ...options,
        plan,
        link,
        journalPath,
        target: { ...target, tables: [{ ...target.tables[0], rows: [] }] },
        acknowledgedChangedColumns: { notes: ['updated_at'] },
      }),
    ).toThrow(expect.objectContaining({ code: 'verification_failed' }));
    expect(() =>
      completeCloudMigration({
        ...options,
        plan,
        link,
        journalPath,
        target: {
          ...target,
          tables: [
            {
              ...target.tables[0],
              rows: [{ ...target.tables[0].rows[0], tenant_id: randomUUID() }],
            },
          ],
        },
        acknowledgedChangedColumns: { notes: ['updated_at', 'tenant_id'] },
      }),
    ).toThrow(/notes\.tenant_id/);
    const done = completeCloudMigration({
      ...options,
      plan,
      link,
      target,
      journalPath,
      acknowledgedChangedColumns: { notes: ['updated_at'] },
    });
    expect(done.record).toMatchObject({
      status: 'completed',
      bundleDigest: plan.bundleDigest,
      secretValuesIncluded: false,
    });
    expect(readCloudMigrationRecord(options)).toEqual(done.record);

    // Abandoning the cloud is an explicit declaration.
    await restoreInstallation({ ...options, originRetired: true });
    await boot(data);
  });
});
