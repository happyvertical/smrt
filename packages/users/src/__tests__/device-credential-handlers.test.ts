/**
 * `createDeviceCredentialHandlers` wire contract (#3276): status and error
 * mapping, non-enumerating 401/429 responses, `no-store` on credential
 * responses, and bearer-versus-locals actor resolution for PIN management.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { SessionCollection } from '../collections/SessionCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import type { User } from '../models/User.js';
import { DEFAULT_PIN_MANAGE_PERMISSION } from '../services/DeviceCredentialService.js';
import { SessionService } from '../services/SessionService.js';
import {
  createDeviceCredentialHandlers,
  type DeviceCredentialHandlers,
} from '../sveltekit/index.js';

type HandlerEvent = Parameters<DeviceCredentialHandlers['pinSignIn']>[0];

function makeEvent(
  init: {
    method?: string;
    bearer?: string;
    body?: unknown;
    locals?: Record<string, unknown>;
  } = {},
): HandlerEvent {
  const url = new URL('https://shop.example/api/device/pin');
  return {
    request: new Request(url, {
      method: init.method ?? 'POST',
      headers: {
        'content-type': 'application/json',
        ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
      },
      body:
        init.body === undefined
          ? undefined
          : typeof init.body === 'string'
            ? init.body
            : JSON.stringify(init.body),
    }),
    url,
    getClientAddress: () => '203.0.113.7',
    locals: init.locals ?? {},
  };
}

const json = async (response: Response) =>
  (await response.json()) as Record<string, unknown>;

describe('createDeviceCredentialHandlers', () => {
  let dbPath: string;
  let options: { db: { type: 'sqlite'; url: string } };
  let handlers: DeviceCredentialHandlers;
  let makeHandlers: (maxAttempts: number) => DeviceCredentialHandlers;
  let sessions: SessionCollection;
  let sessionService: SessionService;
  let tenantId: string;
  let deviceToken: string;
  let person: User;
  let other: User;
  let admin: User;

  /** What `createSessionHandler` puts in locals for an admin browser session. */
  const adminLocals = (extra: Record<string, unknown> = {}) => ({
    user: admin,
    membership: null,
    permissions: [DEFAULT_PIN_MANAGE_PERMISSION],
    tenantId,
    sessionId: 'admin-browser-session',
    authMethod: 'oidc',
    sessionParent: null,
    ...extra,
  });

  const signIn = (userId: string, pin: string, bearer = deviceToken) =>
    handlers.pinSignIn(makeEvent({ bearer, body: { userId, pin } }));

  beforeEach(async () => {
    dbPath = join(
      tmpdir(),
      `smrt-device-handlers-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
    );
    options = { db: { type: 'sqlite', url: dbPath } };
    const users = await UserCollection.create(options);
    sessions = await SessionCollection.create(options);
    sessionService = await SessionService.create(options);
    const tenants = await TenantCollection.create(options);
    const roles = await RoleCollection.create(options);
    const memberships = await MembershipCollection.create(options);

    const tenant = await tenants.create({ name: 'Shop Floor' });
    await tenant.save();
    tenantId = tenant.id as string;
    const role = await roles.create({ name: 'Operator' });
    await role.save();

    const made: User[] = [];
    for (const email of [
      'tablet@devices.example',
      'pat@example.com',
      'sam@example.com',
      'admin@example.com',
    ]) {
      const user = await users.create({ email });
      await user.save();
      const membership = await memberships.create({
        userId: user.id as string,
        tenantId,
        roleId: role.id as string,
      });
      await membership.save();
      made.push(user);
    }
    const device = made[0] as User;
    [, person, other, admin] = made as [User, User, User, User];

    const deviceSession = await sessions.createSession({
      userId: device.id as string,
      tenantId,
      ttl: 3600,
      authMethod: 'terminal',
    });
    deviceToken = deviceSession.id as string;

    makeHandlers = (maxAttempts) =>
      createDeviceCredentialHandlers({
        ...options,
        pin: { pepper: 'test-pepper', scrypt: { N: 2 ** 10 } },
        limiter: { maxAttempts, windowSeconds: 60, audit: false },
        assertEnrolledDevice: async (context) => context.user.id === device.id,
      });
    handlers = makeHandlers(3);
    const set = await handlers.setPin(
      makeEvent({
        method: 'PUT',
        locals: adminLocals(),
        body: { userId: person.id, pin: '2580' },
      }),
    );
    expect(set.status).toBe(204);
  });

  afterEach(() => {
    if (existsSync(dbPath)) rmSync(dbPath, { force: true });
  });

  it('signs in with 201, a no-store response, and a usable person bearer', async () => {
    const response = await signIn(person.id as string, '2580');
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = await json(response);
    expect(body).toMatchObject({
      userId: person.id,
      tenantId,
      authMethod: 'pin',
      mustReset: false,
      absoluteExpiresAt: null,
    });
    const context = await sessionService.loadSessionContext(
      body.sessionId as string,
    );
    expect(context?.user.id).toBe(person.id);
    expect(context?.parent?.sessionId).toBe(deviceToken);
  });

  it('answers every non-rate-limit refusal with one indistinguishable 401', async () => {
    // A budget wide enough that none of these refusals is a rate limit.
    handlers = makeHandlers(50);
    const browser = await sessions.createSession({
      userId: admin.id as string,
      tenantId,
      authMethod: 'oidc',
    });
    const refusals = [
      await signIn(person.id as string, '0000'), // wrong PIN
      await signIn(crypto.randomUUID(), '2580'), // unknown user
      await signIn('not-a-uuid', '2580'), // malformed user id
      await signIn(other.id as string, '2580'), // nothing enrolled
      await signIn(person.id as string, '2580', browser.id as string), // not a device
      await signIn(person.id as string, '2580', 'garbage'), // no such session
      await handlers.pinSignIn(
        makeEvent({ body: { userId: person.id, pin: '2580' } }),
      ), // no bearer
      await handlers.pinSignIn(
        makeEvent({ bearer: deviceToken, body: 'not json' }),
      ), // unparseable body
      await handlers.pinSignIn(
        makeEvent({ bearer: deviceToken, body: { userId: person.id } }),
      ), // missing pin
    ];
    const bodies = new Set<string>();
    for (const response of refusals) {
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      bodies.add(JSON.stringify(await json(response)));
    }
    expect([...bodies]).toEqual([
      JSON.stringify({
        error: 'Invalid credentials.',
        code: 'invalid_credentials',
      }),
    ]);
  });

  it('answers an exhausted budget with 429, Retry-After, and no-store — even for the right PIN', async () => {
    for (let i = 0; i < 3; i++) {
      expect((await signIn(person.id as string, '1111')).status).toBe(401);
    }
    const limited = await signIn(person.id as string, '2580');
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(limited.headers.get('cache-control')).toBe('private, no-store');
    expect(await json(limited)).toEqual({
      error: 'Too many attempts. Try again later.',
      code: 'rate_limited',
    });
  });

  it('signs out only the person, and always answers the same way', async () => {
    const { sessionId } = await json(await signIn(person.id as string, '2580'));
    for (const bearer of [sessionId as string, 'garbage', undefined]) {
      const response = await handlers.signOut(makeEvent({ bearer }));
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(await json(response)).toEqual({ authenticated: false });
    }
    expect(
      await sessionService.loadSessionContext(sessionId as string),
    ).toBeNull();
    // A device token sent to sign-out does not end the device session.
    await handlers.signOut(makeEvent({ bearer: deviceToken }));
    expect(await sessionService.loadSessionContext(deviceToken)).not.toBeNull();
  });

  it('resolves a bearer actor as a PIN session: own PIN with currentPin only', async () => {
    const { sessionId } = await json(await signIn(person.id as string, '2580'));
    const put = (body: Record<string, unknown>) =>
      handlers.setPin(
        makeEvent({ method: 'PUT', bearer: sessionId as string, body }),
      );

    const missingCurrent = await put({ pin: '1357' });
    expect(missingCurrent.status).toBe(403);
    expect((await json(missingCurrent)).code).toBe('forbidden');

    const wrongCurrent = await put({ pin: '1357', currentPin: '9999' });
    expect(wrongCurrent.status).toBe(401);
    expect((await json(wrongCurrent)).code).toBe('invalid_credentials');

    const policy = await put({ pin: '1234', currentPin: '2580' });
    expect(policy.status).toBe(400);
    expect((await json(policy)).code).toBe('pin_policy');

    // userId defaults to the actor.
    const changed = await put({ pin: '1357', currentPin: '2580' });
    expect(changed.status).toBe(204);
    expect((await signIn(person.id as string, '1357')).status).toBe(201);
  });

  it('prefers the bearer over locals, so a PIN session cannot borrow admin locals', async () => {
    const { sessionId } = await json(await signIn(person.id as string, '2580'));
    // Admin-looking locals alongside a PIN bearer: the bearer is the actor.
    for (const [handler, method, body] of [
      [handlers.setPin, 'PUT', { userId: other.id, pin: '1357' }],
      [handlers.resetPin, 'POST', { userId: other.id, pin: '1357' }],
      [handlers.clearPin, 'DELETE', { userId: other.id }],
    ] as const) {
      const response = await handler(
        makeEvent({
          method,
          bearer: sessionId as string,
          locals: adminLocals(),
          body,
        }),
      );
      expect(response.status).toBe(403);
    }
  });

  it('acts as the locals session only when the hook supplied authMethod', async () => {
    const body = { userId: other.id, pin: '1357' };

    const unauthenticated = await handlers.setPin(
      makeEvent({ method: 'PUT', body }),
    );
    expect(unauthenticated.status).toBe(401);
    expect((await json(unauthenticated)).code).toBe('unauthenticated');

    // A hook that forgot authMethod is refused rather than assumed first-class.
    const { authMethod: _omitted, ...withoutAuthMethod } = adminLocals();
    expect(
      (
        await handlers.setPin(
          makeEvent({ method: 'PUT', locals: withoutAuthMethod, body }),
        )
      ).status,
    ).toBe(401);

    // Locals describing a layered session never administer.
    const layered = await handlers.setPin(
      makeEvent({
        method: 'PUT',
        locals: adminLocals({
          authMethod: 'pin',
          sessionParent: { sessionId: deviceToken },
        }),
        body,
      }),
    );
    expect(layered.status).toBe(403);

    // Without the manage permission: forbidden.
    const noPermission = await handlers.setPin(
      makeEvent({
        method: 'PUT',
        locals: adminLocals({ permissions: [] }),
        body,
      }),
    );
    expect(noPermission.status).toBe(403);

    // A dead bearer is unauthenticated, not a fall-through to locals.
    const deadBearer = await handlers.setPin(
      makeEvent({
        method: 'PUT',
        bearer: 'garbage',
        locals: adminLocals(),
        body,
      }),
    );
    expect(deadBearer.status).toBe(401);

    const allowed = await handlers.setPin(
      makeEvent({ method: 'PUT', locals: adminLocals(), body }),
    );
    expect(allowed.status).toBe(204);
    expect((await signIn(other.id as string, '1357')).status).toBe(201);
  });

  it('admin reset and clear report revoked sessions with no-store', async () => {
    const { sessionId } = await json(await signIn(person.id as string, '2580'));
    const reset = await handlers.resetPin(
      makeEvent({
        locals: adminLocals(),
        body: { userId: person.id, pin: '8642' },
      }),
    );
    expect(reset.status).toBe(200);
    expect(reset.headers.get('cache-control')).toBe('private, no-store');
    expect(await json(reset)).toEqual({ revokedSessions: 1 });
    expect(
      await sessionService.loadSessionContext(sessionId as string),
    ).toBeNull();

    const temporary = await json(await signIn(person.id as string, '8642'));
    expect(temporary.mustReset).toBe(true);

    const cleared = await handlers.clearPin(
      makeEvent({
        method: 'DELETE',
        locals: adminLocals(),
        body: { userId: person.id },
      }),
    );
    expect(cleared.status).toBe(200);
    expect(await json(cleared)).toEqual({ revokedSessions: 1 });
    expect((await signIn(person.id as string, '8642')).status).toBe(401);
  });
});
