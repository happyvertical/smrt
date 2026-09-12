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
});
