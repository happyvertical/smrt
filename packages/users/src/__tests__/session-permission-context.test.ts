import { afterEach, describe, expect, it, vi } from 'vitest';

// The SvelteKit session handler logs via @happyvertical/logger (S14); mock it to
// assert on the logger instead of a console spy.
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@happyvertical/logger', () => ({ createLogger: () => mockLogger }));

import { getRequestScopedDatabase } from '../services/SessionPermissionContext.js';
import { SessionService } from '../services/SessionService.js';
import { createSessionHandler } from '../sveltekit/index.js';

function createHandlerEvent() {
  return {
    cookies: {
      delete: vi.fn(),
      get: vi.fn().mockReturnValue('session-123'),
      set: vi.fn(),
    },
    locals: {} as Record<string, unknown>,
    request: { headers: new Headers() },
    url: { pathname: '/dashboard' },
  };
}

const handlerSessionContext = {
  permissions: ['articles.read'],
  sessionId: 'session-123',
  tenantId: 'tenant-123',
  user: {
    email: 'handler@example.com',
    id: 'user-123',
  },
};

/**
 * Stub the session service for one isolation mode. `postgresRls` mode needs a
 * transaction-capable database so the request context opens successfully.
 */
function stubSessionService(mode: 'application' | 'postgresRls') {
  const transaction = {
    commit: vi.fn().mockResolvedValue(undefined),
    isActive: vi.fn().mockReturnValue(true),
    query: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    url: 'postgres://transaction-db',
  };
  const baseDb =
    mode === 'postgresRls'
      ? {
          beginTransaction: vi.fn().mockResolvedValue(transaction),
          query: vi.fn().mockResolvedValue(undefined),
          url: 'postgres://base-db',
        }
      : { query: vi.fn().mockResolvedValue(undefined), url: 'sqlite://app.db' };
  const loadSessionContext = vi.fn().mockResolvedValue(handlerSessionContext);
  vi.spyOn(SessionService, 'create').mockResolvedValue({
    getDatabase: () => baseDb,
    loadSessionContext,
  } as unknown as SessionService);
  const handler = createSessionHandler(
    mode === 'postgresRls'
      ? {
          db: { type: 'postgres', url: 'postgres://base-db' },
          postgresRls: true,
        }
      : { db: { type: 'sqlite', url: 'app.db' } },
  );
  return { handler, loadSessionContext, transaction };
}

