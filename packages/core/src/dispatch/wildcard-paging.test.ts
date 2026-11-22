/**
 * Oldest-first candidate paging (P6 T21, T25): routing, patterns and
 * `signalTypes` apply before the page limit; keyset pages visit every row
 * once, whatever its id text or timestamp ties.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type DispatchTestDatabase,
  dispatchStatus,
  dispatchTestEngines,
  insertRawDispatch,
  openDispatchTestDatabase,
  rowsOf,
} from '../__tests__/fixtures/dispatch-test-db';

describe.each(
  dispatchTestEngines,
)('dispatch candidate paging on %s', (engine) => {
  let ctx: DispatchTestDatabase;

  beforeEach(async () => {
    ctx = await openDispatchTestDatabase(engine as 'sqlite');
  });

  afterEach(async () => {
    await ctx?.close();
  });

  it('processes a matching row behind 120 newer non-matching rows on the first call', async () => {
    const { bus, db } = ctx;
    await bus.subscribe({ signalType: 'invoice.*', subscriber: 'billing' });
    await insertRawDispatch(db, {
      id: 'match-oldest',
      type: 'invoice.paid',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    for (let i = 0; i < 120; i++) {
      await insertRawDispatch(db, {
        id: `other-${String(i).padStart(3, '0')}`,
        type: 'shipment.sent',
        createdAt: `2026-02-01T00:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z`,
      });
    }

    const seen: string[] = [];
    const count = await bus.process('billing', async (_p, metadata) => {
      seen.push(metadata.id);
    });
    expect(count).toBe(1);
    expect(seen).toEqual(['match-oldest']);
    expect(await dispatchStatus(db, 'match-oldest')).toBe('completed');
  });

  it('claims oldest first: undated rows by id, then by created_at and id', async () => {
    const { bus, db } = ctx;
    await bus.subscribe({ signalType: 'job.*', subscriber: 'runner' });
    await insertRawDispatch(db, {
      id: 'd-late',
      type: 'job.run',
      createdAt: '2026-05-03T00:00:00.000Z',
    });
    await insertRawDispatch(db, {
      id: 'd-early',
      type: 'job.run',
      createdAt: '2026-05-01T00:00:00.000Z',
    });
    await insertRawDispatch(db, {
      id: 'u-b',
      type: 'job.run',
      createdAt: null,
    });
    await insertRawDispatch(db, {
      id: 'u-a',
      type: 'job.run',
      createdAt: null,
    });
    await insertRawDispatch(db, {
      id: 'd-mid',
      type: 'job.run',
      createdAt: '2026-05-02T00:00:00.000Z',
    });

    const seen: string[] = [];
    await bus.process('runner', async (_p, metadata) => {
      seen.push(metadata.id);
    });
    expect(seen).toEqual(['u-a', 'u-b', 'd-early', 'd-mid', 'd-late']);
  });

  it('applies signalTypes before the limit on wildcard and exact subscriptions', async () => {
    const { bus, db } = ctx;
    await bus.subscribe({ signalType: 'invoice.*', subscriber: 'billing' });
    await bus.subscribe({ signalType: 'a.b', subscriber: 'exact' });
    await bus.subscribe({ signalType: 'a.c', subscriber: 'exact' });
    await insertRawDispatch(db, {
      id: 'inv-sent',
      type: 'invoice.sent',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await insertRawDispatch(db, {
      id: 'inv-paid',
      type: 'invoice.paid',
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    await insertRawDispatch(db, {
      id: 'ab',
      type: 'a.b',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await insertRawDispatch(db, {
      id: 'ac',
      type: 'a.c',
      createdAt: '2026-01-02T00:00:00.000Z',
    });

    expect(
      await bus.process('billing', async () => {}, {
        limit: 1,
        signalTypes: ['invoice.paid'],
      }),
    ).toBe(1);
    expect(await dispatchStatus(db, 'inv-paid')).toBe('completed');
    expect(await dispatchStatus(db, 'inv-sent')).toBe('pending');

    expect(
      await bus.process('exact', async () => {}, {
        limit: 1,
        signalTypes: ['a.c'],
      }),
    ).toBe(1);
    expect(await dispatchStatus(db, 'ac')).toBe('completed');
    expect(await dispatchStatus(db, 'ab')).toBe('pending');
  });

  it('identical timestamps and arbitrary text ids page once each', async () => {
    const { bus, db } = ctx;
    await bus.subscribe({ signalType: 'bulk.*', subscriber: 'bulk' });
    const ids = [
      'zzz',
      'ID-1',
      'id-1',
      '0',
      '10',
      '9',
      ' spaced',
      'üñí',
      'a.b.c',
    ];
    for (let i = 0; i < 241; i++) ids.push(`gen-${i}`);
    for (const id of ids) {
      await insertRawDispatch(db, {
        id,
        type: 'bulk.item',
        createdAt: '2026-03-01T00:00:00.000Z',
      });
    }

    const seen: string[] = [];
    const count = await bus.process(
      'bulk',
      async (_p, metadata) => {
        seen.push(metadata.id);
      },
      { limit: 1000 },
    );
    expect(count).toBe(ids.length);
    expect(new Set(seen).size).toBe(ids.length);
    expect([...seen].sort()).toEqual([...ids].sort());
    const left = rowsOf(
      await db.query(
        "SELECT COUNT(*) AS n FROM _smrt_dispatch WHERE status <> 'completed'",
      ),
    );
    expect(Number(left[0]?.n)).toBe(0);
  });
});
