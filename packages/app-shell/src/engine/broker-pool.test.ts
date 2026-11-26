// The broker on the shared pool (#5188): the pool's bounds reach an operation
// as a 503-style error, a deadline cancels the running statement before it
// rolls back, the owner lane takes its connection on the admin credentials, and
// a connection is cleaned (`DISCARD ALL`) before its slot is handed on.
// Against a scripted fake server, so it runs everywhere; a real server's
// version of these is in broker-pool.postgres.test.ts.

import { describe, expect, it } from 'vitest';
import { Broker, pooledBackend } from './db/broker.ts';
import {
  BrokerPool,
  type PoolDriver,
  type PoolLane,
  type PoolSession,
} from './db/pool.ts';
import { DatabaseBusyError, type EngineError } from './errors.ts';
import { enginePrincipal, mintSystemPrincipal } from './principal.ts';

const TENANT = 'tenant-a';
const SCHEMA = 'app_pool';
const user = (id = 'u') =>
  enginePrincipal({
    kind: 'user',
    tenantId: TENANT,
    userId: id,
    permissions: [],
  });

interface Server {
  driver: PoolDriver;
  /** Every statement, per session, in order. */
  sessions: Array<{ lane: PoolLane; pid: number; log: string[] }>;
  cancelled: Array<[PoolLane, number]>;
  /** SQL that blocks until its backend is cancelled. */
  hang: string;
}

function server(): Server {
  const s: Server = {
    sessions: [],
    cancelled: [],
    hang: 'SELECT slow',
    driver: undefined as never,
  };
  const waiting = new Map<number, (e: Error) => void>();
  let pids = 4000;
  s.driver = {
    async connect(lane) {
      const pid = ++pids;
      const rec = { lane, pid, log: [] as string[] };
      s.sessions.push(rec);
      let hung = false;
      const session: PoolSession = {
        async query(sql) {
          rec.log.push(sql);
          if (sql === 'SELECT pg_backend_pid() AS pid')
            return { rows: [{ pid }] };
          if (sql === s.hang) {
            hung = true;
            await new Promise<void>((_, reject) =>
              waiting.set(pid, (e) => reject(e)),
            );
          }
          // A rollback behind a statement that was never stopped waits.
          if (sql === 'ROLLBACK' && hung && waiting.has(pid))
            await new Promise(() => {});
          return { rows: [] };
        },
        async release() {
          rec.log.push('<release>');
        },
      };
      return session;
    },
    async cancel(lane, pid) {
      s.cancelled.push([lane, pid]);
      const stop = waiting.get(pid);
      waiting.delete(pid);
      stop?.(
        Object.assign(new Error('canceling statement'), { code: '57014' }),
      );
    },
  };
  return s;
}

const poolOpts = {
  max: 2,
  perApp: 2,
  maxQueued: 0,
  acquireTimeoutMs: 50,
  releaseTimeoutMs: 100,
};

