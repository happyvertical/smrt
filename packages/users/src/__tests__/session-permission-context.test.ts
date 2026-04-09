import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRequestScopedDatabase } from '../services/SessionPermissionContext.js';
import { SessionService } from '../services/SessionService.js';
import { createSessionHandler } from '../sveltekit/index.js';

describe('Session Permission Context', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
    expect(errorSpy).toHaveBeenCalledWith(
      'Session or request context initialization error:',
      expect.any(Error),
    );
  });
});
