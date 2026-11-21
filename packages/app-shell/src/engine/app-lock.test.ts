// One host per app on a PostgreSQL server (#5187): a live host claims its
// app's schema with a session advisory lock on a connection of its own,
// BEFORE its start-up recovery and sweep drop anything. A real second session
// is the registered postgres suite's job (postgres-server.test.ts); here the
// server's lock semantics are modelled (a key is held by at most one session)
// and every statement the claim sends is recorded.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDatabase } from '@happyvertical/sql';
import { importPGlite } from '@happyvertical/sql/pglite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { releaseAppLock, tryAppLock } from './db/postgres-copy.ts';
import { AppHost, MemoryVersionStore } from './index.ts';

vi.mock('@happyvertical/sql', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@happyvertical/sql')>()),
  getDatabase: vi.fn(),
}));

/** The server: one holder per advisory key, and a session's locks end with it. */
function fakeServer() {
  const holders = new Map<string, number>();
  const log: Array<{ session: number; sql: string }> = [];
  const options: unknown[] = [];
  let sessions = 0;
  const closed: number[] = [];
  const connect = async (opts: unknown) => {
    options.push(opts);
    const session = ++sessions;
    return {
      query: async (sql: string) => {
        log.push({ session, sql });
        const key = /\((hashtext\(.*\))\)/.exec(sql)?.[1] ?? '';
        if (sql.includes('pg_try_advisory_lock')) {
          const held = holders.get(key);
          if (held !== undefined && held !== session)
            return { rows: [{ got: false }] };
          holders.set(key, session);
          return { rows: [{ got: true }] };
        }
        if (sql.includes('pg_advisory_unlock')) {
          if (holders.get(key) === session) holders.delete(key);
          return { rows: [{ pg_advisory_unlock: true }] };
        }
        throw new Error(`unexpected statement: ${sql}`);
      },
      close: async () => {
        closed.push(session);
        for (const [k, v] of holders) if (v === session) holders.delete(k);
      },
    };
  };
  return { connect, log, options, closed, holders };
}

const config = (schema: string) =>
  ({
    kind: 'postgres' as const,
    schema,
    connection: { url: 'postgres://fake/db', max: 2 },
  }) as const;

const dirs: string[] = [];
afterEach(() => {
  vi.mocked(getDatabase).mockReset();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'engine-app-lock-'));
  dirs.push(d);
  return d;
};

describe('the app lock statements', () => {
  it('are valid on a real PostgreSQL engine and take one two-int key per app', async () => {
    const { PGlite } = await importPGlite();
    const db = await PGlite.create();
    try {
      expect(await tryAppLock(db as any, 'app_a')).toBe(true);
      expect((await releaseAppLock(db as any, 'app_a')).rows[0]).toMatchObject({
        pg_advisory_unlock: true,
      });
    } finally {
      await db.close();
    }
  });
});

describe('claiming an app on a server', () => {
  it('a second host for the same schema is refused with a clear error, after the claim and before anything else', async () => {
    const server = fakeServer();
    vi.mocked(getDatabase).mockImplementation(server.connect as any);
    const store = new MemoryVersionStore();
    const { claimApp } = await import('./db/postgres.ts');
    const release = await claimApp(config('app_held'));
    expect(release).toBeTypeOf('function');
    server.log.length = 0;
    await expect(
      AppHost.open(tmp(), { store, database: config('app_held') }),
    ).rejects.toThrow(/another host already runs the app in schema app_held/);
    // The refused host sent ONE statement (the claim) and let go of its connection.
    expect(server.log).toHaveLength(1);
    expect(server.log[0].sql).toContain('pg_try_advisory_lock');
    expect(server.closed).toContain(server.log[0].session);
    // A different app is not affected; once the first host lets go, this one can claim.
    await expect(claimApp(config('app_other'))).resolves.toBeTypeOf('function');
    await release?.();
    await expect(claimApp(config('app_held'))).resolves.toBeTypeOf('function');
  });

  it('a host whose start fails lets go of its claim', async () => {
    const server = fakeServer();
    vi.mocked(getDatabase).mockImplementation(server.connect as any);
    // The fake server has no schemas to read: the start fails after the claim.
    await expect(
      AppHost.open(tmp(), {
        store: new MemoryVersionStore(),
        database: config('app_failstart'),
      }),
    ).rejects.toThrow();
    expect(server.log[0].sql).toContain('pg_try_advisory_lock');
    expect(server.holders.size).toBe(0);
    expect(server.closed).toContain(server.log[0].session);
  });

  it('holds the lock on a connection of its own that is never pooled, shared or idle-closed', async () => {
    const server = fakeServer();
    vi.mocked(getDatabase).mockImplementation(server.connect as any);
    const { claimApp } = await import('./db/postgres.ts');
    const release = await claimApp(config('app_opts'));
    expect(server.options[0]).toMatchObject({
      type: 'postgres',
      max: 1,
      idleTimeoutMillis: 0,
      cache: false,
    });
    expect(server.holders.size).toBe(1);
    await release?.();
    expect(server.holders.size).toBe(0);
    expect(server.closed).toHaveLength(1);
  });

  it('a PGlite or SQLite host claims nothing', async () => {
    const { claimApp } = await import('./db/postgres.ts');
    const { claimAppDatabase } = await import('./db/index.ts');
    await expect(claimApp({ kind: 'pglite' } as any)).resolves.toBeUndefined();
    await expect(claimAppDatabase({ kind: 'sqlite' })).resolves.toBeUndefined();
    expect(getDatabase).not.toHaveBeenCalled();
  });
});
