import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEBHOOK_TOLERANCE_MS,
  signWebhookPayload,
  verifyWebhookSignature,
} from '../signing.js';

const secret = 's'.repeat(40);
const body = JSON.stringify({ id: 'e1', event: 'lead.created' });
const now = new Date('2026-01-01T00:00:00.000Z');
const ts = now.toISOString();
const sig = signWebhookPayload(secret, ts, body);

describe('webhook signature verification', () => {
  it('accepts a valid signature and rotation secrets', () => {
    expect(
      verifyWebhookSignature({
        secret,
        body,
        timestamp: ts,
        signature: sig,
        now,
      }),
    ).toEqual({ ok: true });
    expect(
      verifyWebhookSignature({
        secret: ['old', secret],
        body,
        timestamp: ts,
        signature: sig,
        now,
      }),
    ).toEqual({ ok: true });
  });
  it('rejects tampered body, wrong secret, and wrong timestamp', () => {
    const bad = (o: object) =>
      verifyWebhookSignature({
        secret,
        body,
        timestamp: ts,
        signature: sig,
        now,
        ...o,
      });
    expect(bad({ body: `${body} ` })).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(bad({ secret: 'x'.repeat(40) })).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(
      bad({ timestamp: new Date(now.getTime() + 1).toISOString() }),
    ).toEqual({ ok: false, reason: 'mismatch' });
  });
  it('enforces the replay window in both directions', () => {
    const at = (ms: number) => {
      const t = new Date(now.getTime() - ms).toISOString();
      return verifyWebhookSignature({
        secret,
        body,
        timestamp: t,
        signature: signWebhookPayload(secret, t, body),
        now,
      });
    };
    expect(at(DEFAULT_WEBHOOK_TOLERANCE_MS)).toEqual({ ok: true });
    expect(at(DEFAULT_WEBHOOK_TOLERANCE_MS + 1)).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(at(-DEFAULT_WEBHOOK_TOLERANCE_MS - 1)).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(
      verifyWebhookSignature({
        secret,
        body,
        timestamp: ts,
        signature: sig,
        now: new Date(now.getTime() + 5000),
        toleranceMs: 1000,
      }),
    ).toEqual({ ok: false, reason: 'expired' });
  });
  it('rejects malformed inputs without throwing', () => {
    for (const o of [
      { signature: null },
      { signature: 'sha256=abc' },
      { signature: sig.toUpperCase() },
      { timestamp: undefined },
      { timestamp: 'not-a-date' },
      { secret: '' },
      { secret: [] as string[] },
      { secret: undefined as unknown as string },
      { secret: null as unknown as string },
      { secret: [''] },
      { secret: [undefined as unknown as string] },
    ])
      expect(
        verifyWebhookSignature({
          secret,
          body,
          timestamp: ts,
          signature: sig,
          now,
          ...o,
        }),
      ).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects non-finite or negative tolerance and invalid clocks', () => {
    for (const toleranceMs of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(
        verifyWebhookSignature({
          secret,
          body,
          timestamp: ts,
          signature: sig,
          toleranceMs,
          now,
        }),
      ).toEqual({ ok: false, reason: 'malformed' });
    }
    expect(
      verifyWebhookSignature({
        secret,
        body,
        timestamp: ts,
        signature: sig,
        now: new Date(Number.NaN),
      }),
    ).toEqual({ ok: false, reason: 'malformed' });
  });
  it('rejects timestamps not in the emitted ISO format (split ambiguity)', () => {
    // Same signed message as (ts, 'x'), re-split at an earlier dot.
    const splitSig = signWebhookPayload(secret, ts, 'x');
    const splitTs = ts.slice(0, 19);
    const splitBody = `${ts.slice(20)}.x`;
    expect(
      verifyWebhookSignature({
        secret,
        body: splitBody,
        timestamp: splitTs,
        signature: splitSig,
        now,
      }),
    ).toEqual({ ok: false, reason: 'malformed' });
  });
  it('accepts a Uint8Array body', () => {
    expect(
      verifyWebhookSignature({
        secret,
        body: new TextEncoder().encode(body),
        timestamp: ts,
        signature: sig,
        now,
      }),
    ).toEqual({ ok: true });
  });
  it('authenticates raw bytes without lossy UTF-8 decoding', () => {
    const signed = new Uint8Array([0x7b, 0xef, 0xbf, 0xbd, 0x7d]);
    const altered = new Uint8Array([0x7b, 0xff, 0x7d]);
    const s = signWebhookPayload(secret, ts, signed);
    const verify = (b: Uint8Array) =>
      verifyWebhookSignature({
        secret,
        body: b,
        timestamp: ts,
        signature: s,
        now,
      });
    expect(verify(signed)).toEqual({ ok: true });
    expect(verify(altered)).toEqual({ ok: false, reason: 'mismatch' });
  });
});
