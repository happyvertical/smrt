/**
 * Tests for the shared durable-store namespace + wipe registry (#1755).
 *
 * This layer is pure SMRT-side bookkeeping — no client-data engine, no
 * TanStack — so every collaborator here is real. The registry is the one thing
 * the future offline outbox (#1762) and persistence (#1764) slices agree on:
 * each uses its own TanStack storage primitive under a shared namespace, and
 * `wipeDurableStore` clears both through the registry without the two modules
 * importing each other.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  type DurableResource,
  type DurableStoreKey,
  durableStoreNamespace,
  registerDurableResource,
  wipeDurableStore,
} from './index.js';

/** A minimal in-memory resource whose clear() is observable. */
function fakeResource(
  kind: DurableResource['kind'],
): DurableResource & { cleared: number } {
  const resource = {
    kind,
    cleared: 0,
    clear: async () => {
      resource.cleared += 1;
    },
  };
  return resource;
}

describe('durableStoreNamespace', () => {
  it('is deterministic: the same key yields the same namespace', () => {
    const key: DurableStoreKey = {
      apiBase: '/api/v1',
      tenantId: 't1',
      identityId: 'u1',
      manifestHash: 'abc123',
    };
    expect(durableStoreNamespace(key)).toBe(durableStoreNamespace({ ...key }));
  });

  it('encodes every key segment in a stable order', () => {
    expect(
      durableStoreNamespace({
        apiBase: '/api/v1',
        tenantId: 't1',
        identityId: 'u1',
        manifestHash: 'abc123',
      }),
    ).toBe('smrt-web:/api/v1:t1:u1:abc123');
  });

  it("substitutes '-' for an absent tenant or identity", () => {
    expect(
      durableStoreNamespace({ apiBase: '/api/v1', manifestHash: 'abc123' }),
    ).toBe('smrt-web:/api/v1:-:-:abc123');
  });

  it('changes when the manifest hash changes (a schema shift => a fresh namespace)', () => {
    const base: DurableStoreKey = { apiBase: '/api/v1', manifestHash: 'v1' };
    expect(durableStoreNamespace(base)).not.toBe(
      durableStoreNamespace({ ...base, manifestHash: 'v2' }),
    );
  });

  it('changes when the tenant or identity changes (no cross-tenant reuse)', () => {
    const base: DurableStoreKey = { apiBase: '/api/v1', manifestHash: 'v1' };
    expect(durableStoreNamespace({ ...base, tenantId: 'a' })).not.toBe(
      durableStoreNamespace({ ...base, tenantId: 'b' }),
    );
    expect(durableStoreNamespace({ ...base, identityId: 'a' })).not.toBe(
      durableStoreNamespace({ ...base, identityId: 'b' }),
    );
  });
});

describe('registerDurableResource + wipeDurableStore', () => {
  it('clears every resource registered under a namespace', async () => {
    const ns = durableStoreNamespace({ apiBase: '/api/v1', manifestHash: 'h' });
    const outbox = fakeResource('outbox');
    const persisted = fakeResource('persisted-collection');
    registerDurableResource(ns, outbox);
    registerDurableResource(ns, persisted);

    await wipeDurableStore(ns);

    expect(outbox.cleared).toBe(1);
    expect(persisted.cleared).toBe(1);
  });

  it('does NOT clear resources registered under a different namespace', async () => {
    const nsA = durableStoreNamespace({
      apiBase: '/api/v1',
      manifestHash: 'a',
    });
    const nsB = durableStoreNamespace({
      apiBase: '/api/v1',
      manifestHash: 'b',
    });
    const underA = fakeResource('outbox');
    const underB = fakeResource('outbox');
    registerDurableResource(nsA, underA);
    registerDurableResource(nsB, underB);

    await wipeDurableStore(nsA);

    expect(underA.cleared).toBe(1);
    expect(underB.cleared).toBe(0);
  });

  it('returns an unregister that removes the resource before a wipe', async () => {
    const ns = durableStoreNamespace({ apiBase: '/api/v1', manifestHash: 'u' });
    const resource = fakeResource('outbox');
    const unregister = registerDurableResource(ns, resource);

    unregister();
    await wipeDurableStore(ns);

    expect(resource.cleared).toBe(0);
  });

  it('drops the namespace after a wipe: re-wiping clears nothing more', async () => {
    const ns = durableStoreNamespace({ apiBase: '/api/v1', manifestHash: 'd' });
    const resource = fakeResource('outbox');
    registerDurableResource(ns, resource);

    await wipeDurableStore(ns);
    await wipeDurableStore(ns);

    expect(resource.cleared).toBe(1);
  });

  it('is a safe no-op on an unknown or empty namespace', async () => {
    await expect(wipeDurableStore('never-registered')).resolves.toBeUndefined();
    await expect(wipeDurableStore('')).resolves.toBeUndefined();
  });

  it('clears every registered resource even if one clear() rejects', async () => {
    const ns = durableStoreNamespace({ apiBase: '/api/v1', manifestHash: 'e' });
    const flaky: DurableResource = {
      kind: 'outbox',
      clear: vi.fn(async () => {
        throw new Error('storage unavailable');
      }),
    };
    const healthy = fakeResource('persisted-collection');
    registerDurableResource(ns, flaky);
    registerDurableResource(ns, healthy);

    await wipeDurableStore(ns);

    // The healthy resource still cleared; a rejected clear() did not abort the
    // sweep (a wipe is a best-effort teardown, not a transaction).
    expect(flaky.clear).toHaveBeenCalledTimes(1);
    expect(healthy.cleared).toBe(1);
  });
});
