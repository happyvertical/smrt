/**
 * Oldest-first candidate paging on PostgreSQL (P6 T21, T25, T26 NULL
 * cases). Runs only in the disposable PostgreSQL lane
 * (`SMRT_TEST_POSTGRES_URL`).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type DispatchTestDatabase,
  dispatchStatus,
  insertRawDispatch,
  openPostgresDispatchDatabase,
  postgresDispatchUrl,
} from '../__tests__/fixtures/dispatch-test-db';

const postgresDescribe = postgresDispatchUrl
  ? describe.sequential
  : describe.skip;

postgresDescribe('dispatch candidate paging on PostgreSQL (optional)', () => {
  let ctx: DispatchTestDatabase;

  beforeEach(async () => {
    ctx = await openPostgresDispatchDatabase('paging');
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
    expect(
      await bus.process('billing', async (_p, metadata) => {
        seen.push(metadata.id);
      }),
    ).toBe(1);
    expect(seen).toEqual(['match-oldest']);
  });

  it('identical timestamps and arbitrary text ids page once each', async () => {
    const { bus, db } = ctx;
    await bus.subscribe({ signalType: 'bulk.*', subscriber: 'bulk' });
    const ids = ['zzz', 'ID-1', 'id-1', '0', '10', '9', ' spaced', 'üñí'];
    for (let i = 0; i < 242; i++) ids.push(`gen-${i}`);
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
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  it('NULL attempts and NULL created_at ahead of healthy rows do not block them', async () => {
    const { bus, db } = ctx;
    await bus.subscribe({ signalType: 'task.run', subscriber: 'worker' });
    await insertRawDispatch(db, {
      id: 'null-attempts',
      type: 'task.run',
      attempts: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await insertRawDispatch(db, {
      id: 'null-created',
      type: 'task.run',
      createdAt: null,
    });
    await insertRawDispatch(db, {
      id: 'healthy',
      type: 'task.run',
      createdAt: '2026-02-01T00:00:00.000Z',
    });
    const seen: string[] = [];
    expect(
      await bus.process('worker', async (_p, metadata) => {
        seen.push(metadata.id);
      }),
    ).toBe(3);
    expect(seen).toEqual(['null-created', 'null-attempts', 'healthy']);
    expect(await dispatchStatus(db, 'healthy')).toBe('completed');
  });
});
