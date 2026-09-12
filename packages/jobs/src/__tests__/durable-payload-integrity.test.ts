import { describe, expect, it } from 'vitest';
import { createHmacDurableJobPayloadSigner } from '../durable-payload-integrity.js';

describe('durable job payload integrity', () => {
  it('survives JSON persistence and rejects changed payloads or key ids', () => {
    const signer = createHmacDurableJobPayloadSigner({
      keyId: 'jobs-v1',
      key: 'test-only-durable-job-integrity-key',
    });
    const payload = {
      tenantId: 'tenant-a',
      request: { ids: ['a', 'b'], omitted: undefined },
    };
    const persisted = JSON.parse(JSON.stringify(payload)) as unknown;
    const integrity = signer.sign(payload);

    expect(signer.verify(persisted, integrity)).toBe(true);
    expect(
      signer.verify(
        { tenantId: 'tenant-b', request: { ids: ['a', 'b'] } },
        integrity,
      ),
    ).toBe(false);
    expect(signer.verify(persisted, { ...integrity, keyId: 'jobs-v2' })).toBe(
      false,
    );
  });

  it('signs the persisted JSON representation of Date values', () => {
    const signer = createHmacDurableJobPayloadSigner({
      keyId: 'jobs-v1',
      key: 'test-only-durable-job-integrity-key',
    });
    const payload = {
      changedRows: [
        {
          updatedAt: new Date('2026-09-12T12:34:56.789Z'),
          nested: { issuedAt: new Date('2026-09-11T00:00:00.000Z') },
        },
      ],
    };
    const persisted = JSON.parse(JSON.stringify(payload)) as {
      changedRows: Array<{ updatedAt: string; nested: { issuedAt: string } }>;
    };
    const integrity = signer.sign(payload);

    expect(signer.verify(persisted, integrity)).toBe(true);
    persisted.changedRows[0]!.updatedAt = '2026-09-12T12:34:56.790Z';
    expect(signer.verify(persisted, integrity)).toBe(false);
  });

  it('binds own __proto__ fields at every JSON object depth', () => {
    const signer = createHmacDurableJobPayloadSigner({
      keyId: 'jobs-v1',
      key: 'test-only-durable-job-integrity-key',
    });
    const payload = JSON.parse(
      '{"__proto__":{"role":"worker"},"request":{"__proto__":{"id":"a"},"ids":["a"]}}',
    ) as unknown;
    const integrity = signer.sign(payload);
    const tampered = JSON.parse(JSON.stringify(payload)) as {
      request: Record<string, unknown>;
    };

    expect(signer.verify(JSON.parse(JSON.stringify(payload)), integrity)).toBe(
      true,
    );
    const topLevelProto = Object.getOwnPropertyDescriptor(tampered, '__proto__')
      ?.value as { role: string };
    const nestedProto = Object.getOwnPropertyDescriptor(
      tampered.request,
      '__proto__',
    )?.value as { id: string };

    topLevelProto.role = 'admin';
    expect(signer.verify(tampered, integrity)).toBe(false);
    topLevelProto.role = 'worker';
    nestedProto.id = 'b';
    expect(signer.verify(tampered, integrity)).toBe(false);
  });

  it('signs equivalent object key orders deterministically', () => {
    const signer = createHmacDurableJobPayloadSigner({
      keyId: 'jobs-v1',
      key: 'test-only-durable-job-integrity-key',
    });
    const integrity = signer.sign({
      z: 1,
      nested: { b: true, a: false },
      a: 2,
    });

    expect(
      signer.verify({ a: 2, nested: { a: false, b: true }, z: 1 }, integrity),
    ).toBe(true);
  });
});