describe('Session Permission Context', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockLogger.error.mockReset();
  });

  // #3377 / #3510: the session handler must only handle its own
  // initialisation failures. A throw from the downstream chain (another
  // handle, or SvelteKit's `redirect()`) propagates exactly once and is never
  // re-run outside the session/tenant context.
  describe.each([
    'application',
    'postgresRls',
  ] as const)('downstream errors (%s isolation)', (mode) => {
    it('propagates a downstream error once without re-running resolve', async () => {
      const { handler, transaction } = stubSessionService(mode);
      const event = createHandlerEvent();
      const failure = new Error('downstream failure');
      const resolve = vi.fn(async () => {
        throw failure;
      });

      await expect(handler({ event, resolve })).rejects.toBe(failure);

      expect(resolve).toHaveBeenCalledTimes(1);
      expect(mockLogger.error).not.toHaveBeenCalled();
      if (mode === 'postgresRls') {
        // The request transaction is rolled back, never committed.
        expect(transaction.rollback).toHaveBeenCalledTimes(1);
        expect(transaction.commit).not.toHaveBeenCalled();
      }
    });

    it('propagates a downstream redirect once with session locals intact', async () => {
      const { handler } = stubSessionService(mode);
      const event = createHandlerEvent();
      // Shape of SvelteKit's `Redirect`, thrown by `redirect(302, '/x')`.
      const redirect = { status: 302, location: '/x' };
      let downstreamRuns = 0;
      const resolve = vi.fn(async () => {
        downstreamRuns += 1;
        throw redirect;
      });

      await expect(handler({ event, resolve })).rejects.toBe(redirect);

      expect(downstreamRuns).toBe(1);
      expect(event.locals.user).toEqual(handlerSessionContext.user);
      expect(mockLogger.error).not.toHaveBeenCalled();
    });
  });

  it('still resolves once without a session when application-mode session loading fails', async () => {
    const { handler, loadSessionContext } = stubSessionService('application');
    loadSessionContext.mockRejectedValue(new Error('session store down'));
    const event = createHandlerEvent();
    const resolve = vi.fn(async () => new Response('ok'));

    const response = await handler({ event, resolve });

    expect(response.status).toBe(200);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(event.locals.user).toBeNull();
    expect(event.locals.tenantId).toBeNull();
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Session or request context initialization error',
      { error: expect.any(Error) },
    );
  });

  it('should populate locals and expose the transaction-scoped database in the handler', async () => {
    const transaction = {
      commit: vi.fn().mockResolvedValue(undefined),
      isActive: vi.fn().mockReturnValue(true),
      query: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      url: 'postgres://transaction-db',
    };
    const baseDb = {
      beginTransaction: vi.fn().mockResolvedValue(transaction),
      query: vi.fn().mockResolvedValue(undefined),
      url: 'postgres://base-db',
    };
    const sessionContext = {
      permissions: ['articles.read', 'articles.update'],
      sessionId: 'session-123',
      tenantId: 'tenant-123',
      user: {
        email: 'handler@example.com',
        id: 'user-123',
      },
    };
    const fakeSessionService = {
      getDatabase: () => baseDb,
      loadSessionContext: vi.fn().mockResolvedValue(sessionContext),
    } as unknown as SessionService;

    vi.spyOn(SessionService, 'create').mockResolvedValue(fakeSessionService);

    const handler = createSessionHandler({
      db: { type: 'postgres', url: 'postgres://base-db' },
      postgresRls: true,
    });

    const event = {
      cookies: {
        delete: vi.fn(),
        get: vi.fn().mockReturnValue('session-123'),
        set: vi.fn(),
      },
      locals: {} as Record<string, unknown>,
      request: { headers: new Headers() },
      url: { pathname: '/dashboard' },
    };
    const resolve = vi.fn(async () => {
      expect(getRequestScopedDatabase()).toBe(transaction);
      return new Response('ok');
    });

    const response = await handler({
      event,
      resolve,
    });

    expect(response.status).toBe(200);
    expect(event.locals.user).toEqual(sessionContext.user);
    expect(event.locals.permissions).toEqual(sessionContext.permissions);
    expect(event.locals.tenantId).toBe('tenant-123');
    expect(event.locals.sessionId).toBe('session-123');
    expect(baseDb.beginTransaction).toHaveBeenCalledTimes(1);
    expect(transaction.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("set_config('smrt.tenant_id'"),
      'tenant-123',
    );
    expect(transaction.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("set_config('smrt.user_id'"),
      'user-123',
    );
    expect(transaction.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("set_config('smrt.session_id'"),
      'session-123',
    );
    expect(transaction.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("set_config('smrt.permissions'"),
      JSON.stringify(sessionContext.permissions),
    );
    expect(transaction.query).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining("set_config('smrt.super_admin_bypass'"),
      'false',
    );
    expect(transaction.query).toHaveBeenNthCalledWith(
      6,
      expect.stringContaining("set_config('smrt.system_context'"),
      'false',
    );
    expect(transaction.commit).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('should fail closed when Postgres RLS context initialization fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const baseDb = {
      query: vi.fn().mockResolvedValue(undefined),
      url: 'postgres://base-db',
    };
    const sessionContext = {
      permissions: ['articles.read'],
      sessionId: 'session-123',
      tenantId: 'tenant-123',
      user: {
        email: 'handler@example.com',
        id: 'user-123',
      },
    };
    const fakeSessionService = {
      getDatabase: () => baseDb,
      loadSessionContext: vi.fn().mockResolvedValue(sessionContext),
    } as unknown as SessionService;

    vi.spyOn(SessionService, 'create').mockResolvedValue(fakeSessionService);

    const handler = createSessionHandler({
      db: { type: 'postgres', url: 'postgres://base-db' },
      postgresRls: true,
    });

    const event = {
      cookies: {
        delete: vi.fn(),
        get: vi.fn().mockReturnValue('session-123'),
        set: vi.fn(),
      },
      locals: {} as Record<string, unknown>,
      request: { headers: new Headers() },
      url: { pathname: '/dashboard' },
    };
    const resolve = vi.fn(async () => new Response('ok'));

    const response = await handler({
      event,
      resolve,
    });

    expect(response.status).toBe(500);
    expect(resolve).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Session or request context initialization error',
      { error: expect.any(Error) },
    );
  });
});
