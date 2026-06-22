/**
 * Unit tests for the Dispatch model (src/dispatch/models/Dispatch.ts).
 *
 * Focus: the constructor / fromRow JSON-field guard (#1378). A single corrupted
 * `payload`/`metadata` value in a `_smrt_dispatch` row must not throw out of the
 * constructor, because process()/list() map fromRow over a whole batch — one
 * poison row would otherwise stall every dispatch in the batch.
 */

import { describe, expect, it } from 'vitest';
import { Dispatch, type DispatchData } from './Dispatch.js';

function rowWith(overrides: Partial<DispatchData>): DispatchData {
  return {
    id: 'd-1',
    type: 'order.placed',
    source: 'orders',
    source_id: null,
    payload: '{}',
    status: 'pending',
    attempts: 0,
    last_error: null,
    processed_at: null,
    processed_by: null,
    target_subscriber: null,
    correlation_id: null,
    tenant_id: null,
    metadata: '{}',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('Dispatch JSON-field parsing', () => {
  it('parses well-formed payload and metadata', () => {
    const dispatch = Dispatch.fromRow(
      rowWith({
        payload: JSON.stringify({ orderId: '42' }),
        metadata: JSON.stringify({ traceId: 'abc' }),
      }),
    );
    expect(dispatch.payload).toEqual({ orderId: '42' });
    expect(dispatch.metadata).toEqual({ traceId: 'abc' });
  });

  it('does not throw on a corrupted payload; falls back to {}', () => {
    expect(() =>
      Dispatch.fromRow(rowWith({ payload: '{not valid json' })),
    ).not.toThrow();

    const dispatch = Dispatch.fromRow(rowWith({ payload: '{not valid json' }));
    expect(dispatch.payload).toEqual({});
  });

  it('does not throw on corrupted metadata; falls back to {}', () => {
    const dispatch = Dispatch.fromRow(rowWith({ metadata: 'not-json' }));
    expect(dispatch.metadata).toEqual({});
  });

  it('keeps the other field intact when only one is corrupted', () => {
    const dispatch = Dispatch.fromRow(
      rowWith({
        payload: JSON.stringify({ keep: true }),
        metadata: '<<<corrupt>>>',
      }),
    );
    expect(dispatch.payload).toEqual({ keep: true });
    expect(dispatch.metadata).toEqual({});
  });

  it('treats null/empty JSON columns as {}', () => {
    const dispatch = Dispatch.fromRow(
      rowWith({ payload: null, metadata: null }),
    );
    expect(dispatch.payload).toEqual({});
    expect(dispatch.metadata).toEqual({});
  });
});
