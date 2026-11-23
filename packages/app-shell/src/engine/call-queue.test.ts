// The per-worker call queue (#5188): calls run one at a time, in order, and a
// call that finds the queue full is refused with the pool's busy error.

import { describe, expect, it } from 'vitest';
import { CallQueue, MAX_QUEUED_CALLS } from './call-queue.ts';
import { DatabaseBusyError } from './errors.ts';

const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => {
    open = r;
  });
  return { p, open };
};

describe('CallQueue', () => {
  it('runs calls one at a time and in order', async () => {
    const q = new CallQueue(8);
    const order: string[] = [];
    const g = gate();
    const a = q.push(async () => {
      order.push('a:start');
      await g.p;
      order.push('a:end');
    });
    const b = q.push(async () => {
      order.push('b');
    });
    await Promise.resolve();
    expect(order).toEqual(['a:start']);
    g.open();
    await Promise.all([a, b]);
    expect(order).toEqual(['a:start', 'a:end', 'b']);
  });

  it('refuses a call past the bound with a DatabaseBusyError, then recovers', async () => {
    const q = new CallQueue(2);
    const g = gate();
    const held = [
      q.push(() => g.p), // running
      q.push(() => g.p), // waiting 1
      q.push(() => g.p), // waiting 2
    ];
    expect(q.depth).toBe(2);
    expect(() => q.push(async () => 1)).toThrow(DatabaseBusyError);
    expect(q.depth).toBe(2);
    g.open();
    await Promise.all(held);
    expect(q.depth).toBe(0);
    await expect(q.push(async () => 'ok')).resolves.toBe('ok');
  });

  it('a failing call frees its place', async () => {
    const q = new CallQueue(1);
    await expect(
      q.push(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(q.push(async () => 'ok')).resolves.toBe('ok');
  });

  it('defaults to the shared pool queue bound', () => {
    expect(MAX_QUEUED_CALLS).toBe(64);
  });
});
