import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDesignRunDriver,
  DesignRunConflictError,
} from '../design-run.js';
import { createDesignRunStore } from '../design-run-store.js';

// Import registers the workflow model; normal migrations own its table.
import '../models/DesignRunRecord.js';

describe('owner-scoped design run checkpoints', () => {
  let db: DatabaseInterface;
  beforeEach(async () => {
    db = await getTestDatabase({ classes: ['DesignRunRecord'] });
  });
  afterEach(async () => {
    await (db as { close?: () => Promise<void> }).close?.();
  });
  const budget = {
    maxTokens: 100,
    maxDurationMs: 1000,
    maxCallTokens: 10,
    callTimeoutMs: 100,
    repairRetries: 1,
    toolResultChars: 1000,
  };
  function driver(
    ownerId: string,
    enqueue = vi.fn(async () => {}),
    authorizeWrite?: () => Promise<boolean>,
  ) {
    return createDesignRunDriver({
      definition: 'host:v1',
      passes: [{ name: 'Propose', schema: { type: 'object' } }],
      store: createDesignRunStore({
        db,
        ownerId,
        tenantId: null,
        enqueue,
        authorizeWrite,
      }),
      validate: () => [],
      readResource: async () => ({ data: null }),
      executePass: async () => ({
        output: {},
        metadata: {
          profile: 'design',
          engine: 'claude-code',
          effort: 'max',
          durationMs: 1,
          tokens: 1,
          toolCalls: 0,
        },
      }),
    });
  }
  it('survives a fresh adapter, scopes owners and atomically admits start/resume', async () => {
    const enqueue = vi.fn(async () => {});
    const id = randomUUID();
    const first = driver('owner', enqueue);
    await first.start({ id, ownerId: 'owner', resourceIds: ['file'], budget });
    expect(enqueue).toHaveBeenCalledTimes(1);
    const restarted = driver('owner', enqueue);
    expect((await restarted.status(id, 'owner')).resourceIds).toEqual(['file']);
    await expect(driver('other').status(id, 'other')).rejects.toThrow(
      'not found',
    );
    await restarted.stop(id, 'owner');
    await restarted.resume(id, 'owner');
    expect(enqueue).toHaveBeenCalledTimes(2);
    await restarted.run(id, 'owner');
    expect(enqueue).toHaveBeenCalledTimes(2);
  });
  it('rolls checkpoint admission back if existing-job enqueue fails', async () => {
    const id = randomUUID();
    const failing = driver(
      'owner',
      vi.fn(async () => {
        throw new Error('job admission failed');
      }),
    );
    await expect(
      failing.start({ id, ownerId: 'owner', resourceIds: [], budget }),
    ).rejects.toThrow('job admission failed');
    await expect(driver('owner').status(id, 'owner')).rejects.toThrow(
      'not found',
    );
  });
  it('rejects stale revisions and a lost worker claim without writing', async () => {
    const id = randomUUID();
    const initial = driver('owner');
    await initial.start({ id, ownerId: 'owner', resourceIds: [], budget });
    const store = createDesignRunStore({
      db,
      ownerId: 'owner',
      tenantId: null,
      enqueue: async () => {},
    });
    const stale = await store.load(id, 'owner');
    if (!stale) throw new Error('Missing test run');
    await initial.stop(id, 'owner');
    expect(
      await store.save(
        { ...stale, revision: stale.revision + 1 },
        stale.revision,
      ),
    ).toBe(false);
    await expect(
      driver('owner', undefined, async () => false).resume(id, 'owner'),
    ).rejects.toBeInstanceOf(DesignRunConflictError);
    expect((await initial.status(id, 'owner')).status).toBe('stopped');
  });
  it('releases only the stopped lease with current worker authorization and matching claim revision', async () => {
    const id = randomUUID();
    const initial = driver('owner');
    await initial.start({ id, ownerId: 'owner', resourceIds: [], budget });
    const releaseAllowed = vi.fn(async () => false);
    const store = createDesignRunStore({
      db,
      ownerId: 'owner',
      tenantId: null,
      enqueue: async () => {},
      authorizeRelease: releaseAllowed,
    });
    const state = await store.load(id, 'owner');
    if (!state) throw new Error('Missing test run');
    const claimed = {
      ...state,
      revision: state.revision + 1,
      leaseRevision: state.revision + 1,
      leaseUntil: Date.now() + 1800000,
    };
    expect(await store.save(claimed, state.revision)).toBe(true);
    await initial.stop(id, 'owner');
    expect(await store.releaseLease?.(id, 'owner', claimed.leaseRevision)).toBe(
      false,
    );
    expect((await store.load(id, 'owner'))?.leaseUntil).toBe(
      claimed.leaseUntil,
    );
    releaseAllowed.mockResolvedValue(true);
    expect(
      await store.releaseLease?.(id, 'owner', claimed.leaseRevision - 1),
    ).toBe(false);
    expect(
      await store.releaseLease?.(id, 'stranger', claimed.leaseRevision),
    ).toBe(false);
    expect(await store.releaseLease?.(id, 'owner', claimed.leaseRevision)).toBe(
      true,
    );
    await initial.resume(id, 'owner');
    expect(await store.releaseLease?.(id, 'owner', claimed.leaseRevision)).toBe(
      false,
    );
    expect((await store.load(id, 'owner'))?.status).toBe('running');
  });
});
