import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { DesktopContractError } from '../errors.js';
import {
  coreControlCodec,
  parseControlRequest,
} from '../rendezvous/control-protocol.js';
import { createControlHandlerRegistry } from '../rendezvous/control-transport.js';
import { createReferenceSupervisor } from '../rendezvous/reference-shell.js';
import { SecretString } from '../secret-string.js';
import {
  CANARY_BODY,
  CANARY_TOKEN,
  FUTURE,
  leaks,
  NONCE,
  NOW,
  ORIGIN,
  SLOT_ID,
  thrown,
} from '../testing/credentials.js';
import {
  type AcquireCredentialSuccess,
  CREDENTIAL_CONTROL_ERROR_CODES,
  type CredentialControlRequest,
  type CredentialControlResponse,
  createCredentialReferenceRegistry,
  credentialControlCodec,
  referenceControlContext,
  registerAcquireCredential,
} from './control-channel.js';
import {
  createCredentialControlHandler,
  parseAcquireCredentialResponse,
} from './control-handler.js';
import {
  createCredentialCustody,
  createMemorySecretItemStore,
} from './custody.js';
import type { SlotRecordV1 } from './slot-record.js';

const request = {
  v: 1,
  op: 'acquire-credential',
  instanceNonce: NONCE,
  origin: ORIGIN,
} as const;

const success = (): AcquireCredentialSuccess => ({
  v: 1,
  ok: true,
  instanceNonce: NONCE,
  lease: {
    token: new SecretString(CANARY_TOKEN),
    origin: ORIGIN,
    expiresAt: FUTURE,
  },
});

