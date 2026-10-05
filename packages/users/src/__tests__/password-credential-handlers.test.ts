/**
 * `createPasswordCredentialHandlers` wire contract (#3274): the session
 * cookie, identical non-enumerating 401s, 429 + Retry-After, `no-store`,
 * form and JSON bodies, and locals-based actor resolution for management.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import type { User } from '../models/User.js';
import { DEFAULT_PASSWORD_MANAGE_PERMISSION } from '../services/PasswordCredentialService.js';
import { SessionService } from '../services/SessionService.js';
import {
  createPasswordCredentialHandlers,
  type PasswordCredentialHandlers,
  type PasswordRequestEvent,
} from '../sveltekit/index.js';

const PASSWORD = 'correct horse battery';

interface CookieJar {
  values: Map<string, string>;
  set: Array<{
    name: string;
    value: string;
    options?: Record<string, unknown>;
  }>;
  deleted: string[];
}

function makeEvent(
  init: {
    body?: unknown;
    form?: Record<string, string>;
    locals?: Record<string, unknown>;
    cookies?: Record<string, string>;
    address?: string;
  } = {},
): { event: PasswordRequestEvent; jar: CookieJar } {
  const url = new URL('https://office.example/auth/password');
  const jar: CookieJar = {
    values: new Map(Object.entries(init.cookies ?? {})),
    set: [],
    deleted: [],
  };
  const request = init.form
    ? new Request(url, {
        method: 'POST',
        body: new URLSearchParams(init.form),
      })
    : new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body:
          init.body === undefined
            ? undefined
            : typeof init.body === 'string'
              ? init.body
              : JSON.stringify(init.body),
      });
  return {
    jar,
    event: {
      request,
      url,
      getClientAddress: () => init.address ?? '203.0.113.7',
      locals: init.locals ?? {},
      cookies: {
        get: (name) => jar.values.get(name),
        set: (name, value, options) => {
          jar.values.set(name, value);
          jar.set.push({ name, value, options });
        },
        delete: (name) => {
          jar.values.delete(name);
          jar.deleted.push(name);
        },
      },
    },
  };
}

const read = async (response: Response) =>
  (await response.json()) as Record<string, unknown>;

describe('createPasswordCredentialHandlers', () => {
  let dbPath: string;
  let options: { db: { type: 'sqlite'; url: string } };
  let handlers: PasswordCredentialHandlers;
  let sessionService: SessionService;
  let tenantId: string;
  let person: User;
  let admin: User;
  let inactive: User;

  const localsFor = async (sessionId: string) => {
    const context = await sessionService.loadSessionContext(sessionId);
    if (!context) throw new Error('no session');
    // What createSessionHandler puts in locals.
    return {
      user: context.user,
      membership: context.membership,
      permissions: context.permissions,
      tenantId: context.tenantId,
      sessionId: context.sessionId,
      authMethod: context.authMethod,
      sessionParent: context.parent,
    };
  };

  const signIn = (
    email: string,
    password: string,
    extra: Parameters<typeof makeEvent>[0] = {},
  ) => {
    const made = makeEvent({ body: { email, password }, ...extra });
    return handlers.signIn(made.event).then((response) => ({
      response,
      jar: made.jar,
    }));
  };

  beforeEach(async () => {
    dbPath = join(
      tmpdir(),
      `smrt-password-handlers-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
    );
    options = { db: { type: 'sqlite', url: dbPath } };
    const users = await UserCollection.create(options);
    sessionService = await SessionService.create(options);
    const tenants = await TenantCollection.create(options);
    const roles = await RoleCollection.create(options);
    const memberships = await MembershipCollection.create(options);
    const tenant = await tenants.create({ name: 'Office' });
    await tenant.save();
    tenantId = tenant.id as string;
    const role = await roles.create({ name: 'Staff' });
    await role.save();
    const made: User[] = [];
    for (const email of [
      'pat@example.com',
      'admin@example.com',
      'gone@example.com',
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
    [person, admin, inactive] = made;

    handlers = createPasswordCredentialHandlers({
      ...options,
      tenantId: () => tenantId,
      password: { scrypt: { N: 2 ** 10 } },
      limiter: { maxAttempts: 3, windowSeconds: 60, audit: false },
    });
    const service = await handlers.service();
    const adminActor = {
      user: admin,
      permissions: [DEFAULT_PASSWORD_MANAGE_PERMISSION],
      tenantId,
      sessionId: 'admin-browser',
      authMethod: 'oidc',
      parent: null,
    };
    for (const target of [person, inactive]) {
      await service.setPassword({
        actor: adminActor,
        userId: target.id as string,
        password: PASSWORD,
      });
    }
    inactive.status = 'suspended' as User['status'];
    await inactive.save();
  });

  afterEach(() => {
    if (existsSync(dbPath)) rmSync(dbPath, { force: true });
  });

  it('signs in, sets an httpOnly session cookie, and never returns the session id', async () => {
    const { response, jar } = await signIn('Pat@Example.com', PASSWORD);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = await read(response);
    expect(body).toMatchObject({
      authenticated: true,
      userId: person.id,
      tenantId,
      mustChange: false,
    });
    const cookie = jar.set.find((entry) => entry.name === 'sid');
    expect(cookie?.options).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
    });
    expect(Number(cookie?.options?.maxAge)).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toContain(cookie?.value as string);
    const context = await sessionService.loadSessionContext(
      cookie?.value as string,
    );
    expect(context?.user.id).toBe(person.id);
    expect(context?.authMethod).toBe('password');
  });

  it('accepts a form post', async () => {
    const made = makeEvent({
      form: { email: 'pat@example.com', password: PASSWORD },
    });
    const response = await handlers.signIn(made.event);
    expect(response.status).toBe(200);
    expect(made.jar.values.get('sid')).toBeTruthy();
  });

  it('answers every refusal with the same 401 body and sets no cookie', async () => {
    const bodies = new Set<string>();
    const cases: Array<[string, unknown]> = [
      ['unknown', { email: 'nobody@example.com', password: PASSWORD }],
      ['wrong', { email: 'pat@example.com', password: 'wrong horse battery' }],
      ['no password', { email: 'admin@example.com', password: PASSWORD }],
      ['inactive', { email: 'gone@example.com', password: PASSWORD }],
      ['missing password', { email: 'pat@example.com' }],
      ['missing email', { password: PASSWORD }],
      ['not json', 'nonsense'],
    ];
    for (const [index, [label, payload]] of cases.entries()) {
      const made = makeEvent({
        body: payload,
        address: `198.51.100.${index + 1}`,
      });
      const response = await handlers.signIn(made.event);
      expect(response.status, label).toBe(401);
      expect(response.headers.get('cache-control'), label).toBe(
        'private, no-store',
      );
      bodies.add(JSON.stringify(await read(response)));
      expect(made.jar.set, label).toEqual([]);
    }
    expect([...bodies]).toEqual([
      JSON.stringify({
        error: 'Invalid credentials.',
        code: 'invalid_credentials',
      }),
    ]);
  });

  it('returns 429 with Retry-After once the account is locked out', async () => {
    for (let i = 0; i < 3; i++) {
      const { response } = await signIn('pat@example.com', 'wrong guess', {
        address: `192.0.2.${i}`,
      });
      expect(response.status).toBe(401);
    }
    const { response, jar } = await signIn('pat@example.com', PASSWORD, {
      address: '192.0.2.77',
    });
    expect(response.status).toBe(429);
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await read(response)).code).toBe('rate_limited');
    expect(jar.set).toEqual([]);
  });

  it('revokes the session cookie the browser held before signing in', async () => {
    const stale = await sessionService.createSession(admin.id as string);
    const { response, jar } = await signIn('pat@example.com', PASSWORD, {
      cookies: { sid: stale },
    });
    expect(response.status).toBe(200);
    expect(jar.values.get('sid')).not.toBe(stale);
    expect(await sessionService.loadSessionContext(stale)).toBeNull();
  });

  it('changes the password from the signed-in session and reports policy errors', async () => {
    const { jar } = await signIn('pat@example.com', PASSWORD);
    const locals = await localsFor(jar.values.get('sid') as string);

    const weak = makeEvent({
      body: { currentPassword: PASSWORD, newPassword: 'short' },
      locals,
    });
    const refused = await handlers.changePassword(weak.event);
    expect(refused.status).toBe(400);
    expect(await read(refused)).toMatchObject({ code: 'password_policy' });

    const wrong = makeEvent({
      body: { currentPassword: 'nope nope nope', newPassword: 'a new secret!' },
      locals,
    });
    expect((await handlers.changePassword(wrong.event)).status).toBe(401);

    const ok = makeEvent({
      body: { currentPassword: PASSWORD, newPassword: 'a new secret!' },
      locals,
    });
    const changed = await handlers.changePassword(ok.event);
    expect(changed.status).toBe(200);
    expect(await read(changed)).toEqual({ revokedSessions: 0 });
    expect(ok.jar.deleted).toEqual([]);
  });

  it('refuses management without a session, without authMethod in locals, or without permission', async () => {
    const none = makeEvent({ body: { userId: person.id, password: PASSWORD } });
    expect((await handlers.resetPassword(none.event)).status).toBe(401);

    const { jar } = await signIn('pat@example.com', PASSWORD);
    const locals = await localsFor(jar.values.get('sid') as string);
    const { authMethod: _drop, ...noChannel } = locals;
    const unknownChannel = makeEvent({
      body: { userId: admin.id, password: 'another long secret' },
      locals: noChannel,
    });
    expect((await handlers.resetPassword(unknownChannel.event)).status).toBe(
      401,
    );

    const forbidden = makeEvent({
      body: { userId: admin.id, password: 'another long secret' },
      locals,
    });
    const response = await handlers.resetPassword(forbidden.event);
    expect(response.status).toBe(403);
    expect(await read(response)).toMatchObject({ code: 'forbidden' });
  });

  it('lets an administrator reset a password, and the next sign-in must change it', async () => {
    const adminLocals = {
      user: admin,
      membership: null,
      permissions: [DEFAULT_PASSWORD_MANAGE_PERMISSION],
      tenantId,
      sessionId: 'admin-browser',
      authMethod: 'oidc',
      sessionParent: null,
    };
    const reset = makeEvent({
      body: { userId: person.id, password: 'temporary secret 1' },
      locals: adminLocals,
    });
    const response = await handlers.resetPassword(reset.event);
    expect(response.status).toBe(200);

    const { response: signedIn, jar } = await signIn(
      'pat@example.com',
      'temporary secret 1',
    );
    expect((await read(signedIn)).mustChange).toBe(true);
    const locals = await localsFor(jar.values.get('sid') as string);
    expect(locals.permissions).toEqual([]);

    const change = makeEvent({
      body: {
        currentPassword: 'temporary secret 1',
        newPassword: 'my own new secret',
      },
      locals,
      cookies: { sid: jar.values.get('sid') as string },
    });
    const changed = await handlers.changePassword(change.event);
    expect(changed.status).toBe(200);
    expect(await read(changed)).toMatchObject({ signedOut: true });
    expect(change.jar.deleted).toEqual(['sid']);
  });
});