describe('a database operation on the shared pool', () => {
  it('runs on a pooled connection, cleans it, and returns the slot only after the release', async () => {
    const fake = server();
    const pool = new BrokerPool(fake.driver, poolOpts);
    const broker = new Broker(pooledBackend(pool, TENANT), {
      tenantId: TENANT,
      schema: SCHEMA,
    });
    broker.register(1, { principal: user(), lane: 'data' });
    await broker.query(1, 'SELECT 1');
    expect(pool.stats.inUse).toBe(1);
    await broker.end(1, true);
    expect(pool.stats.inUse).toBe(0);
    const log = fake.sessions[0].log;
    expect(log[0]).toBe('BEGIN');
    expect(log.slice(-3)).toEqual(['COMMIT', 'DISCARD ALL', '<release>']);
    // nothing but its own statements ran on it before the operation's first one
    expect(log).toContain('SELECT 1');
  });

  it("takes the owner lane's connection on the owner credentials", async () => {
    const fake = server();
    const pool = new BrokerPool(fake.driver, poolOpts);
    const broker = new Broker(pooledBackend(pool, TENANT), {
      tenantId: TENANT,
      schema: SCHEMA,
    });
    broker.register(1, {
      principal: mintSystemPrincipal(TENANT),
      lane: 'owner',
    });
    broker.register(2, { principal: user(), lane: 'data' });
    await broker.query(1, 'SELECT 1');
    await broker.query(2, 'SELECT 1');
    expect(fake.sessions.map((x) => x.lane)).toEqual(['owner', 'data']);
    expect(pool.stats.inUse).toBe(2); // both count in the one cap
    await broker.end(1, true);
    await broker.end(2, true);
  });

  it("a full pool surfaces to the caller as a 503-style engine error, never the worker's own", async () => {
    const fake = server();
    const pool = new BrokerPool(fake.driver, { ...poolOpts, max: 1 });
    const broker = new Broker(pooledBackend(pool, TENANT), {
      tenantId: TENANT,
      schema: SCHEMA,
    });
    broker.register(1, { principal: user('a'), lane: 'data' });
    broker.register(2, { principal: user('b'), lane: 'data' });
    await broker.query(1, 'SELECT 1');
    const refused = await broker.query(2, 'SELECT 1').catch((e) => e);
    expect(refused).toBeInstanceOf(DatabaseBusyError);
    // The worker replied with a failure of its own; the call still fails as busy.
    const outcome = await broker.end(2, false).catch((e) => e);
    expect(outcome).toBeInstanceOf(DatabaseBusyError);
    expect((outcome as EngineError).code).toBe('unavailable');
    await broker.end(1, true);
    expect(pool.stats.inUse).toBe(0);
  });

  it("one app's transactions are capped: a third waits until a slot is freed", async () => {
    const fake = server();
    const pool = new BrokerPool(fake.driver, {
      ...poolOpts,
      max: 4,
      perApp: 2,
      maxQueued: 4,
      acquireTimeoutMs: 1000,
    });
    const broker = new Broker(pooledBackend(pool, TENANT), {
      tenantId: TENANT,
      schema: SCHEMA,
    });
    for (const id of [1, 2, 3])
      broker.register(id, { principal: user(String(id)), lane: 'data' });
    await broker.query(1, 'SELECT 1');
    await broker.query(2, 'SELECT 1');
    let third = false;
    const t = broker.query(3, 'SELECT 1').then(() => {
      third = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(third).toBe(false);
    expect(pool.stats).toMatchObject({ inUse: 2, queued: 1 });
    await broker.end(1, true);
    await t;
    expect(third).toBe(true);
    await broker.end(2, true);
    await broker.end(3, true);
    expect(pool.stats.inUse).toBe(0);
  });

  it('the deadline cancels the running statement, then rolls back and frees the slot', async () => {
    const fake = server();
    const pool = new BrokerPool(fake.driver, poolOpts);
    const broker = new Broker(pooledBackend(pool, TENANT), {
      tenantId: TENANT,
      schema: SCHEMA,
      opDeadlineMs: 30,
    });
    broker.register(1, { principal: user(), lane: 'data' });
    const slow = broker.query(1, fake.hang).catch((e) => e);
    const err = await slow;
    expect((err as { code?: string }).code).toBe('57014');
    // cancelled from outside the connection, on the same lane and backend
    expect(fake.cancelled).toEqual([['data', fake.sessions[0].pid]]);
    // the rollback ran after the cancel (it would have waited otherwise)
    await new Promise((r) => setTimeout(r, 20));
    const log = fake.sessions[0].log;
    expect(log.indexOf('ROLLBACK')).toBeGreaterThan(log.indexOf(fake.hang));
    // the call fails with the deadline, and the slot is back
    await expect(broker.end(1, true)).rejects.toThrow(/30 ms deadline/);
    await new Promise((r) => setTimeout(r, 10));
    expect(pool.stats.inUse).toBe(0);
    // a fresh operation on the same pool runs
    broker.register(2, { principal: user(), lane: 'data' });
    await broker.query(2, 'SELECT 1');
    await broker.end(2, true);
  });

  it('destroys the connection when the rollback stalls behind a statement that did not stop', async () => {
    const fake = server();
    // A server that ignores the cancel: the statement keeps running.
    fake.driver.cancel = async (lane, pid) => {
      fake.cancelled.push([lane, pid]);
    };
    const pool = new BrokerPool(fake.driver, poolOpts);
    const broker = new Broker(pooledBackend(pool, TENANT), {
      tenantId: TENANT,
      schema: SCHEMA,
      opDeadlineMs: 20,
    });
    broker.register(1, { principal: user(), lane: 'data' });
    void broker.query(1, fake.hang).catch(() => {});
    await new Promise((r) => setTimeout(r, 2300));
    const log = fake.sessions[0].log;
    expect(log).toContain('<release>');
    expect(log).not.toContain('DISCARD ALL'); // never pooled as clean
    expect(pool.stats.inUse).toBe(0);
    await broker.abortAll();
  }, 10_000);

  it('the default data-lane deadline leaves owner-lane work (boot, snapshots) alone', async () => {
    const fake = server();
    const pool = new BrokerPool(fake.driver, poolOpts);
    const broker = new Broker(pooledBackend(pool, TENANT), {
      tenantId: TENANT,
      schema: SCHEMA,
      dataOpDeadlineMs: 30,
    });
    broker.register(1, {
      principal: mintSystemPrincipal(TENANT),
      lane: 'owner',
    });
    broker.register(2, { principal: user(), lane: 'data' });
    await broker.query(1, 'SELECT 1');
    await broker.query(2, 'SELECT 1');
    await new Promise((r) => setTimeout(r, 250));
    await broker.end(1, true); // still open: commits
    await expect(broker.end(2, true)).rejects.toThrow(/30 ms deadline/);
    // an explicit deadline binds every lane
    const all = new Broker(pooledBackend(pool, TENANT), {
      tenantId: TENANT,
      schema: SCHEMA,
      opDeadlineMs: 30,
      dataOpDeadlineMs: 10_000,
    });
    all.register(3, { principal: mintSystemPrincipal(TENANT), lane: 'owner' });
    await all.query(3, 'SELECT 1');
    await new Promise((r) => setTimeout(r, 250));
    await expect(all.end(3, true)).rejects.toThrow(/30 ms deadline/);
  });
});
