// The shared connection pool's accounting (#5188): the hard cap, the per-app
// cap, the bounded queue, the acquire timeout and the slot's return, against a
// fake driver, so no database is involved. What a real server shows (the
// server-side connection count under load) is in broker-pool.postgres.test.ts.

import { describe, expect, it } from 'vitest';
import {
  BrokerPool,
  type PoolDriver,
  type PoolLane,
  type PoolSession,
} from './db/pool.ts';
import { CapacityError, DatabaseBusyError } from './errors.ts';

interface Fake extends PoolDriver {
  lanes: PoolLane[];
  open: number;
  everOpened: number;
  failNext: boolean;
  hangRelease: boolean;
  cancelled: Array<[PoolLane, number]>;
}

function fakeDriver(): Fake {
  const d: Fake = {
    lanes: [],
    open: 0,
    everOpened: 0,
    failNext: false,
    hangRelease: false,
    cancelled: [],
    async connect(lane) {
      if (d.failNext) {
        d.failNext = false;
        throw new Error('connection refused');
      }
      d.lanes.push(lane);
      d.open++;
      d.everOpened++;
      let done = false;
      const s: PoolSession = {
        query: async () => ({ rows: [] }),
        release: async () => {
          if (done) return;
          done = true;
          if (d.hangRelease) await new Promise(() => {});
          d.open--;
        },
      };
      return s;
    },
    async cancel(lane, pid) {
      d.cancelled.push([lane, pid]);
    },
  };
  return d;
}

const opts = {
  max: 2,
  perApp: 2,
  maxQueued: 2,
  acquireTimeoutMs: 1000,
  releaseTimeoutMs: 50,
};
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('BrokerPool', () => {
  it('never holds more connections than its cap, and hands a freed slot to the oldest waiter', async () => {
    const d = fakeDriver();
    const pool = new BrokerPool(d, opts);
    const a = await pool.acquire('t1');
    const b = await pool.acquire('t2');
    expect(pool.stats).toMatchObject({ inUse: 2, queued: 0 });
    const order: string[] = [];
    const c = pool.acquire('t3').then((l) => {
      order.push('c');
      return l;
    });
    const e = pool.acquire('t4').then((l) => {
      order.push('e');
      return l;
    });
    await tick();
    expect(pool.stats.queued).toBe(2);
    expect(d.open).toBe(2);
    await a.release();
    const cl = await c;
    expect(order).toEqual(['c']);
    expect(d.open).toBe(2);
    await b.release();
    const el = await e;
    expect(order).toEqual(['c', 'e']);
    await cl.release();
    await el.release();
    expect(pool.stats).toMatchObject({ inUse: 0, queued: 0 });
    expect(d.open).toBe(0);
  });

  it("caps one app's concurrent transactions; another app is not held up", async () => {
    const d = fakeDriver();
    const pool = new BrokerPool(d, { ...opts, max: 4, perApp: 1 });
    const a1 = await pool.acquire('a');
    let a2: unknown;
    const second = pool.acquire('a').then((l) => (a2 = l));
    await tick();
    expect(a2).toBeUndefined();
    // The other app takes a free slot even though a's second request is queued first.
    const b = await pool.acquire('b');
    expect(pool.stats.perApp).toEqual({ a: 1, b: 1 });
    await a1.release();
    await second;
    expect(a2).toBeDefined();
    await b.release();
    await (a2 as { release(): Promise<void> }).release();
  });

  it('refuses at once with a 503-style error when the queue is full', async () => {
    const pool = new BrokerPool(fakeDriver(), { ...opts, maxQueued: 1 });
    const a = await pool.acquire('a');
    const b = await pool.acquire('b');
    const waiting = pool.acquire('c');
    const started = Date.now();
    const err = await pool.acquire('d').catch((e) => e);
    expect(Date.now() - started).toBeLessThan(100);
    expect(err).toBeInstanceOf(DatabaseBusyError);
    expect(err).toBeInstanceOf(CapacityError);
    expect(err.code).toBe('unavailable');
    expect(err.message).toMatch(/too many operations/);
    await a.release();
    await (await waiting).release();
    await b.release();
  });

  it('refuses a request that waited past the acquire timeout, and later requests still work', async () => {
    const d = fakeDriver();
    const pool = new BrokerPool(d, { ...opts, max: 1, acquireTimeoutMs: 30 });
    const held = await pool.acquire('a');
    const err = await pool.acquire('b').catch((e) => e);
    expect(err).toBeInstanceOf(DatabaseBusyError);
    expect(err.message).toMatch(/timed out/);
    expect(pool.stats.queued).toBe(0);
    await held.release();
    await (await pool.acquire('b')).release();
  });

  it('counts the owner lane in the same cap, on its own credentials', async () => {
    const d = fakeDriver();
    const pool = new BrokerPool(d, { ...opts, max: 2, acquireTimeoutMs: 20 });
    const data = await pool.acquire('a', 'data');
    const owner = await pool.acquire('a', 'owner');
    expect(d.lanes).toEqual(['data', 'owner']);
    const refused = await pool.acquire('b', 'data').catch((e) => e);
    expect(refused).toBeInstanceOf(DatabaseBusyError);
    await owner.release();
    await data.release();
  });

  it('gives the slot back when the connection cannot be opened', async () => {
    const d = fakeDriver();
    const pool = new BrokerPool(d, { ...opts, max: 1 });
    d.failNext = true;
    await expect(pool.acquire('a')).rejects.toThrow('connection refused');
    expect(pool.stats.inUse).toBe(0);
    await (await pool.acquire('a')).release();
  });

  it('frees a slot whose release hangs, after the release timeout, and once only', async () => {
    const d = fakeDriver();
    const pool = new BrokerPool(d, { ...opts, max: 1 });
    d.hangRelease = true;
    const lease = await pool.acquire('a');
    const next = pool.acquire('b');
    await lease.release();
    await lease.release(); // idempotent
    expect(pool.stats.inUse).toBe(1); // b took it
    d.hangRelease = false;
    await (await next).release();
    expect(pool.stats.inUse).toBe(0);
  });

  it('close refuses the waiters and later requests', async () => {
    const pool = new BrokerPool(fakeDriver(), { ...opts, max: 1 });
    const held = await pool.acquire('a');
    const waiting = pool.acquire('b');
    await pool.close();
    await expect(waiting).rejects.toThrow(/closed/);
    await expect(pool.acquire('c')).rejects.toThrow(/closed/);
    await held.release();
  });

  it('refuses a nonsense size', () => {
    for (const bad of [0, -1, 1.5, Number.NaN])
      expect(() => new BrokerPool(fakeDriver(), { ...opts, max: bad })).toThrow(
        RangeError,
      );
    expect(
      () => new BrokerPool(fakeDriver(), { ...opts, maxQueued: -1 }),
    ).toThrow(RangeError);
  });
});
