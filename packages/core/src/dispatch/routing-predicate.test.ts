/**
 * One routing predicate (P6 T28): a row is routed to a subscriber when ANY of
 * its matching subscriptions routes it, not only the first one found.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type DispatchTestDatabase,
  dispatchStatus,
  dispatchTestEngines,
  openDispatchTestDatabase,
  rowsOf,
} from '../__tests__/fixtures/dispatch-test-db';
import type { DispatchMetadata } from './types.js';

describe.each(
  dispatchTestEngines,
)('dispatch routing predicate on %s', (engine) => {
  let ctx: DispatchTestDatabase;

  beforeEach(async () => {
    ctx = await openDispatchTestDatabase(engine as 'sqlite');
  });

  afterEach(async () => {
    await ctx?.close();
  });

  it('overlapping fanout+compete subs; targeted copy survives delivery upsert', async () => {
    const { bus, db } = ctx;
    // 'order.*' sorts before 'order.placed', so a first-match rule would
    // decide the compete row by the fanout subscription.
    await bus.subscribe({
      signalType: 'order.*',
      subscriber: 'ledger',
      delivery: 'fanout',
    });
    await bus.subscribe({ signalType: 'order.placed', subscriber: 'ledger' });
    await bus.subscribe({
      signalType: 'order.*',
      subscriber: 'auditor',
      delivery: 'fanout',
    });

    await bus.emit('order.placed', { n: 1 }, { source: 'shop' });
    const rows = rowsOf(
      await db.query(
        'SELECT id, target_subscriber FROM _smrt_dispatch ORDER BY id',
      ),
    );
    const competeRow = rows.find((r) => r.target_subscriber == null);
    const auditorCopy = rows.find((r) => r.target_subscriber === 'auditor');
    expect(competeRow).toBeDefined();
    expect(auditorCopy).toBeDefined();

    const seen: DispatchMetadata[] = [];
    const count = await bus.process('ledger', async (_payload, metadata) => {
      seen.push(metadata);
    });

    // Its own fanout copy and the shared compete row; never the auditor's.
    expect(count).toBe(2);
    expect(seen.map((m) => m.id)).toContain(competeRow?.id);
    expect(seen.map((m) => m.id)).not.toContain(auditorCopy?.id);
    expect(await dispatchStatus(db, competeRow?.id as string)).toBe(
      'completed',
    );
    expect(await dispatchStatus(db, auditorCopy?.id as string)).toBe('pending');

    // A targeted copy stays routed after the subscription's delivery changes.
    await bus.subscribe({
      signalType: 'audit.*',
      subscriber: 'ledger',
      delivery: 'fanout',
    });
    await bus.emit('audit.logged', {}, { source: 'shop' });
    await bus.subscribe({
      signalType: 'audit.*',
      subscriber: 'ledger',
      delivery: 'compete',
    });
    const afterUpsert = await bus.process('ledger', async () => {});
    expect(afterUpsert).toBe(1);
  });
});
