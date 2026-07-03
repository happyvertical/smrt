/**
 * Unit tests for the pure helpers of the sync-apply batch write contract
 * (#1759): envelope/batch validation, the writable policy shared with the
 * generated SvelteKit route, the updated-at staleness guard, and the payload
 * no-op equality check that makes replays byte-stable.
 *
 * End-to-end behavior over the real stack (real in-memory SQLite, the full
 * interceptor/auth path) is covered in `generators/sync-apply.spec.ts` and in
 * packages/tenancy `sync-apply-tenant-isolation.spec.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  applySyncWritablePolicy,
  isStaleWrite,
  MAX_SYNC_APPLY_BATCH_SIZE,
  parseSyncApplyBatch,
  payloadMatchesRow,
  type SyncApplyRowLike,
  validateSyncApplyItem,
} from './apply';

const VALID_UUID = '3f0d8a4e-6f7b-4a5c-9d2e-1b8c7a6f5e4d';

function validItem(overrides: Record<string, unknown> = {}) {
  return {
    itemId: 'outbox-1',
    object: 'products',
    op: 'create',
    id: VALID_UUID,
    payload: { name: 'Widget' },
    ...overrides,
  };
}

describe('parseSyncApplyBatch', () => {
  it('accepts an object with an items array', () => {
    const parsed = parseSyncApplyBatch({ items: [validItem()] });
    expect('items' in parsed && parsed.items).toHaveLength(1);
  });

  it.each([
    null,
    'nope',
    42,
    [],
    {},
    { items: 'x' },
    { items: {} },
  ])('rejects a malformed batch body: %j', (body) => {
    const parsed = parseSyncApplyBatch(body);
    expect('error' in parsed && parsed.error.code).toBe('invalid_batch');
  });

  it('rejects a batch above the size cap', () => {
    const items = Array.from({ length: MAX_SYNC_APPLY_BATCH_SIZE + 1 }, () =>
      validItem(),
    );
    const parsed = parseSyncApplyBatch({ items });
    expect('error' in parsed && parsed.error.code).toBe('batch_too_large');
  });
});

describe('validateSyncApplyItem', () => {
  it('accepts a well-formed item', () => {
    const validated = validateSyncApplyItem(validItem());
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.item.id).toBe(VALID_UUID);
      expect(validated.item.op).toBe('create');
    }
  });

  it.each([
    [null, 'invalid_item'],
    ['string', 'invalid_item'],
    [validItem({ itemId: '' }), 'invalid_item'],
    [validItem({ itemId: 42 }), 'invalid_item'],
    [validItem({ op: 'patch' }), 'invalid_item'],
    [validItem({ object: '' }), 'invalid_item'],
    [validItem({ baseUpdatedAt: 'not-a-date' }), 'invalid_item'],
    [validItem({ baseUpdatedAt: 12345 }), 'invalid_item'],
    [validItem({ id: 'not-a-uuid' }), 'invalid_id'],
    [validItem({ id: undefined }), 'invalid_id'],
    [validItem({ id: `${VALID_UUID}0` }), 'invalid_id'],
    [validItem({ payload: undefined }), 'invalid_payload'],
    [validItem({ payload: [] }), 'invalid_payload'],
    [validItem({ payload: 'x' }), 'invalid_payload'],
    [validItem({ op: 'update', payload: null }), 'invalid_payload'],
  ])('rejects malformed item %j with %s', (raw, reason) => {
    const validated = validateSyncApplyItem(raw);
    expect(validated.ok).toBe(false);
    if (!validated.ok) {
      expect(validated.result.status).toBe('rejected');
      expect(validated.result.reason).toBe(reason);
    }
  });

  it('accepts uppercase UUIDs and deletes without payloads', () => {
    const validated = validateSyncApplyItem(
      validItem({
        op: 'delete',
        id: VALID_UUID.toUpperCase(),
        payload: undefined,
      }),
    );
    expect(validated.ok).toBe(true);
  });

  it('echoes the itemId on rejection when one was provided', () => {
    const validated = validateSyncApplyItem(validItem({ id: 'nope' }));
    expect(!validated.ok && validated.result.itemId).toBe('outbox-1');
  });
});

describe('applySyncWritablePolicy', () => {
  it('strips server-managed, underscore-prefixed, and readonly fields', () => {
    const data = applySyncWritablePolicy(
      {
        name: 'ok',
        id: 'forged',
        tenantId: 'forged',
        tenant_id: 'forged',
        createdAt: 'forged',
        updated_at: 'forged',
        _meta_type: 'forged',
        internalCode: 'forged',
      },
      { readonlyFields: ['internalCode'] },
    );
    expect(data).toEqual({ name: 'ok' });
  });

  it('intersects with a writable allowlist when configured', () => {
    const data = applySyncWritablePolicy(
      { name: 'ok', price: 2, hidden: true },
      { writableAllowlist: ['name', 'price'] },
    );
    expect(data).toEqual({ name: 'ok', price: 2 });
  });

  it('returns an empty object for non-object payloads', () => {
    expect(applySyncWritablePolicy(null)).toEqual({});
    expect(applySyncWritablePolicy('x')).toEqual({});
  });
});

describe('isStaleWrite', () => {
  it('is stale only when the base is strictly older than the server row', () => {
    const older = '2026-07-01T00:00:00.000Z';
    const newer = '2026-07-02T00:00:00.000Z';
    expect(isStaleWrite(older, new Date(newer))).toBe(true);
    expect(isStaleWrite(newer, new Date(older))).toBe(false);
    expect(isStaleWrite(newer, new Date(newer))).toBe(false);
  });

  it('never flags when the client opted out or timestamps are unusable', () => {
    expect(isStaleWrite(undefined, new Date())).toBe(false);
    expect(isStaleWrite('2026-07-01T00:00:00.000Z', null)).toBe(false);
    expect(isStaleWrite('2026-07-01T00:00:00.000Z', undefined)).toBe(false);
    expect(isStaleWrite('2026-07-01T00:00:00.000Z', 'garbage')).toBe(false);
  });

  it('compares string-stored server timestamps too', () => {
    expect(
      isStaleWrite('2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z'),
    ).toBe(true);
  });
});

function rowLike(fields: Record<string, unknown>): SyncApplyRowLike {
  return {
    ...fields,
    save: async () => undefined,
    delete: async () => undefined,
  } as unknown as SyncApplyRowLike;
}

describe('payloadMatchesRow (idempotent no-op detection)', () => {
  it('matches when every payload field equals the row value', () => {
    const row = rowLike({ name: 'a', priority: 3, active: true });
    expect(payloadMatchesRow({ name: 'a', priority: 3 }, row)).toBe(true);
    expect(payloadMatchesRow({ name: 'b' }, row)).toBe(false);
    expect(payloadMatchesRow({ priority: 4 }, row)).toBe(false);
  });

  it('compares Date row values against ISO strings from JSON payloads', () => {
    const when = new Date('2026-07-02T10:00:00.000Z');
    const row = rowLike({ publishedAt: when });
    expect(
      payloadMatchesRow({ publishedAt: '2026-07-02T10:00:00.000Z' }, row),
    ).toBe(true);
    // Second-precision ISO strings still parse to the same instant.
    expect(
      payloadMatchesRow({ publishedAt: '2026-07-02T10:00:00Z' }, row),
    ).toBe(true);
    expect(
      payloadMatchesRow({ publishedAt: '2026-07-02T10:00:01.000Z' }, row),
    ).toBe(false);
  });

  it('treats null and undefined row values as equivalent to null payloads', () => {
    const row = rowLike({ note: null });
    expect(payloadMatchesRow({ note: null }, row)).toBe(true);
    expect(payloadMatchesRow({ note: 'x' }, row)).toBe(false);
  });

  it('ignores payload keys that are not properties of the row', () => {
    const row = rowLike({ name: 'a' });
    expect(payloadMatchesRow({ name: 'a', unknownField: 'zzz' }, row)).toBe(
      true,
    );
  });

  it('deep-compares object-valued fields', () => {
    const row = rowLike({ tags: ['a', 'b'] });
    expect(payloadMatchesRow({ tags: ['a', 'b'] }, row)).toBe(true);
    expect(payloadMatchesRow({ tags: ['a'] }, row)).toBe(false);
  });
});
