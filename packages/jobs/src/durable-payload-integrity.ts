import { createHmac, timingSafeEqual } from 'node:crypto';

export interface DurableJobPayloadIntegrity {
  version: 1;
  keyId: string;
  signature: string;
}

export interface DurableJobPayloadSigner {
  readonly keyId: string;
  sign(payload: unknown): DurableJobPayloadIntegrity;
  verify(payload: unknown, integrity: DurableJobPayloadIntegrity): boolean;
}

/** Create a deterministic HMAC signer for JSON job payloads. The key is never persisted. */
export function createHmacDurableJobPayloadSigner(options: {
  keyId: string;
  key: string | Uint8Array;
}): DurableJobPayloadSigner {
  if (!options.keyId || options.keyId.length > 256) {
    throw new Error(
      'Durable job integrity keyId must contain 1-256 characters',
    );
  }
  const keyLength =
    typeof options.key === 'string'
      ? Buffer.byteLength(options.key)
      : options.key.byteLength;
  if (keyLength < 32) {
    throw new Error('Durable job integrity key must contain at least 32 bytes');
  }
  const signature = (payload: unknown) =>
    createHmac('sha256', options.key)
      .update(canonicalJson(payload))
      .digest('base64url');
  return Object.freeze({
    keyId: options.keyId,
    sign(payload: unknown): DurableJobPayloadIntegrity {
      return {
        version: 1,
        keyId: options.keyId,
        signature: signature(payload),
      };
    },
    verify(payload: unknown, integrity: DurableJobPayloadIntegrity): boolean {
      if (
        integrity?.version !== 1 ||
        integrity.keyId !== options.keyId ||
        typeof integrity.signature !== 'string'
      ) {
        return false;
      }
      const expected = Buffer.from(signature(payload));
      const actual = Buffer.from(integrity.signature);
      return (
        actual.length === expected.length && timingSafeEqual(actual, expected)
      );
    },
  });
}

function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const canonicalize = (item: unknown, inArray = false): unknown => {
    if (
      item === null ||
      typeof item === 'string' ||
      typeof item === 'boolean'
    ) {
      return item;
    }
    if (typeof item === 'number') return Number.isFinite(item) ? item : null;
    if (
      item === undefined ||
      typeof item === 'function' ||
      typeof item === 'symbol'
    ) {
      return inArray ? null : undefined;
    }
    if (typeof item !== 'object' || seen.has(item)) {
      throw new Error('Durable job integrity payload must be acyclic JSON');
    }
    seen.add(item);
    if (Array.isArray(item)) {
      const result = item.map((entry) => canonicalize(entry, true));
      seen.delete(item);
      return result;
    }
    // JSON may contain an own `__proto__` property. A normal object would invoke
    // Object.prototype's legacy prototype setter here and omit that property
    // from the signed representation.
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(item as Record<string, unknown>).sort()) {
      const entry = canonicalize((item as Record<string, unknown>)[key]);
      if (entry !== undefined) result[key] = entry;
    }
    seen.delete(item);
    return result;
  };
  return JSON.stringify(canonicalize(value));
}
