/**
 * Malformed and legacy pending rows (P6 T26, pending phases): rows the bus
 * cannot read are skipped and never block the healthy rows behind them;
 * legacy NULL columns are processed.
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
)('malformed pending dispatch rows on %s', (engine) => {
  let ctx: DispatchTestDatabase;

  beforeEach(async () => {
    ctx = await openDispatchTestDatabase(engine as 'sqlite');
  });

  afterEach(async () => {
    await ctx?.close();
  });

  it('NULL attempts, NULL created_at and garbage timestamps ahead of healthy rows do not block them', async () => {
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
    if (engine === 'sqlite') {
      // Text a TIMESTAMP column accepts on SQLite but JavaScript cannot
      // parse, sorted ahead of every healthy row.
      await insertRawDispatch(db, {
        id: 'garbage-created',
        type: 'task.run',
        createdAt: '0000-garbage',
      });
      await db.query(
        `INSERT INTO _smrt_dispatch (id, type, source, payload, status, attempts, metadata, created_at, updated_at)
         VALUES ('garbage-attempts', 'task.run', 'test', '{}', 'pending', 'many', '{}', '0000-01-01T00:00:00.000Z', '0000-01-01T00:00:00.000Z')`,
      );
    }
    await insertRawDispatch(db, {
      id: 'healthy-1',
      type: 'task.run',
      createdAt: '2026-02-01T00:00:00.000Z',
    });
    await insertRawDispatch(db, {
      id: 'healthy-2',
      type: 'task.run',
      createdAt: '2026-02-02T00:00:00.000Z',
    });

    const seen: string[] = [];
    const count = await bus.process('worker', async (_p, metadata) => {
      seen.push(metadata.id);
      if (metadata.id === 'null-attempts') {
        expect(metadata.attempts).toBe(1);
      }
    });

    expect(seen).toEqual([
      'null-created',
      'null-attempts',
      'healthy-1',
      'healthy-2',
    ]);
    expect(count).toBe(4);
    expect(await dispatchStatus(db, 'healthy-1')).toBe('completed');
    expect(await dispatchStatus(db, 'healthy-2')).toBe('completed');
    const attempts = rowsOf(
      await db.query(
        "SELECT attempts FROM _smrt_dispatch WHERE id = 'null-attempts'",
      ),
    );
    expect(Number(attempts[0]?.attempts)).toBe(1);
    if (engine === 'sqlite') {
      // Skipped, not claimed: still pending and untouched.
      expect(await dispatchStatus(db, 'garbage-created')).toBe('pending');
      expect(await dispatchStatus(db, 'garbage-attempts')).toBe('pending');
    }
  });
});