describe('credentialControlCodec', () => {
  it('extends the core ops without changing coreControlCodec', () => {
    expect(coreControlCodec.ops).toEqual(['status', 'ensure-ready']);
    expect(credentialControlCodec.ops).toEqual([
      'status',
      'ensure-ready',
      'acquire-credential',
    ]);
    expect(coreControlCodec.errorCodes).not.toContain('credential_invalid');
    expect(credentialControlCodec.errorCodes).toEqual(
      expect.arrayContaining([
        ...coreControlCodec.errorCodes,
        ...CREDENTIAL_CONTROL_ERROR_CODES,
      ]),
    );
    expect(() => parseControlRequest(JSON.stringify(request))).toThrowError(
      expect.objectContaining({ code: 'unsupported_op' }),
    );
    expect(
      credentialControlCodec.parseRequest('{"v":1,"op":"status"}'),
    ).toEqual({ v: 1, op: 'status' });
  });

  it('round-trips a request in canonical key order', () => {
    const line = credentialControlCodec.encodeRequest(request);
    expect(line).toBe(
      `{"v":1,"op":"acquire-credential","instanceNonce":"${NONCE}","origin":"${ORIGIN}"}\n`,
    );
    expect(credentialControlCodec.parseRequest(line)).toEqual(request);
  });

  it('rejects malformed, extended and non-loopback requests', () => {
    const bad = [
      { ...request, instanceNonce: 'ABC' },
      { ...request, origin: 'http://localhost:4678' },
      { ...request, origin: 'https://127.0.0.1:4678' },
      { ...request, extra: 1 },
      { v: 1, op: 'acquire-credential', origin: ORIGIN },
    ];
    for (const value of bad) {
      expect(() =>
        credentialControlCodec.encodeRequest(value as never),
      ).toThrowError(
        expect.objectContaining({ code: 'invalid_control_message' }),
      );
    }
  });

  it('carries the token only inside the credential success body', () => {
    const line = credentialControlCodec.encodeResponse(success());
    expect(line).toBe(
      `{"v":1,"ok":true,"instanceNonce":"${NONCE}","origin":"${ORIGIN}","token":"${CANARY_TOKEN}","expiresAt":"${FUTURE}"}\n`,
    );
    const parsed = credentialControlCodec.parseResponse(
      'acquire-credential',
      line,
    ) as AcquireCredentialSuccess;
    expect(parsed.lease.token).toBeInstanceOf(SecretString);
    expect(parsed.lease.token.equals(new SecretString(CANARY_TOKEN))).toBe(
      true,
    );
    expect(Object.isFrozen(parsed)).toBe(true);
    for (const text of [
      JSON.stringify(parsed),
      inspect(parsed, { depth: 10 }),
      String(parsed.lease.token),
    ]) {
      expect(text).not.toContain(CANARY_BODY);
    }
  });

  it('encodes failures as plain error responses and rejects unknown codes', () => {
    for (const code of CREDENTIAL_CONTROL_ERROR_CODES) {
      const line = credentialControlCodec.encodeResponse({
        v: 1,
        ok: false,
        code,
      });
      expect(line).toBe(`{"v":1,"ok":false,"code":"${code}"}\n`);
      expect(
        credentialControlCodec.parseResponse('acquire-credential', line),
      ).toEqual({ v: 1, ok: false, code });
    }
    // Reading is lenient (a newer peer), writing is strict.
    expect(
      credentialControlCodec.parseResponse(
        'acquire-credential',
        '{"v":1,"ok":false,"code":"credential_rejected"}',
      ),
    ).toEqual({ v: 1, ok: false, code: 'internal' });
    expect(() =>
      credentialControlCodec.encodeResponse({
        v: 1,
        ok: false,
        code: 'credential_rejected',
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'invalid_control_message' }),
    );
    // The core codec does not know the credential codes.
    expect(
      coreControlCodec.parseResponse(
        'status',
        '{"v":1,"ok":false,"code":"credential_invalid"}',
      ),
    ).toEqual({ v: 1, ok: false, code: 'internal' });
    expect(() =>
      coreControlCodec.encodeResponse({
        v: 1,
        ok: false,
        code: 'credential_invalid',
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'invalid_control_message' }),
    );
  });

  it('refuses success bodies that are not exactly the documented reply', async () => {
    const hostile = [
      `{"v":1,"ok":true,"instanceNonce":"${NONCE}","origin":"${ORIGIN}","token":"${CANARY_TOKEN}"}`,
      `{"v":1,"ok":true,"origin":"${ORIGIN}","token":"${CANARY_TOKEN}","expiresAt":"${FUTURE}"}`,
      `{"v":1,"ok":true,"instanceNonce":"short","origin":"${ORIGIN}","token":"${CANARY_TOKEN}","expiresAt":"${FUTURE}"}`,
      `{"v":1,"ok":true,"instanceNonce":"${NONCE}","origin":"http://localhost:4678","token":"${CANARY_TOKEN}","expiresAt":"${FUTURE}"}`,
      `{"v":1,"ok":true,"instanceNonce":"${NONCE}","origin":"${ORIGIN}","token":"not-a-token-${CANARY_BODY}","expiresAt":"${FUTURE}"}`,
      `{"v":1,"ok":true,"instanceNonce":"${NONCE}","origin":"${ORIGIN}","token":"${CANARY_TOKEN}","expiresAt":"${FUTURE}","extra":"${CANARY_BODY}"}`,
      `{"v":1,"ok":true,"state":"starting","token":"${CANARY_TOKEN}"}`,
    ];
    for (const line of hostile) {
      const error = await thrown(() =>
        credentialControlCodec.parseResponse('acquire-credential', line),
      );
      expect(error).toBeInstanceOf(DesktopContractError);
      expect(leaks(error)).toBe(false);
    }
  });

  it('never serializes a SecretString as its redaction', () => {
    const generic = JSON.stringify(success());
    expect(generic).toContain('[REDACTED]');
    // ...so the codec must not use the generic path for the success body.
    expect(credentialControlCodec.encodeResponse(success())).not.toContain(
      '[REDACTED]',
    );
  });

  it('keeps instance-state answers free of any bearer', () => {
    const line = credentialControlCodec.encodeResponse({
      v: 1,
      ok: true,
      state: 'ready',
      instanceNonce: NONCE,
      productId: 'smrt-notes',
      origin: ORIGIN,
    });
    expect(line).not.toContain('token');
    expect(line).not.toContain('lease');
  });
});

