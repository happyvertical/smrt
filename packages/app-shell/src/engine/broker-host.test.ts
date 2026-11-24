// The broker through a real AppHost and worker thread on PGlite (#5188):
// no principal means zero statements, the role and settings of each call are
// written by the host thread, and two principals interleave without mixing.
// In-process only (no containers, no servers).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostOwner } from '../test/engine-principal.ts';
import { harnessDatabase } from './db/harness.ts';
import { appRoles, provisionAppRoles } from './db/roles.ts';
import type { PGliteClient } from './db/types.ts';
import {
  AppHost,
  appPermissionSlugs,
  enginePrincipal,
  MemoryVersionStore,
  NoPrincipalError,
  PermissionDeniedError,
} from './index.ts';
import { slugFor } from './permissions.ts';
import type { AppWorker } from './worker-handle.ts';
import { OP_LANES, WORKER_OPS } from './worker-protocol.ts';

// A PostgreSQL app's tenant is a UUID (#5189).
const TENANT = '00000000-0000-4000-8000-0000000000a1';
const dir = mkdtempSync(join(tmpdir(), 'broker-host-'));
let host: AppHost;
let pg: Awaited<ReturnType<typeof harnessDatabase>>;
let log: Array<{ sql: string; params?: unknown[] }> = [];

const recording = (real: PGliteClient): PGliteClient => {
  const note = (sql: string, params?: unknown[]) => {
    log.push({ sql, params });
  };
  return {
    query: (sql, params) => {
      note(sql, params);
      return real.query(sql, params);
    },
    exec: (sql) => {
      note(sql);
      return real.exec(sql);
    },
    transaction: (cb) =>
      real.transaction((tx) =>
        cb({
          query: (sql: string, params?: unknown[]) => {
            note(sql, params);
            return tx.query(sql, params);
          },
          exec: (sql: string) => {
            note(sql);
            return tx.exec(sql);
          },
          rollback: () => tx.rollback(),
          get closed() {
            return tx.closed;
          },
        }),
      ),
    close: () => real.close(),
  };
};

const user = (userId: string, permissions: string[], tenantId = TENANT) =>
  enginePrincipal({ kind: 'user', tenantId, userId, permissions });
const owner = () => user('owner', appPermissionSlugs(host.def));
const internals = () => host as any;
const userIds = () =>
  log
    .filter((l) => l.sql.includes('set_config($1, $2, true)') && l.params)
    .map((l) => {
      const i = (l.params as string[]).indexOf('smrt.user_id');
      return i >= 0 ? (l.params as string[])[i + 1] : null;
    })
    .filter((v): v is string => v !== null);

beforeAll(async () => {
  pg = await harnessDatabase(dir);
  if (pg.config.kind !== 'pglite') throw new Error('pglite expected');
  const client = pg.config.client;
  const roles = await provisionAppRoles(client, 'app', 'postgres');
  host = await AppHost.open(dir, {
    store: new MemoryVersionStore(),
    tenantId: TENANT,
    database: {
      ...pg.config,
      client: recording(client),
      roles,
    },
  });
  for (const command of [
    {
      type: 'defineModel' as const,
      name: 'Chore',
      fields: {
        title: { type: 'text' as const },
        qty: { type: 'integer' as const },
        label: {
          type: 'text' as const,
          calculated: {
            op: 'concat' as const,
            operands: [
              { col: 'title' },
              { value: "it's \\ '); DROP TABLE u_chores; --" },
            ],
          },
        },
      },
    },
  ])
    await host.execute(hostOwner(host), command, {
      author: 't',
      approved: true,
    });
});
afterAll(async () => {
  await host.close();
  await pg.release?.();
  rmSync(dir, { recursive: true, force: true });
});

describe('the host thread writes the role and the settings', () => {
  it('boot ran as the owner role, a user op as the runtime role with its own settings', async () => {
    expect(log.some((l) => l.sql === 'SET LOCAL ROLE "app_o"')).toBe(true);
    log = [];
    await host.list(owner(), 'Chore');
    expect(log.map((l) => l.sql)).toContain('SET LOCAL ROLE "app_r"');
    expect(userIds()).toContain('owner');
    // BEGIN is PGlite's own; the settings come before any table is touched
    const firstTable = log.findIndex((l) => /\bu_chores\b/.test(l.sql));
    const role = log.findIndex((l) => l.sql === 'SET LOCAL ROLE "app_r"');
    expect(role).toBeGreaterThan(-1);
    expect(role).toBeLessThan(firstTable);
  });

  it('a formula string literal with quotes, backslash and SQL round-trips as data', async () => {
    const row = await host.create(owner(), 'Chore', { title: 'x', qty: 1 });
    expect(row.label).toBe("xit's \\ '); DROP TABLE u_chores; --");
    expect(await host.list(owner(), 'Chore')).not.toHaveLength(0);
  });
});

describe('acceptance 1: no principal, zero broker statements', () => {
  it('every WORKER_OPS entry without a caller rejects and touches nothing', async () => {
    expect(Object.keys(OP_LANES).sort()).toEqual([...WORKER_OPS].sort());
    const app: AppWorker = internals().app;
    log = [];
    for (const op of WORKER_OPS) {
      await expect(internals().onApp(undefined, op), op).rejects.toBeInstanceOf(
        NoPrincipalError,
      );
      await expect(app.call(op, undefined as any), op).rejects.toBeInstanceOf(
        NoPrincipalError,
      );
      await expect(
        app.call(op, user('x', [], '00000000-0000-4000-8000-0000000000b2')),
        op,
      ).rejects.toBeInstanceOf(PermissionDeniedError);
    }
    expect(log).toEqual([]);
  });

  it('OP_LANES: only the dump and purge work is the owner lane, pruneSnapshots touches no database', () => {
    expect(
      Object.entries(OP_LANES)
        .filter(([, lane]) => lane === 'owner')
        .map(([op]) => op)
        .sort(),
    ).toEqual(['copyTo', 'purgeArchives', 'snapshot']);
    expect(OP_LANES.pruneSnapshots).toBe('none');
  });
});

describe('two principals submitted together (acceptance 2, PGlite)', () => {
  // A worker runs one operation at a time, so these are queued, not parallel:
  // what is proved is that no op ever runs under another caller's identity.
  it('P1 reads but cannot write, P2 writes, each op carries its own user id', async () => {
    const p1 = user('p1', [
      slugFor(host.def, 'Chore', 'list'),
      slugFor(host.def, 'Chore', 'get'),
    ]);
    const p2 = user('p2', appPermissionSlugs(host.def));
    log = [];
    const results = await Promise.allSettled([
      host.list(p1, 'Chore'),
      host.create(p2, 'Chore', { title: 'p2-a', qty: 2 }),
      host.create(p1, 'Chore', { title: 'p1-denied', qty: 1 }),
      host.list(p2, 'Chore'),
      host.create(p2, 'Chore', { title: 'p2-b', qty: 3 }),
      host.list(p1, 'Chore'),
    ]);
    expect(results.map((r) => r.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'rejected',
      'fulfilled',
      'fulfilled',
      'fulfilled',
    ]);
    expect((results[2] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    const seen = new Set(userIds());
    expect(seen.has('p1')).toBe(true);
    expect(seen.has('p2')).toBe(true);
    const titles = (await host.list(owner(), 'Chore')).map((r) => r.title);
    expect(titles).toEqual(expect.arrayContaining(['p2-a', 'p2-b']));
    expect(titles).not.toContain('p1-denied');
  });
});
