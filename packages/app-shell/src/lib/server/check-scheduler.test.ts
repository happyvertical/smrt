// The debounce + per-batch serialisation of the changes checks (#5205).
import { describe, expect, it } from 'vitest';
import { type CheckClock, createCheckScheduler } from './check-scheduler.ts';

function fakeClock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: CheckClock = {
    setTimeout(fn, ms) {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(h) {
      timers.delete(h as number);
    },
  };
  return {
    clock,
    tick(ms: number) {
      now += ms;
      for (const [id, t] of [...timers])
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
    },
    pending: () => timers.size,
  };
}

describe('createCheckScheduler', () => {
  it('debounces: only the last schedule runs, after the delay', async () => {
    const f = fakeClock();
    const ran: [string, number][] = [];
    const s = createCheckScheduler({
      delayMs: 2000,
      clock: f.clock,
      run: async (id, gen) => {
        ran.push([id, gen]);
      },
    });
    s.schedule('b', 1);
    f.tick(1500);
    s.schedule('b', 2); // a new change restarts the wait
    f.tick(1500);
    expect(ran).toEqual([]);
    expect(s.busy('b')).toBe(true);
    f.tick(600);
    await s.flush();
    expect(ran).toEqual([['b', 2]]);
    expect(s.busy('b')).toBe(false);
  });

  it('serialises jobs of one batch and lets others run', async () => {
    const f = fakeClock();
    const log: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const s = createCheckScheduler({
      delayMs: 10,
      clock: f.clock,
      run: async (id, gen) => {
        log.push(`start ${id}${gen}`);
        if (id === 'a' && gen === 1) await gate;
        log.push(`end ${id}${gen}`);
      },
    });
    s.schedule('a', 1);
    f.tick(10);
    await Promise.resolve();
    s.schedule('a', 2);
    s.schedule('b', 1);
    f.tick(10);
    await new Promise((r) => setTimeout(r, 5));
    expect(log).toContain('end b1');
    expect(log).not.toContain('start a2'); // waits for a1
    release();
    await s.flush();
    expect(log.indexOf('end a1')).toBeLessThan(log.indexOf('start a2'));
  });

  it('a failing job does not break the queue; cancel drops a pending timer', async () => {
    const f = fakeClock();
    const ran: number[] = [];
    const s = createCheckScheduler({
      delayMs: 5,
      clock: f.clock,
      run: async (_id, gen) => {
        ran.push(gen);
        if (gen === 1) throw new Error('boom');
      },
    });
    s.schedule('a', 1);
    await s.flush();
    s.schedule('a', 2);
    s.cancel('a');
    expect(f.pending()).toBe(0);
    s.schedule('a', 3);
    await s.flush();
    expect(ran).toEqual([1, 3]);
  });
});