describe('referenceControlContext and the registry', () => {
  const minted: SlotRecordV1 = {
    version: 1,
    slotId: SLOT_ID,
    scopes: ['notes.read'],
    expiresAt: FUTURE,
    state: 'minted',
  };

  it('derives { instanceNonce, origin } from the serving supervisor only while ready', () => {
    const supervisor = createReferenceSupervisor({
      productId: 'smrt-notes',
      instanceNonce: NONCE,
    });
    const current = referenceControlContext(supervisor);
    expect(current()).toBeNull();
    supervisor.ready(ORIGIN);
    expect(current()).toEqual({ instanceNonce: NONCE, origin: ORIGIN });
    supervisor.fail('sidecar_missing');
    expect(current()).toBeNull();
  });

  it('hands the handler the serving instance, not the request, as identity', async () => {
    const supervisor = createReferenceSupervisor({
      productId: 'smrt-notes',
      instanceNonce: NONCE,
    });
    supervisor.ready(ORIGIN);
    const custody = createCredentialCustody(createMemorySecretItemStore());
    await custody.put({
      slotId: SLOT_ID,
      token: new SecretString(CANARY_TOKEN),
      scopes: ['notes.read'],
      expiresAt: FUTURE,
    });
    const registry = createCredentialReferenceRegistry(supervisor, {
      custody,
      slot: async () => minted,
      now: () => NOW,
    });
    expect(registry.has('status')).toBe(true);
    expect(registry.has('ensure-ready')).toBe(true);
    expect(registry.has('acquire-credential')).toBe(true);
    const context = { signal: new AbortController().signal };

    const ok = await registry.handler(request, context);
    expect(ok).toMatchObject({ v: 1, ok: true, lease: { origin: ORIGIN } });

    const wrong = await registry.handler(
      { ...request, instanceNonce: 'f'.repeat(32) },
      context,
    );
    expect(wrong).toEqual({ v: 1, ok: false, code: 'instance_mismatch' });

    supervisor.starting();
    expect(await registry.handler(request, context)).toEqual({
      v: 1,
      ok: false,
      code: 'instance_mismatch',
    });
  });

  it('registers the op once', () => {
    const registry = createControlHandlerRegistry<
      CredentialControlRequest,
      CredentialControlResponse
    >();
    const handler = createCredentialControlHandler({
      custody: createCredentialCustody(createMemorySecretItemStore()),
      slot: async () => null,
      current: () => null,
    });
    registerAcquireCredential(registry, handler);
    expect(() => registerAcquireCredential(registry, handler)).toThrow();
  });
});

describe('parseAcquireCredentialResponse on the codec-decoded form', () => {
  it('accepts exactly { v, ok, instanceNonce, lease } with a SecretString bearer', () => {
    const result = parseAcquireCredentialResponse(success());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.lease.origin).toBe(ORIGIN);
      expect(result.instanceNonce).toBe(NONCE);
    }
  });

  it('rejects a plain-string bearer, extra keys and a bad origin or expiry', async () => {
    const lease = success().lease;
    const bad: unknown[] = [
      {
        v: 1,
        ok: true,
        instanceNonce: NONCE,
        lease: { ...lease, token: CANARY_TOKEN },
      },
      {
        v: 1,
        ok: true,
        instanceNonce: NONCE,
        lease: { ...lease, extra: CANARY_BODY },
      },
      {
        v: 1,
        ok: true,
        instanceNonce: NONCE,
        lease: { ...lease, origin: 'http://localhost:1' },
      },
      {
        v: 1,
        ok: true,
        instanceNonce: NONCE,
        lease: { ...lease, expiresAt: 'tomorrow' },
      },
      {
        v: 1,
        ok: true,
        instanceNonce: NONCE,
        lease: { ...lease, token: new SecretString('x') },
      },
      { v: 1, ok: true, instanceNonce: NONCE, lease: null },
      { v: 1, ok: true, instanceNonce: NONCE, lease, extra: CANARY_BODY },
      // The echo is mandatory and must be a well-formed nonce.
      { v: 1, ok: true, lease },
      { v: 1, ok: true, instanceNonce: 'short', lease },
      { v: 1, ok: true, instanceNonce: NONCE.toUpperCase(), lease },
    ];
    for (const input of bad) {
      const error = await thrown(() => parseAcquireCredentialResponse(input));
      expect(error).toBeInstanceOf(DesktopContractError);
      expect((error as DesktopContractError).code).toBe(
        'credential_unavailable',
      );
      expect(leaks(error)).toBe(false);
    }
  });
});
