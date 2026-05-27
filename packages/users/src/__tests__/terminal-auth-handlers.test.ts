/**
 * SvelteKit handler tests for the terminal-auth device-code flow.
 *
 * These exercise the request/response contracts of the handler factories
 * exported from `@happyvertical/smrt-users/sveltekit`. We use the same
 * sqlite file across the handlers so the cached service instance sees
 * shared state.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UserCollection } from '../collections/UserCollection.js';
import {
  createBearerSessionDeleteHandler,
  createTerminalAuthStartHandler,
  createTerminalAuthTokenHandler,
  loadBearerSessionContext,
  mountTerminalLoginPage,
  parseBearerToken,
} from '../sveltekit/index.js';

type AnyRecord = Record<string, unknown>;

function makeEvent(init: {
  body?: AnyRecord | URLSearchParams;
  url?: string;
  headers?: Record<string, string>;
  locals?: AnyRecord;
}) {
  const url = new URL(init.url ?? 'https://example.com/');
  const headers = new Headers(init.headers ?? {});
  const isFormData = init.body instanceof URLSearchParams;
  const request = new Request(url.toString(), {
    method: 'POST',
    headers,
    body:
      init.body === undefined
        ? null
        : isFormData
          ? (init.body as URLSearchParams)
          : JSON.stringify(init.body),
  });
  return {
    cookies: { get: () => undefined, set: () => {}, delete: () => {} },
    getClientAddress: () => '127.0.0.1',
    locals: init.locals ?? {},
    params: {},
    request,
    url,
  } as Parameters<ReturnType<typeof createTerminalAuthStartHandler>>[0];
}

describe('terminal-auth SvelteKit handlers', () => {
  let dbPath: string;
  let options: {
    db: { type: 'sqlite'; url: string };
    userCodePrefix: string;
    requestTtlSeconds: number;
    sessionTtlSeconds: number;
  };

  beforeEach(() => {
    dbPath = join(
      tmpdir(),
      `smrt-terminal-handlers-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
    );
    options = {
      db: { type: 'sqlite', url: dbPath },
      userCodePrefix: 'WG',
      requestTtlSeconds: 60,
      sessionTtlSeconds: 3600,
    };
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // ignore cleanup failure
      }
    }
  });

  it('start handler returns 201 with device code, user code, and verification url', async () => {
    const start = createTerminalAuthStartHandler({
      ...options,
      verificationPath: '/terminal-login',
    });
    const event = makeEvent({ url: 'https://example.com/api/cli/auth/start' });

    const response = await start(event);
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.userCode).toMatch(/^WG-[0-9A-F]{8}$/u);
    expect(typeof body.deviceCode).toBe('string');
    expect(body.verificationUrl).toBe(
      `https://example.com/terminal-login?code=${encodeURIComponent(String(body.userCode))}`,
    );
  });

  it('token handler rejects missing deviceCode with 400', async () => {
    const token = createTerminalAuthTokenHandler(options);
    const response = await token(
      makeEvent({ body: {}, url: 'https://example.com/api/cli/auth/token' }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toMatch(/deviceCode/u);
  });

  it('approve → token → loadBearerSession round-trip wires up via cached service', async () => {
    const users = await UserCollection.create({ db: options.db });
    const user = await users.create({ email: 'cli@example.com' });
    await user.save();

    const start = createTerminalAuthStartHandler(options);
    const token = createTerminalAuthTokenHandler(options);

    const startResponse = await start(
      makeEvent({ url: 'https://example.com/api/cli/auth/start' }),
    );
    const startBody = (await startResponse.json()) as {
      userCode: string;
      deviceCode: string;
    };

    const page = mountTerminalLoginPage({
      ...options,
      resolveUser: (event) =>
        event.locals.user as { id: string; email: string },
      resolveTenantId: (event) => event.locals.tenantId as string,
    });
    const approveResult = await page.approve(
      makeEvent({
        body: new URLSearchParams({ userCode: startBody.userCode }),
        url: 'https://example.com/terminal-login',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
        },
        locals: {
          user: { id: user.id!, email: user.email },
          tenantId: 'tenant-1',
        },
      }),
    );
    expect('approved' in approveResult && approveResult.approved).toBe(true);

    const tokenResponse = await token(
      makeEvent({
        body: { deviceCode: startBody.deviceCode },
        url: 'https://example.com/api/cli/auth/token',
      }),
    );
    const tokenBody = (await tokenResponse.json()) as {
      status: string;
      accessToken: string;
    };
    expect(tokenBody.status).toBe('approved');
    expect(tokenBody.accessToken).toBeTruthy();

    const context = await loadBearerSessionContext(
      tokenBody.accessToken,
      options,
    );
    expect(context?.user.id).toBe(user.id);
  });

  it('bearer delete handler revokes the session named in the Authorization header', async () => {
    const users = await UserCollection.create({ db: options.db });
    const user = await users.create({ email: 'cli@example.com' });
    await user.save();

    const start = createTerminalAuthStartHandler(options);
    const startResponse = await start(
      makeEvent({ url: 'https://example.com/api/cli/auth/start' }),
    );
    const { userCode, deviceCode } = (await startResponse.json()) as {
      userCode: string;
      deviceCode: string;
    };

    const page = mountTerminalLoginPage({
      ...options,
      resolveUser: (event) =>
        event.locals.user as { id: string; email: string },
      resolveTenantId: (event) => event.locals.tenantId as string,
    });
    await page.approve(
      makeEvent({
        body: new URLSearchParams({ userCode }),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        locals: {
          user: { id: user.id!, email: user.email },
          tenantId: 'tenant-1',
        },
      }),
    );

    const token = createTerminalAuthTokenHandler(options);
    const tokenResponse = await token(
      makeEvent({
        body: { deviceCode },
        url: 'https://example.com/api/cli/auth/token',
      }),
    );
    const { accessToken } = (await tokenResponse.json()) as {
      accessToken: string;
    };

    expect(
      (await loadBearerSessionContext(accessToken, options))?.sessionId,
    ).toBe(accessToken);

    const del = createBearerSessionDeleteHandler(options);
    const delResponse = await del(
      makeEvent({
        url: 'https://example.com/api/cli/auth/session',
        headers: { authorization: `Bearer ${accessToken}` },
      }),
    );
    expect(delResponse.status).toBe(200);
    expect(await loadBearerSessionContext(accessToken, options)).toBeNull();
  });

  it('parseBearerToken extracts tokens case-insensitively and rejects malformed headers', () => {
    expect(parseBearerToken('Bearer abc123')).toBe('abc123');
    expect(parseBearerToken('bearer   xyz')).toBe('xyz');
    expect(parseBearerToken('Token abc')).toBeNull();
    expect(parseBearerToken(null)).toBeNull();
    expect(parseBearerToken('Bearer    ')).toBeNull();
  });

  it('mount approve action fails 401 when user is not signed in', async () => {
    const page = mountTerminalLoginPage({
      ...options,
      resolveUser: () => null,
      resolveTenantId: () => null,
    });
    const result = await page.approve(
      makeEvent({
        body: new URLSearchParams({ userCode: 'WG-AAAAAAAA' }),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      }),
    );
    expect('type' in result && result.type).toBe('failure');
    if ('type' in result) {
      expect(result.status).toBe(401);
    }
  });
});
