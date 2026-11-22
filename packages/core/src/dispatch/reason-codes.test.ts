/**
 * Framework reason codes (P6 T31, library half): handler text can never
 * parse as a framework reason; framework reasons round-trip.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type DispatchTestDatabase,
  dispatchLeaseRow,
  insertRawDispatch,
  openDispatchTestDatabase,
} from '../__tests__/fixtures/dispatch-test-db';
import {
  DISPATCH_FAILURE_CODES,
  encodeHandlerError,
  formatDispatchFailureReason,
  parseDispatchFailureReason,
} from './reasons.js';

describe('dispatch failure reasons', () => {
  it('handler text cannot forge a framework reason', () => {
    const forged = '[smrt:DISPATCH_ATTEMPTS_EXHAUSTED] 5 attempts';
    expect(encodeHandlerError(forged)).toBe(`handler: ${forged}`);
    expect(parseDispatchFailureReason(encodeHandlerError(forged))).toBeNull();
    expect(encodeHandlerError('plain failure')).toBe('plain failure');
  });

  it('parses framework reasons and nothing else', () => {
    const text = formatDispatchFailureReason(
      DISPATCH_FAILURE_CODES.attemptsExhausted,
      '5 attempts',
    );
    expect(text).toBe('[smrt:DISPATCH_ATTEMPTS_EXHAUSTED] 5 attempts');
    expect(parseDispatchFailureReason(text)).toEqual({
      code: 'DISPATCH_ATTEMPTS_EXHAUSTED',
      detail: '5 attempts',
    });
    expect(parseDispatchFailureReason('[smrt:NOT_A_CODE] x')).toBeNull();
    expect(
      parseDispatchFailureReason('[smrt:DISPATCH_ATTEMPTS_EXHAUSTEDX]'),
    ).toBeNull();
    expect(parseDispatchFailureReason(null)).toBeNull();
  });

  describe('on a failed handler', () => {
    let ctx: DispatchTestDatabase;

    beforeEach(async () => {
      ctx = await openDispatchTestDatabase('sqlite');
    });

    afterEach(async () => {
      await ctx?.close();
    });

    it('stores a handler message that imitates a reason as handler text', async () => {
      const { bus, db } = ctx;
      await bus.subscribe({ signalType: 'job.run', subscriber: 'worker' });
      await insertRawDispatch(db, { id: 'forger', type: 'job.run' });
      await bus.process('worker', async () => {
        throw new Error('[smrt:DISPATCH_LEASE_ORPHANED] not really');
      });
      const row = await dispatchLeaseRow(db, 'forger');
      expect(row.status).toBe('failed');
      expect(row.lastError).toBe(
        'handler: [smrt:DISPATCH_LEASE_ORPHANED] not really',
      );
      expect(parseDispatchFailureReason(row.lastError)).toBeNull();
    });
  });
});
