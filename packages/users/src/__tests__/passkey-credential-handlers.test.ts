/**
 * `createPasskeyCredentialHandlers` wire contract (#3275): the session cookie
 * after a real passkey ceremony, identical non-enumerating 401s, 429 +
 * Retry-After, `no-store`, locals-based actor resolution for management, and
 * the management status codes (403, 401 reauthentication, 400 registration).
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
import { DEFAULT_PASSKEY_MANAGE_PERMISSION } from '../services/PasskeyCredentialService.js';
import { SessionService } from '../services/SessionService.js';
import {
  createPasskeyCredentialHandlers,
  type PasskeyCredentialHandlers,
  type PasskeyRequestEvent,
} from '../sveltekit/index.js';
import { SoftAuthenticator } from './helpers/soft-authenticator.js';

const ORIGIN = 'https://app.example.com';
const RP_ID = 'app.example.com';

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
    method?: string;
    body?: unknown;
    search?: string;
    locals?: Record<string, unknown>;
    cookies?: Record<string, string>;
    address?: string;
  } = {},
): { event: PasskeyRequestEvent; jar: CookieJar } {
  const url = new URL(`${ORIGIN}/auth/passkey${init.search ?? ''}`);
  const jar: CookieJar = {
    values: new Map(Object.entries(init.cookies ?? {})),
    set: [],
    deleted: [],
  };
  const method = init.method ?? 'POST';
  const request = new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body:
      method === 'GET' || init.body === undefined
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

describe('createPasskeyCredentialHandlers', () => {
  let dbPath: string;
  let options: { db: { type: 'sqlite'; url: string } };
  let handlers: PasskeyCredentialHandlers;
  let sessionService: SessionService;
  let sessions: SessionCollection;
  let tenantId: string;
  let person: User;
  let admin: User;
  let inactive: User;

  const localsFor = async (
    sessionId: string,
    extra: { permissions?: string[] } = {},
  ) => {
    const context = await sessionService.loadSessionContext(sessionId);
    if (!context) throw new Error('no session');
    // What createSessionHandler puts in locals.
    return {
      user: context.user,
      membership: context.membership,
      permissions: extra.permissions ?? context.permissions,
      tenantId: context.tenantId,
      sessionId: context.sessionId,
      authMethod: context.authMethod,
      sessionParent: context.parent,
    };
  };

  /** A fresh, first-class session for `user`, as locals. */
  const sessionLocals = async (
    user: User,
    extra: { permissions?: string[]; authMethod?: string } = {},
  ) =>
    localsFor(
      await sessionService.createSession(user.id as string, tenantId, {
        authMethod: extra.authMethod ?? 'password',
      }),
      extra,
    );

  const registerPasskey = async (
    user: User,
    authenticator: SoftAuthenticator,
    name = 'Laptop',
  ) => {
    const locals = await sessionLocals(user);
    const options_ = makeEvent({ locals });
    const begun = await read(
      await handlers.registrationOptions(options_.event),
    );
    const finish = makeEvent({
      locals,
      body: {
        ceremonyId: begun.ceremonyId,
        response: authenticator.register(
          begun.options as Parameters<SoftAuthenticator['register']>[0],
        ),
        name,
      },
    });
    return handlers.register(finish.event);
  };

  const signIn = async (
    authenticator: SoftAuthenticator,
    extra: Parameters<typeof makeEvent>[0] & {
      assertion?: Parameters<SoftAuthenticator['assert']>[1];
    } = {},
  ) => {
    const begun = await read(
      await handlers.authenticationOptions(makeEvent().event),
    );
    const made = makeEvent({
      ...extra,
      body: {
        ceremonyId: begun.ceremonyId,
        response: authenticator.assert(
          begun.options as Parameters<SoftAuthenticator['assert']>[0],
          extra.assertion,
        ),
      },
    });
    return { response: await handlers.signIn(made.event), jar: made.jar };
  };

  const newAuthenticator = () =>
    new SoftAuthenticator({ origin: ORIGIN, rpId: RP_ID });

  beforeEach(async () => {
    dbPath = join(
      tmpdir(),
      `smrt-passkey-handlers-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
    );
    options = { db: { type: 'sqlite', url: dbPath } };
    const users = await UserCollection.create(options);
    sessionService = await SessionService.create(options);
    sessions = await SessionCollection.create(options);
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

    handlers = createPasskeyCredentialHandlers({
      ...options,
      relyingParty: { origin: ORIGIN, rpName: 'Acme' },
      challengeSecret: 'a-challenge-secret-of-at-least-32-characters',
      tenantId: () => tenantId,
      limiter: { maxAttempts: 3, windowSeconds: 60, audit: false },
    });
  });

  afterEach(() => {
    if (existsSync(dbPath)) rmSync(dbPath, { force: true });
  });

  it('registers, signs in, sets an httpOnly session cookie, and never returns the session id', async () => {
    const authenticator = newAuthenticator();
    const registered = await registerPasskey(person, authenticator);
    expect(registered.status).toBe(200);
    expect(registered.headers.get('cache-control')).toBe('private, no-store');
    expect(((await read(registered)).passkey as { name: string }).name).toBe(
      'Laptop',
    );

    const { response, jar } = await signIn(authenticator);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = await read(response);
    expect(body).toMatchObject({
      authenticated: true,
      userId: person.id,
      tenantId,
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
    expect(context?.authMethod).toBe('passkey');
  });

  it('serves ceremony options as no-store JSON', async () => {
    const response = await handlers.authenticationOptions(makeEvent().event);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = await read(response);
    expect(typeof body.ceremonyId).toBe('string');
    expect(body.options).toMatchObject({
      rpId: RP_ID,
      userVerification: 'required',
    });
  });

  it('answers every refusal with the same 401 body and sets no cookie', async () => {
    const known = newAuthenticator();
    await registerPasskey(person, known);
    const bodies = new Set<string>();
    const cases: Array<[string, Parameters<typeof signIn>[1]]> = [
      ['unknown passkey', {}],
      ['no user verification', { assertion: { userVerified: false } }],
      ['wrong origin', { assertion: { origin: 'https://evil.example.com' } }],
      ['bad signature', { assertion: { badSignature: true } }],
    ];
    for (const [index, [label, extra]] of cases.entries()) {
      const { response, jar } = await signIn(
        label === 'unknown passkey' ? newAuthenticator() : known,
        { ...extra, address: `198.51.100.${index + 1}` },
      );
      expect(response.status, label).toBe(401);
      expect(response.headers.get('cache-control'), label).toBe(
        'private, no-store',
      );
      bodies.add(JSON.stringify(await read(response)));
      expect(jar.set, label).toEqual([]);
    }
    // Malformed bodies take the same path.
    for (const payload of ['nonsense', { ceremonyId: 1, response: 2 }, {}]) {
      const made = makeEvent({ body: payload, address: '198.51.100.99' });
      const response = await handlers.signIn(made.event);
      expect(response.status).toBe(401);
      bodies.add(JSON.stringify(await read(response)));
      expect(made.jar.set).toEqual([]);
    }
    expect([...bodies]).toEqual([
      JSON.stringify({
        error: 'Invalid credentials.',
        code: 'invalid_credentials',
      }),
    ]);
  });

  it('refuses an inactive person like any other bad credential', async () => {
    const authenticator = newAuthenticator();
    await registerPasskey(inactive, authenticator);
    inactive.status = 'suspended' as User['status'];
    await inactive.save();
    const { response, jar } = await signIn(authenticator);
    expect(response.status).toBe(401);
    expect(await read(response)).toMatchObject({ code: 'invalid_credentials' });
    expect(jar.set).toEqual([]);
  });

  it('returns 429 with Retry-After once the source budget is exhausted', async () => {
    for (let i = 0; i < 3; i++) {
      const { response } = await signIn(newAuthenticator(), {
        address: '192.0.2.200',
      });
      expect(response.status).toBe(401);
    }
    const { response, jar } = await signIn(newAuthenticator(), {
      address: '192.0.2.200',
    });
    expect(response.status).toBe(429);
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await read(response)).code).toBe('rate_limited');
    expect(jar.set).toEqual([]);
  });

  it('revokes the session cookie the browser held before signing in', async () => {
    const authenticator = newAuthenticator();
    await registerPasskey(person, authenticator);
    const stale = await sessionService.createSession(admin.id as string);
    const { response, jar } = await signIn(authenticator, {
      cookies: { sid: stale },
    });
    expect(response.status).toBe(200);
    expect(jar.values.get('sid')).not.toBe(stale);
    expect(await sessionService.loadSessionContext(stale)).toBeNull();
  });

  it('refuses management without a session, without authMethod in locals, and from a layered session', async () => {
    const none = makeEvent({ body: {} });
    for (const handler of [
      handlers.registrationOptions,
      handlers.register,
      handlers.rename,
      handlers.remove,
      handlers.removeAll,
    ]) {
      expect((await handler(none.event)).status).toBe(401);
    }
    expect(
      (await handlers.list(makeEvent({ method: 'GET' }).event)).status,
    ).toBe(401);

    const locals = await sessionLocals(person);
    const { authMethod: _drop, ...noChannel } = locals;
    expect(
      (
        await handlers.registrationOptions(
          makeEvent({ locals: noChannel }).event,
        )
      ).status,
    ).toBe(401);

    const device = await sessionService.createSession(
      admin.id as string,
      tenantId,
      { authMethod: 'terminal' },
    );
    const layeredId = await sessionService.createSession(
      person.id as string,
      tenantId,
      { authMethod: 'pin', parentSessionId: device },
    );
    const layered = await handlers.registrationOptions(
      makeEvent({ locals: await localsFor(layeredId) }).event,
    );
    expect(layered.status).toBe(403);
    expect(await read(layered)).toMatchObject({ code: 'forbidden' });
  });

  it('answers 401 reauthentication_required for a stale session', async () => {
    const id = await sessionService.createSession(
      person.id as string,
      tenantId,
      {
        authMethod: 'password',
      },
    );
    await sessions.db.query(
      `UPDATE ${sessions.tableName} SET created_at = ? WHERE id = ?`,
      new Date(Date.now() - 3600 * 1000).toISOString(),
      id,
    );
    const response = await handlers.registrationOptions(
      makeEvent({ locals: await localsFor(id) }).event,
    );
    expect(response.status).toBe(401);
    expect(await read(response)).toMatchObject({
      code: 'reauthentication_required',
    });
  });

  it('answers 400 passkey_registration with a displayable message', async () => {
    const locals = await sessionLocals(person);
    const begun = await read(
      await handlers.registrationOptions(makeEvent({ locals }).event),
    );
    const response = await handlers.register(
      makeEvent({
        locals,
        body: {
          ceremonyId: begun.ceremonyId,
          response: newAuthenticator().register(
            begun.options as Parameters<SoftAuthenticator['register']>[0],
            { userVerified: false },
          ),
        },
      }).event,
    );
    expect(response.status).toBe(400);
    expect(await read(response)).toMatchObject({
      code: 'passkey_registration',
      error: expect.stringContaining('could not be verified'),
    });
  });

  it("lists, renames and removes the signed-in person's passkeys", async () => {
    const authenticator = newAuthenticator();
    await registerPasskey(person, authenticator, 'Laptop');
    const locals = await sessionLocals(person);

    const listed = await read(
      await handlers.list(makeEvent({ method: 'GET', locals }).event),
    );
    const [first] = listed.passkeys as Array<{ id: string; name: string }>;
    expect(first?.name).toBe('Laptop');
    expect(JSON.stringify(listed)).not.toContain(authenticator.id);

    const renamed = await handlers.rename(
      makeEvent({
        method: 'PATCH',
        locals,
        body: { passkeyId: first?.id, name: 'Work' },
      }).event,
    );
    expect(renamed.status).toBe(200);
    expect(((await read(renamed)).passkey as { name: string }).name).toBe(
      'Work',
    );

    const removed = makeEvent({
      method: 'DELETE',
      locals,
      body: { passkeyId: first?.id },
    });
    const response = await handlers.remove(removed.event);
    expect(response.status).toBe(200);
    expect(await read(response)).toMatchObject({ revokedSessions: 0 });
    expect(removed.jar.deleted).toEqual([]);
    const after = await read(
      await handlers.list(makeEvent({ method: 'GET', locals }).event),
    );
    expect(after.passkeys).toEqual([]);
  });

  it('clears the cookie when a removal ends the current session', async () => {
    const authenticator = newAuthenticator();
    await registerPasskey(person, authenticator);
    const { jar: signedIn } = await signIn(authenticator);
    const sid = signedIn.values.get('sid') as string;
    const locals = await localsFor(sid);
    const [passkey] = (
      await read(
        await handlers.list(makeEvent({ method: 'GET', locals }).event),
      )
    ).passkeys as Array<{ id: string }>;
    const removed = makeEvent({
      locals,
      cookies: { sid },
      body: { passkeyId: passkey?.id },
    });
    const response = await handlers.remove(removed.event);
    expect(response.status).toBe(200);
    expect(await read(response)).toMatchObject({ signedOut: true });
    expect(removed.jar.deleted).toEqual(['sid']);
    expect(await sessionService.loadSessionContext(sid)).toBeNull();
  });

  it('lets an administrator list another person and remove all of their passkeys', async () => {
    await registerPasskey(person, newAuthenticator(), 'Laptop');
    await registerPasskey(person, newAuthenticator(), 'Phone');
    const adminLocals = await sessionLocals(admin, {
      permissions: [DEFAULT_PASSKEY_MANAGE_PERMISSION],
    });
    const listed = await read(
      await handlers.list(
        makeEvent({
          method: 'GET',
          locals: adminLocals,
          search: `?userId=${person.id}`,
        }).event,
      ),
    );
    expect((listed.passkeys as unknown[]).length).toBe(2);

    // Without the permission it is forbidden.
    const plain = await sessionLocals(admin);
    const forbidden = await handlers.list(
      makeEvent({
        method: 'GET',
        locals: plain,
        search: `?userId=${person.id}`,
      }).event,
    );
    expect(forbidden.status).toBe(403);

    const cleared = await handlers.removeAll(
      makeEvent({ locals: adminLocals, body: { userId: person.id } }).event,
    );
    expect(cleared.status).toBe(200);
    expect(await read(cleared)).toMatchObject({ removed: 2 });
    const selfRemoval = await handlers.removeAll(
      makeEvent({ locals: adminLocals, body: { userId: admin.id } }).event,
    );
    expect(selfRemoval.status).toBe(403);
  });

  it('exposes the lazily created service', async () => {
    const service = await handlers.service();
    expect(service).toBe(await handlers.service());
    expect(await service.hasPasskeys(person.id as string)).toBe(false);
  });
});
