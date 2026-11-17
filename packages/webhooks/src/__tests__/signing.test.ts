import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertWebhookProfileSecret,
  buildWebhookHeaders,
  DEFAULT_WEBHOOK_TOLERANCE_MS,
  resolveWebhookSigningProfile,
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

describe('default signing profile golden (byte-for-byte pinned)', () => {
  // Computed from the pre-profile implementation; any change here breaks receivers.
  const goldenSecret = 's'.repeat(40);
  const goldenBody = '{"id":"e1","event":"lead.created"}';
  const goldenTs = '2026-01-01T00:00:00.000Z';
  const goldenSig =
    'sha256=a30dc49846d2f66872756c48911f6a46556a89793c594b419e7ad478b8c2111f';

  it('signs identically with and without an explicit default profile', () => {
    expect(signWebhookPayload(goldenSecret, goldenTs, goldenBody)).toBe(
      goldenSig,
    );
    expect(
      signWebhookPayload(
        goldenSecret,
        goldenTs,
        goldenBody,
        resolveWebhookSigningProfile(null),
      ),
    ).toBe(goldenSig);
  });
  it('emits exactly the historical header set', () => {
    const headers = buildWebhookHeaders({
      secret: goldenSecret,
      body: goldenBody,
      deliveryId: 'd-1',
      event: 'lead.created',
      now: new Date(goldenTs),
    });
    expect(headers).toEqual({
      'content-type': 'application/json',
      'user-agent': 'smrt-webhooks/1',
      'x-smrt-event': 'lead.created',
      'x-smrt-delivery': 'd-1',
      'x-smrt-timestamp': goldenTs,
      'x-smrt-signature': goldenSig,
    });
    expect(Object.keys(headers)).toEqual([
      'content-type',
      'user-agent',
      'x-smrt-event',
      'x-smrt-delivery',
      'x-smrt-timestamp',
      'x-smrt-signature',
    ]);
  });
  it('rejects a bare-hex signature and unix timestamp under the default profile', () => {
    const now = new Date(goldenTs);
    const base = { secret: goldenSecret, body: goldenBody, now };
    expect(
      verifyWebhookSignature({
        ...base,
        timestamp: goldenTs,
        signature: goldenSig.slice(7),
      }),
    ).toEqual({ ok: false, reason: 'malformed' });
    expect(
      verifyWebhookSignature({
        ...base,
        timestamp: '1767225600',
        signature: goldenSig,
      }),
    ).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('paperclip preset', () => {
  const paperclip = resolveWebhookSigningProfile('paperclip');
  const pcSecret = 'paperclip-routine-secret-0123456789abcdef';
  const pcBody = '{"payload":{"hello":"world"}}';
  const at = new Date('2026-01-01T00:00:00.000Z');
  const unix = '1767225600';
  // Paperclip documents hmac_sha256 = hex(HMAC-SHA256(secret, `${timestamp}.${body}`)).
  const documented = createHmac('sha256', pcSecret)
    .update(`${unix}.${pcBody}`)
    .digest('hex');

  it('uses Paperclip headers, unix seconds and the documented signature', () => {
    const headers = buildWebhookHeaders({
      secret: pcSecret,
      body: pcBody,
      deliveryId: 'd-1',
      event: 'x.y',
      profile: paperclip,
      now: at,
    });
    expect(headers['x-paperclip-timestamp']).toBe(unix);
    expect(headers['x-paperclip-signature']).toBe(`sha256=${documented}`);
    expect(headers['x-smrt-signature']).toBeUndefined();
  });
  it('verifies prefixed and bare hex, rejects tampering', () => {
    const base = {
      secret: pcSecret,
      body: pcBody,
      timestamp: unix,
      profile: paperclip,
      now: at,
    };
    expect(
      verifyWebhookSignature({ ...base, signature: `sha256=${documented}` }),
    ).toEqual({ ok: true });
    expect(verifyWebhookSignature({ ...base, signature: documented })).toEqual({
      ok: true,
    });
    expect(
      verifyWebhookSignature({
        ...base,
        body: `${pcBody} `,
        signature: documented,
      }),
    ).toEqual({ ok: false, reason: 'mismatch' });
  });
  it('enforces the +-300s replay window for unix and unix-ms', () => {
    const run = (profile: typeof paperclip, ts: string, skewS: number) =>
      verifyWebhookSignature({
        secret: pcSecret,
        body: pcBody,
        timestamp: ts,
        signature: signWebhookPayload(pcSecret, ts, pcBody, profile),
        profile,
        now: new Date(at.getTime() + skewS * 1000),
      });
    const ms = { ...paperclip, timestampFormat: 'unix-ms' as const };
    for (const [p, ts] of [
      [paperclip, unix],
      [ms, String(at.getTime())],
    ] as const) {
      expect(run(p, ts, 300)).toEqual({ ok: true });
      expect(run(p, ts, -300)).toEqual({ ok: true });
      expect(run(p, ts, 301)).toEqual({ ok: false, reason: 'expired' });
      expect(run(p, ts, -301)).toEqual({ ok: false, reason: 'expired' });
    }
    expect(run(paperclip, at.toISOString(), 0)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});

describe('standard-webhooks preset', () => {
  const sw = resolveWebhookSigningProfile('standard-webhooks');
  // Published Standard Webhooks test vector.
  const swSecret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
  const id = 'msg_p5jXN8AQM9LWM0D4loKWxJek';
  const ts = '1614265330';
  const swBody = '{"test": 2432232314}';
  const swSig = 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=';
  const now = new Date(1614265330_000);

  it('matches the published vector', () => {
    expect(signWebhookPayload(swSecret, ts, swBody, sw, id)).toBe(swSig);
    expect(
      verifyWebhookSignature({
        secret: swSecret,
        body: swBody,
        timestamp: ts,
        signature: swSig,
        profile: sw,
        deliveryId: id,
        now,
      }),
    ).toEqual({ ok: true });
  });
  it('accepts a rotated multi-signature header and rejects wrong id', () => {
    const base = {
      secret: swSecret,
      body: swBody,
      timestamp: ts,
      profile: sw,
      now,
    };
    expect(
      verifyWebhookSignature({
        ...base,
        signature: `v1,${'A'.repeat(43)}= ${swSig}`,
        deliveryId: id,
      }),
    ).toEqual({ ok: true });
    expect(
      verifyWebhookSignature({
        ...base,
        signature: swSig,
        deliveryId: 'other',
      }),
    ).toEqual({ ok: false, reason: 'mismatch' });
    expect(verifyWebhookSignature({ ...base, signature: swSig })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
  it('emits webhook-* headers', () => {
    const headers = buildWebhookHeaders({
      secret: swSecret,
      body: swBody,
      deliveryId: id,
      event: 'e',
      profile: sw,
      now,
    });
    expect(headers).toMatchObject({
      'webhook-id': id,
      'webhook-timestamp': ts,
      'webhook-signature': swSig,
    });
  });
});

describe('profile resolution', () => {
  it('applies overrides and rejects bad config', () => {
    expect(
      resolveWebhookSigningProfile({
        preset: 'paperclip',
        timestampFormat: 'unix-ms',
      }).timestampFormat,
    ).toBe('unix-ms');
    expect(resolveWebhookSigningProfile('{"preset":"paperclip"}')).toEqual(
      resolveWebhookSigningProfile('paperclip'),
    );
    for (const bad of [
      'nope',
      { signatureHeader: 'Bad Header' },
      { signatureHeader: 'content-type' },
      { signatureHeader: 'content-length' },
      { signatureHeader: 'x-a', timestampHeader: 'x-a' },
      { bogus: 1 },
      { timestampFormat: 'rfc' },
    ])
      expect(() => resolveWebhookSigningProfile(bad as never)).toThrow();
  });
});

describe('whsec-base64 secret validation', () => {
  const sw = resolveWebhookSigningProfile('standard-webhooks');
  it('rejects malformed or short decoded keys', () => {
    for (const bad of [
      `whsec_${'!'.repeat(40)}`,
      'whsec_',
      `whsec_${'A'.repeat(39)}`,
      `whsec_${Buffer.alloc(23, 1).toString('base64')}`,
    ]) {
      expect(() => assertWebhookProfileSecret(bad, sw)).toThrow();
      expect(() => signWebhookPayload(bad, '1', 'x', sw, 'id')).toThrow();
    }
    expect(() =>
      assertWebhookProfileSecret('whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', sw),
    ).not.toThrow();
  });
});
