/**
 * The REST `_events` route captures the connection's tenant scope before it
 * reserves a subscriber slot, so a scope that cannot be resolved leaves no
 * slot reserved. `resolveDispatchTenantScope()` is written not to throw; the
 * route does not rely on that.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureChangeFeedTable,
  registerChangeFeedWriter,
  resetChangeFeedWarnings,
} from '../change-feed';
import {
  changeSignalSubscriberCount,
  resetChangeSignals,
} from '../change-signals';
import { handleEventsRoute } from '../generators/events-route';
import { getTestDatabase } from '../testing/database';

const scope = vi.hoisted(() => ({ fail: false }));
vi.mock('../dispatch/tenant-resolver', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../dispatch/tenant-resolver')>();
  return {
    ...actual,
    resolveDispatchTenantScope: () => {
      if (scope.fail) throw new Error('tenant scope unavailable');
      return actual.resolveDispatchTenantScope();
    },
  };
});

describe('_events route: tenant scope before the subscriber slot', () => {
  let db: DatabaseInterface;
  const allowAuth =
    () =>
    async (req: Request): Promise<Request | Response> =>
      req;

  beforeEach(async () => {
    scope.fail = false;
    registerChangeFeedWriter();
    resetChangeFeedWarnings();
    resetChangeSignals();
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: [],
    });
    await ensureChangeFeedTable(db);
  });

  afterEach(async () => {
    scope.fail = false;
    resetChangeSignals();
    await db.close?.();
  });

  it('leaves no slot reserved when the tenant scope cannot be resolved', async () => {
    scope.fail = true;
    await expect(
      handleEventsRoute(new Request('http://x/api/v1/_events'), {
        authMiddleware: allowAuth,
        db,
      }),
    ).rejects.toThrow('tenant scope unavailable');
    expect(changeSignalSubscriberCount(db)).toBe(0);
  });

  it('opens a stream and holds one subscription when the scope resolves', async () => {
    const response = await handleEventsRoute(
      new Request('http://x/api/v1/_events'),
      { authMiddleware: allowAuth, db },
    );
    expect(response.status).toBe(200);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    expect(changeSignalSubscriberCount(db)).toBe(1);
    await reader.cancel();
  });
});
