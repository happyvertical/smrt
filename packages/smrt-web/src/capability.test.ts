/**
 * Unit tests for the capability seam's pure runner (#1755).
 *
 * These cover `runWrapMutation` in isolation — no engine, no factory — so the
 * array-order / first-handled-wins contract is pinned down independently of the
 * integration wiring (which lives in capability-integration.test.ts).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  runWrapMutation,
  type SmrtWebCapability,
  type SmrtWebCapabilityContext,
  type SmrtWebMutationEnvelope,
} from './index.js';

interface Row {
  id?: string;
  name: string;
}

const envelope: SmrtWebMutationEnvelope = {
  kind: 'insert',
  key: 'local-1',
  data: { name: 'Widget' },
};

/** A throwaway context — the runner only forwards it, never reads it. */
const ctx = {} as SmrtWebCapabilityContext<Row>;

function cap(
  name: string,
  wrapMutation?: SmrtWebCapability<Row>['wrapMutation'],
): SmrtWebCapability<Row> {
  return { name, wrapMutation };
}

describe('runWrapMutation', () => {
  it('returns { handled: false } when there are no capabilities', async () => {
    expect(await runWrapMutation<Row>([], envelope, ctx)).toEqual({
      handled: false,
    });
  });

  it('returns { handled: false } when every capability declines', async () => {
    const a = cap('a', async () => ({ handled: false }) as const);
    const b = cap('b', async () => undefined);
    const c = cap('c'); // no wrapMutation hook at all
    expect(await runWrapMutation<Row>([a, b, c], envelope, ctx)).toEqual({
      handled: false,
    });
  });

  it('returns the first { handled: true } result', async () => {
    const handled = cap('handler', async () => ({
      handled: true,
      result: { id: 'server-1', name: 'Widget' },
    }));
    const result = await runWrapMutation<Row>([handled], envelope, ctx);
    expect(result).toEqual({
      handled: true,
      result: { id: 'server-1', name: 'Widget' },
    });
  });

  it('iterates in array order and short-circuits on the first handler', async () => {
    const order: string[] = [];
    const first = cap('first', async () => {
      order.push('first');
      return { handled: false } as const;
    });
    const second = cap('second', async () => {
      order.push('second');
      return { handled: true, result: 'from-second' } as const;
    });
    const third = cap('third', async () => {
      order.push('third');
      return { handled: true, result: 'from-third' } as const;
    });

    const result = await runWrapMutation<Row>(
      [first, second, third],
      envelope,
      ctx,
    );

    // second wins; third is never consulted.
    expect(result).toEqual({ handled: true, result: 'from-second' });
    expect(order).toEqual(['first', 'second']);
  });

  it('forwards the envelope and context to each capability', async () => {
    const spy = vi.fn(async () => ({ handled: false }) as const);
    await runWrapMutation<Row>([cap('spy', spy)], envelope, ctx);
    expect(spy).toHaveBeenCalledWith(envelope, ctx);
  });

  it('supports a synchronous wrapMutation return', async () => {
    const sync = cap('sync', () => ({ handled: true, result: 42 }));
    expect(await runWrapMutation<Row>([sync], envelope, ctx)).toEqual({
      handled: true,
      result: 42,
    });
  });
});
