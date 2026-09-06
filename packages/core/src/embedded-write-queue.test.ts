/**
 * Unit tests for the in-process embedded write-queue's serialization
 * identity (#2707).
 *
 * `queueKey()` used to derive the queue identity from the literal `.url`
 * string whenever it was a non-empty string. `resolveDuckDBUrl(':memory:')`
 * (in `@happyvertical/sql`) returns `':memory:'` unchanged with no
 * per-instance suffix, so every independent `:memory:` database handle in
 * one process shared the SAME queue key -- unrelated in-memory test
 * databases serialized their writes against each other, contradicting
 * `getTestDatabase()`'s doc claim of being "safe for parallel test
 * execution". A `cache=shared` URL is the opposite case: it is SQLite's own
 * mechanism for making an in-memory database genuinely shared state across
 * connections, so it must keep serializing.
 *
 * These tests exercise `withEmbeddedWriteQueue()` (the public surface)
 * rather than the private `queueKey()`/`isPerConnectionMemoryUrl()`
 * helpers directly. Every case resolves its gate BEFORE awaiting either
 * operation and asserts on relative push order, rather than racing a
 * still-pending operation against the Vitest global test timeout: a
 * regression here still fails fast and deterministically (no dangling
 * `urlQueues`/`handleQueues` entry left pending past the end of the test),
 * it just fails on a wrong `order` array instead of a slow timeout.
 */

import { describe, expect, it } from 'vitest';
import { withEmbeddedWriteQueue } from './embedded-write-queue';

/** A minimal deferred promise for controlling operation completion order. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Queue `dbA`'s operation first, holding it open on `gate`, then queue
 * `dbB`'s operation (a single synchronous push), resolve the gate
 * immediately, and return the settled push order for both.
 *
 * Independent queue identities interleave as `['A-start', 'B', 'A-end']`
 * (B's synchronous push runs before A's held operation resumes). A shared
 * queue identity serializes as `['A-start', 'A-end', 'B']` (B's `run` is
 * chained onto A's still-pending tail and only fires once it settles).
 */
async function raceTwoWrites(
  dbA: { url: string },
  dbB: { url: string },
): Promise<string[]> {
  const gate = deferred();
  const order: string[] = [];

  const opA = withEmbeddedWriteQueue(dbA, true, async () => {
    order.push('A-start');
    await gate.promise;
    order.push('A-end');
  });
  const opB = withEmbeddedWriteQueue(dbB, true, async () => {
    order.push('B');
  });

  gate.resolve();
  await Promise.all([opA, opB]);
  return order;
}

describe('withEmbeddedWriteQueue', () => {
  it('does not serialize two independent `:memory:` instances', async () => {
    const order = await raceTwoWrites({ url: ':memory:' }, { url: ':memory:' });
    expect(order).toEqual(['A-start', 'B', 'A-end']);
  });

  it('treats a bare `file::memory:` URL (no query string) as per-instance', async () => {
    const order = await raceTwoWrites(
      { url: 'file::memory:' },
      { url: 'file::memory:' },
    );
    expect(order).toEqual(['A-start', 'B', 'A-end']);
  });

  it('serializes two instances sharing a `cache=shared` URL', async () => {
    const url = 'file::memory:?cache=shared';
    const order = await raceTwoWrites({ url }, { url });
    expect(order).toEqual(['A-start', 'A-end', 'B']);
  });

  it('serializes two instances sharing a file-backed URL', async () => {
    const url = '/tmp/embedded-write-queue-test.db';
    const order = await raceTwoWrites({ url }, { url });
    expect(order).toEqual(['A-start', 'A-end', 'B']);
  });
});
