import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type ResolvedApplicationRuntime,
  resolveApplicationRuntime,
} from '@happyvertical/smrt-config';
import {
  disableTenancy,
  getCurrentTenant,
  withSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import {
  DEFAULT_ROLE_SLUGS,
  PasswordCredentialService,
  RoleCollection,
  TenantCollection,
  TenantStatus,
  UserCollection,
} from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import { type Handle, isActionFailure, isRedirect } from '@sveltejs/kit';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  LocalRuntimeError,
  MIGRATION_FAILED_MESSAGE,
  ONBOARDING_HANDOFF_FILES,
  projectRuntimeDiagnostics,
  readActiveWriterLease,
  readOriginFile,
  resolveApplicationId,
  resolveApplicationStateRoot,
  runtimeConfigurationFingerprint,
} from './index.js';
import {
  composeSmrtSvelteKitRuntime,
  type SmrtSvelteKitRuntime,
  type SmrtSvelteKitRuntimeOptions,
} from './sveltekit/runtime.js';
import {
  authorizedTenantLocalsHandle,
  composeHandles,
  createOwnerLinkHandler,
  createOwnerSetupPage,
  createRuntimeDiagnosticsHandler,
  createRuntimeHealthHandler,
  createSessionLayoutLoad,
  createSignOutHandler,
  createSmrtSvelteKitRuntime,
  createSubdomainTenantSelector,
  DEFAULT_OWNER_SETUP_MESSAGES,
  isLoopbackAddress,
  isLoopbackHostname,
  OWNER_LINK_ROUTE,
  OWNER_LINK_SECRET_ENV,
  RUNTIME_DIAGNOSTICS_READ_PERMISSION,
  selectTenantSlug,
} from './sveltekit.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const temporaryRoots: string[] = [];
const initializationLockPaths = new Set<string>();
const openRuntimes: SmrtSvelteKitRuntime[] = [];
const openApplicationDatabases = new Set<DatabaseInterface>();

afterEach(async () => {
  for (const runtime of openRuntimes.splice(0)) {
    let local: Awaited<ReturnType<SmrtSvelteKitRuntime['localRuntime']>>;
    try {
      local = await runtime.localRuntime();
    } catch {
      // Runtime never started.
      continue;
    }
    // Public collections share the cached application connection with the
    // runtime's membership, permission and session services.
    const users = await UserCollection.create(runtime.classOptions('User'));
    openApplicationDatabases.add(users.db);
    await local.db.close?.();
  }
  for (const db of openApplicationDatabases) await db.close?.();
  openApplicationDatabases.clear();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
  for (const lockPath of initializationLockPaths) {
    for (const suffix of ['', '-journal', '-shm', '-wal']) {
      await rm(`${lockPath}${suffix}`, { force: true });
    }
    try {
      await rmdir(dirname(lockPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  initializationLockPaths.clear();
});

// Local runtimes take the state-root writer lease by default (#3416). Keep
// every platform's state root inside a test-owned directory instead of the
// user's real state directory.
let stateHome = '';
beforeAll(async () => {
  stateHome = await realpath(await mkdtemp(join(tmpdir(), 'smrt-sk-state-')));
  vi.stubEnv('XDG_STATE_HOME', stateHome);
  vi.stubEnv('HOME', stateHome);
  vi.stubEnv('LOCALAPPDATA', stateHome);
});

afterAll(async () => {
  disableTenancy();
  vi.unstubAllEnvs();
  await rm(stateHome, { recursive: true, force: true });
});

async function localDirectories(label: string) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), `smrt-sk-${label}-`));
  const root = await realpath(temporaryRoot);
  temporaryRoots.push(root);
  const sourceRoot = join(root, 'source');
  const dataDirectory = join(root, 'data');
  await mkdir(sourceRoot);
  await writeFile(
    join(sourceRoot, 'package.json'),
    JSON.stringify({ name: `@acme/${label}` }),
  );
  const currentUid = process.getuid?.();
  if (currentUid === undefined) throw new Error('Tests require a numeric uid.');
  const lockIdentity =
    platform() === 'darwin' || platform() === 'win32'
      ? dataDirectory.toLowerCase()
      : dataDirectory;
  const lockKey = createHash('sha256')
    .update(lockIdentity)
    .digest('hex')
    .slice(0, 32);
  initializationLockPaths.add(
    join(
      await realpath('/tmp'),
      `.smrt-${currentUid}`,
      lockKey,
      'initialization.sqlite',
    ),
  );
  return { sourceRoot, dataDirectory };
}

const LOCAL = resolveApplicationRuntime({ profile: 'local' });

async function localRuntime(
  label: string,
  options: Partial<SmrtSvelteKitRuntimeOptions> = {},
) {
  const directories = await localDirectories(label);
  const runtime = createSmrtSvelteKitRuntime({
    ...directories,
    runtime: LOCAL,
    env: { NODE_ENV: 'development', TENANT_BASE_DOMAIN: 'example.test' },
    ...options,
  });
  openRuntimes.push(runtime);
  return { runtime, ...directories };
}

interface TestEventOptions {
  sid?: string;
  headers?: Record<string, string>;
  clientAddress?: string | (() => string);
  form?: Record<string, string>;
}

function testEvent(url: string, options: TestEventOptions = {}) {
  const jar = new Map<string, string>();
  if (options.sid) jar.set('sid', options.sid);
  const setCookies: Array<{
    name: string;
    value: string;
    options: Record<string, unknown>;
  }> = [];
  let body: FormData | undefined;
  if (options.form) {
    body = new FormData();
    for (const [key, value] of Object.entries(options.form)) {
      body.set(key, value);
    }
  }
  const clientAddress = options.clientAddress ?? '127.0.0.1';
  return {
    url: new URL(url),
    request: new Request(url, {
      method: body ? 'POST' : 'GET',
      headers: options.headers,
      body,
    }),
    cookies: {
      get: (name: string) => jar.get(name),
      getAll: () =>
        [...jar.entries()].map(([name, value]) => ({ name, value })),
      set: (name: string, value: string, cookieOptions: object) => {
        jar.set(name, value);
        setCookies.push({
          name,
          value,
          options: cookieOptions as Record<string, unknown>,
        });
      },
      delete: (name: string) => {
        jar.delete(name);
      },
      serialize: () => '',
    },
    locals: {} as Record<string, unknown>,
    getClientAddress:
      typeof clientAddress === 'function' ? clientAddress : () => clientAddress,
    setCookies,
  };
}

type TestEvent = ReturnType<typeof testEvent>;

interface Observation {
  activeTenantId: string | undefined;
  locals: Record<string, unknown>;
}

async function runHandle(
  handle: Handle,
  event: TestEvent,
): Promise<Observation> {
  let observation: Observation | undefined;
  const response = await handle({
    event: event as unknown as Parameters<Handle>[0]['event'],
    resolve: async (resolved) => {
      observation = {
        activeTenantId: getCurrentTenant()?.tenantId,
        locals: { ...(resolved.locals as Record<string, unknown>) },
      };
      return new Response('ok');
    },
  });
  expect(response.status).toBe(200);
  if (!observation) throw new Error('resolve was not called');
  return observation;
}

async function runAction(
  page: ReturnType<typeof createOwnerSetupPage>,
  event: TestEvent,
) {
  try {
    const result = await page.actions.default(event);
    expect(isActionFailure(result)).toBe(true);
    return { failure: result as { status: number; data: unknown } };
  } catch (error) {
    if (isRedirect(error)) return { redirect: error };
    throw error;
  }
}

async function tableNames(db: DatabaseInterface): Promise<string[]> {
  const result = await db.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  );
  return result.rows.map((row) => String((row as { name: unknown }).name));
}

async function ownerCount(db: DatabaseInterface): Promise<number> {
  const result = await db.query(
    `SELECT COUNT(*) AS count FROM memberships
     JOIN roles ON roles.id = memberships.role_id
     WHERE roles.slug = 'owner'`,
  );
  return Number((result.rows[0] as { count: unknown }).count);
}

async function bootstrapToken(runtime: SmrtSvelteKitRuntime): Promise<string> {
  const local = await runtime.localRuntime();
  return (await local.rotateBootstrapInvitation()).token;
}

const SETUP_URL = 'http://127.0.0.1:5173/setup';

// ---------------------------------------------------------------------------
// Pure units
// ---------------------------------------------------------------------------

describe('tenant URL selection', () => {
  it('selects only the leading label under an explicit base domain', () => {
    expect(
      selectTenantSlug(new URL('https://acme.example.co.uk/'), 'example.co.uk'),
    ).toBe('acme');
    expect(
      selectTenantSlug(new URL('https://acme.attacker.test/'), 'example.com'),
    ).toBeNull();
  });

  it('rejects apex, reserved, localhost, IPv4, and IPv6 hosts', () => {
    for (const url of [
      'https://example.com/',
      'https://www.example.com/',
      'https://admin.example.com/',
      'http://localhost:5173/',
      'http://127.0.0.1:5173/',
      'http://[::1]:5173/',
    ]) {
      expect(selectTenantSlug(new URL(url), 'example.com')).toBeNull();
    }
    expect(selectTenantSlug(new URL('http://acme.demo.local/'), '')).toBe(
      'acme',
    );
  });

  it('ignores an untrusted tenant header and never touches the database for it', async () => {
    const classOptions = vi.fn(() => {
      throw new Error('must not look up a tenant');
    });
    const select = createSubdomainTenantSelector({
      baseDomain: 'example.test',
      classOptions,
    });
    const event = testEvent('http://localhost:5173/', {
      headers: { 'x-tenant-id': 'attacker', 'x-tenant-slug': 'attacker' },
    });
    await expect(select(event)).resolves.toEqual({
      tenantId: null,
      tenantSlug: null,
    });
    expect(classOptions).not.toHaveBeenCalled();
  });
});

describe('loopback custody helpers', () => {
  it('accepts only loopback literals and loopback host names', () => {
    for (const value of [
      '127.0.0.1',
      '127.8.9.10',
      '::1',
      '[::1]',
      '::ffff:127.0.0.1',
    ]) {
      expect(isLoopbackAddress(value)).toBe(true);
    }
    for (const value of [
      '10.0.0.1',
      '192.168.1.5',
      '::ffff:10.0.0.1',
      '0.0.0.0',
      '128.0.0.1',
      '127.0.0.256',
      'localhost',
      '',
      undefined,
    ]) {
      expect(isLoopbackAddress(value)).toBe(false);
    }
    expect(isLoopbackHostname('localhost')).toBe(true);
    expect(isLoopbackHostname('[::1]')).toBe(true);
    expect(isLoopbackHostname('127.0.0.1')).toBe(true);
    expect(isLoopbackHostname('localhost.attacker.test')).toBe(false);
    expect(isLoopbackHostname('app.example.test')).toBe(false);
  });
});

describe('request ordering units', () => {
  it('runs composed handles in order and forwards the final event', async () => {
    const calls: string[] = [];
    const step =
      (name: string): Handle =>
      ({ event, resolve }) => {
        calls.push(name);
        return resolve(event);
      };
    const handle = composeHandles(step('a'), step('b'), step('c'));
    await runHandle(handle, testEvent('http://localhost/'));
    expect(calls).toEqual(['a', 'b', 'c']);
  });

  it('never publishes tenantContext for locals the runtime session step did not verify', async () => {
    // The verified (positive) path is covered end to end by the local
    // runtime tests; locals populated by any other session layer, even when
    // they match the active context, are never published.
    const cases: Array<{
      label: string;
      locals: Record<string, unknown>;
      active: string | null;
    }> = [
      {
        label: 'unverified matching session',
        locals: { user: { id: 'u1' }, tenantId: 't1' },
        active: 't1',
      },
      {
        label: 'active context for another tenant',
        locals: { user: { id: 'u1' }, tenantId: 't1' },
        active: 't2',
      },
      {
        label: 'no user',
        locals: { user: null, tenantId: 't1' },
        active: 't1',
      },
      {
        label: 'no session tenant',
        locals: { user: { id: 'u1' }, tenantId: null },
        active: 't1',
      },
      {
        label: 'no active context',
        locals: { user: { id: 'u1' }, tenantId: 't1' },
        active: null,
      },
    ];
    for (const testCase of cases) {
      const event = testEvent('http://localhost/');
      Object.assign(event.locals, testCase.locals);
      const run = () => runHandle(authorizedTenantLocalsHandle, event);
      const observed = testCase.active
        ? await withTenant({ tenantId: testCase.active }, run)
        : await run();
      expect(observed.locals.tenantContext, testCase.label).toBeUndefined();
    }
  });
});

describe('application identity', () => {
  it('matches the template fingerprint and ID vectors byte for byte', () => {
    const runtime = {
      profile: 'local',
      providers: {
        database: { provider: 'sqlite' },
        jobs: { topology: 'embedded' },
      },
    } as unknown as ResolvedApplicationRuntime;
    // Golden values computed with
    // packages/template-sveltekit/template/scripts/smrt-runtime-identity.mjs.
    expect(
      runtimeConfigurationFingerprint(runtime, {
        DATABASE_URL:
          'postgres://user:secret@db.example:5432/app?sslmode=require&password=x#frag',
        HOST: '127.0.0.1',
        PORT: '5173',
        ORIGIN: 'http://127.0.0.1:5173/',
        SMRT_BACKGROUND_JOBS: 'true',
        SMRT_MCP_SCOPES: 'read',
      }),
    ).toBe('1082a7948f012507750cd6811e66a314cc88c5071d1ee2401fd544e3768aa4ba');
    expect(runtimeConfigurationFingerprint(runtime, {})).toBe(
      '2823bad362649569b8ef2bf2f8a66e349e510875fe7a0c2fc5831c995bf4a987',
    );
    expect(resolveApplicationId({ packageName: '@acme/My App' })).toBe(
      'acme-my-app-1e1f533d66',
    );
  });

  it('excludes database credentials and validates explicit IDs', () => {
    const runtime = LOCAL;
    const withSecret = runtimeConfigurationFingerprint(runtime, {
      DATABASE_URL: 'postgres://user:hunter2@db.example/app',
    });
    const withOtherSecret = runtimeConfigurationFingerprint(runtime, {
      DATABASE_URL: 'postgres://other:swordfish@db.example/app',
    });
    expect(withSecret).toBe(withOtherSecret);
    expect(withSecret).not.toContain('hunter2');
    expect(resolveApplicationId({ explicitId: 'My-App' })).toBe('my-app');
    expect(() => resolveApplicationId({ explicitId: 'bad id!' })).toThrow(
      LocalRuntimeError,
    );
    expect(() => resolveApplicationId({ packageName: '  ' })).toThrow(
      /non-empty package name/,
    );
  });
});

// ---------------------------------------------------------------------------
// Local profile integration (real runtime, real SQLite)
// ---------------------------------------------------------------------------

describe('local SvelteKit runtime', () => {
  it('retains secure SQLite custody in public options while honoring class overrides', async () => {
    const override = { type: 'sqlite' as const, url: ':memory:' };
    const { runtime } = await localRuntime('secure-options', {
      classOverrides: { Membership: { db: override } },
    });
    await runtime.init();
    const local = await runtime.localRuntime();
    const expected = {
      type: 'sqlite',
      url: local.paths.database,
      secureFile: {
        driver: 'node:sqlite',
        custody: 'trusted-parent',
        root: local.paths.root,
      },
    };
    expect(runtime.databaseConfig()).toEqual(expected);
    expect(runtime.classOptions('User').db).toEqual(expected);
    expect(runtime.classOptions('Membership').db).toBe(override);
    const users = await UserCollection.create(runtime.classOptions('User'));
    expect(await applicationDb(runtime)).toBe(users.db);
    // The shared handle for services that take a DatabaseInterface.
    expect(await runtime.database()).toBe(local.db);
  });

  it('keeps owner bootstrap loopback-only, single-use, and HMAC-only end to end', async () => {
    const onOwnerClaimed = vi.fn(() => {
      throw new Error('cleanup failure must not surface');
    });
    const passwordPolicy = { pepper: 'test-only-sveltekit-pepper' };
    const { runtime } = await localRuntime('bootstrap', { passwordPolicy });
    await runtime.init();
    const page = createOwnerSetupPage(runtime, {
      onOwnerClaimed,
      requirePassword: true,
    });
    const local = await runtime.localRuntime();
    const token = await bootstrapToken(runtime);

    // load: loopback shows the form and echoes the URL token.
    await expect(
      page.load(testEvent(`${SETUP_URL}?token=${token}`)),
    ).resolves.toEqual({ available: true, token, link: 'ready' });
    // load: a remote peer, a non-loopback host, or a throwing address lookup
    // never sees the form or the token.
    for (const event of [
      testEvent(`${SETUP_URL}?token=${token}`, { clientAddress: '10.1.2.3' }),
      testEvent(`http://setup.attacker.test/setup?token=${token}`),
      testEvent(`${SETUP_URL}?token=${token}`, {
        clientAddress: () => {
          throw new Error('no address');
        },
      }),
    ]) {
      await expect(page.load(event)).resolves.toEqual({
        available: false,
        token: '',
        link: 'unavailable',
      });
    }

    const validForm = {
      token,
      name: 'Will Owner',
      email: 'will@example.com',
      password: 'correct horse battery staple',
    };
    // action: non-loopback attempts are refused before any claim.
    const claimSpy = vi.spyOn(local, 'claimOwner');
    for (const event of [
      testEvent(SETUP_URL, { form: validForm, clientAddress: '203.0.113.9' }),
      testEvent(SETUP_URL, {
        form: validForm,
        clientAddress: '::ffff:192.168.0.2',
      }),
      testEvent('http://rebind.attacker.test/setup', { form: validForm }),
    ]) {
      const { failure } = await runAction(page, event);
      expect(failure).toMatchObject({
        status: 403,
        data: {
          code: 'setup_unavailable',
          message: DEFAULT_OWNER_SETUP_MESSAGES.setup_unavailable,
        },
      });
      expect(event.setCookies).toEqual([]);
    }
    expect(claimSpy).not.toHaveBeenCalled();
    expect((await local.diagnostics()).bootstrap.status).toBe('available');

    // action: malformed input.
    for (const form of [
      { name: 'Will', email: 'will@example.com' },
      { token, name: '   ', email: 'will@example.com' },
      { token, name: 'Will', email: 'not-an-email' },
      { token, name: 'Will', email: 'will@example.com' },
    ]) {
      const { failure } = await runAction(page, testEvent(SETUP_URL, { form }));
      expect(failure).toMatchObject({
        status: 400,
        data: { code: 'setup_invalid_input' },
      });
    }

    // action: a wrong token fails with fixed text only.
    const wrong = await runAction(
      page,
      testEvent(SETUP_URL, { form: { ...validForm, token: `${token}x` } }),
    );
    expect(wrong.failure).toEqual(
      expect.objectContaining({
        status: 400,
        data: {
          code: 'setup_invalid',
          message: DEFAULT_OWNER_SETUP_MESSAGES.setup_invalid,
        },
      }),
    );
    expect(await ownerCount(local.db)).toBe(0);

    // action: valid loopback claim sets the session cookie and redirects.
    const claimEvent = testEvent(SETUP_URL, {
      form: validForm,
      clientAddress: '::1',
      headers: { 'user-agent': 'vitest' },
    });
    const claimed = await runAction(page, claimEvent);
    expect(claimed.redirect).toMatchObject({ status: 303, location: '/' });
    expect(claimEvent.setCookies).toHaveLength(1);
    expect(claimEvent.setCookies[0]).toMatchObject({
      name: 'sid',
      options: {
        path: '/',
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60,
      },
    });
    const passwords = await PasswordCredentialService.create({
      db: local.db,
      password: passwordPolicy,
    });
    await expect(
      passwords.signIn({
        identifier: validForm.email,
        password: validForm.password,
        tenantId: 'unique-active-membership',
      }),
    ).resolves.toMatchObject({ authMethod: 'password' });
    expect(onOwnerClaimed).toHaveBeenCalledOnce();
    expect(await ownerCount(local.db)).toBe(1);

    // Only an HMAC of the token is stored.
    const rows = await local.db.query(
      'SELECT * FROM _smrt_local_owner_bootstrap',
    );
    expect(rows.rows).toHaveLength(1);
    const serializedRows = JSON.stringify(rows.rows);
    expect(serializedRows).not.toContain(token);
    expect(
      String((rows.rows[0] as { token_hash: unknown }).token_hash),
    ).toMatch(/^[0-9a-f]{64}$/);

    // Replay of the consumed token fails and creates no second owner.
    const replay = await runAction(
      page,
      testEvent(SETUP_URL, { form: validForm }),
    );
    expect(replay.failure).toMatchObject({
      status: 400,
      data: { code: 'setup_invalid' },
    });
    expect(await ownerCount(local.db)).toBe(1);

    // After the claim: load reports unavailable and a signed-in user is redirected.
    await expect(
      page.load(testEvent(`${SETUP_URL}?token=${token}`)),
    ).resolves.toEqual({
      available: false,
      token: '',
      link: 'unavailable',
    });
    const signedIn = testEvent(SETUP_URL);
    signedIn.locals.user = { id: 'someone' };
    await expect(page.load(signedIn)).rejects.toSatisfy(isRedirect);
  });

  describe('session layout user and sign-out', () => {
    it('exposes only id, email and name of the user', () => {
      const load = createSessionLayoutLoad();
      expect(
        load({
          locals: {
            user: { id: 'u1', email: 'a@b.test', name: 'A', token: 'secret' },
          },
        }).session.user,
      ).toEqual({ id: 'u1', email: 'a@b.test', name: 'A' });
      expect(
        load({ locals: { user: { id: 'u1', email: 'a@b.test' } } }).session
          .user,
      ).toEqual({ id: 'u1', email: 'a@b.test' });
      expect(load({ locals: { user: null } }).session.user).toBeNull();
      expect(load({ locals: { user: { id: 'u1' } } }).session.user).toBeNull();
    });

    async function signedInRuntime(label: string) {
      const { runtime } = await localRuntime(label);
      await runtime.init();
      const page = createOwnerSetupPage(runtime);
      const claimEvent = testEvent(SETUP_URL, {
        form: {
          token: await bootstrapToken(runtime),
          name: 'Owner',
          email: 'owner@example.com',
        },
      });
      await runAction(page, claimEvent);
      return { runtime, sid: claimEvent.setCookies[0]?.value as string };
    }

    function signOutEvent(
      sid: string | undefined,
      method: string,
      headers: Record<string, string>,
    ) {
      const url = 'http://127.0.0.1:5173/sign-out';
      const event = testEvent(url, sid ? { sid } : {});
      event.request = new Request(url, { method, headers });
      const deleted: string[] = [];
      const remove = event.cookies.delete;
      event.cookies.delete = (name: string, ...rest: unknown[]) => {
        deleted.push(name);
        return (remove as (...a: unknown[]) => void)(name, ...rest);
      };
      return { event, deleted };
    }

    it('destroys the session and clears the cookie on a same-origin POST', async () => {
      const { runtime, sid } = await signedInRuntime('sign-out-ok');
      const handler = createSignOutHandler(runtime);
      const before = await runHandle(
        runtime.handle,
        testEvent('http://127.0.0.1:5173/', { sid }),
      );
      expect(before.locals.user).not.toBeNull();
      expect(before.locals.authMethod).toBe('local-bootstrap');
      expect(before.locals.sessionParent).toBeNull();

      const { event, deleted } = signOutEvent(sid, 'POST', {
        origin: 'http://127.0.0.1:5173',
      });
      const response = await handler(event as never);
      expect(response.status).toBe(204);
      expect(deleted).toEqual(['sid']);
      const after = await runHandle(
        runtime.handle,
        testEvent('http://127.0.0.1:5173/', { sid }),
      );
      expect(after.locals.user).toBeNull();
      expect(after.locals.authMethod).toBeNull();
      expect(after.locals.sessionParent).toBeNull();

      // Already-gone session row: the cookie is still cleared.
      const again = signOutEvent(sid, 'POST', {
        'sec-fetch-site': 'same-origin',
      });
      expect((await handler(again.event as never)).status).toBe(204);
      expect(again.deleted).toEqual(['sid']);
    });

    it('answers a no-JS form post with a 303 to /', async () => {
      const { runtime, sid } = await signedInRuntime('sign-out-form');
      const { event } = signOutEvent(sid, 'POST', {
        origin: 'http://127.0.0.1:5173',
        accept: 'text/html',
      });
      await expect(
        createSignOutHandler(runtime)(event as never),
      ).rejects.toSatisfy(isRedirect);
    });

    it('rejects non-POST with 405 and cross-origin with 403 without touching the session', async () => {
      const { runtime, sid } = await signedInRuntime('sign-out-reject');
      const handler = createSignOutHandler(runtime);
      const get = signOutEvent(sid, 'GET', {
        origin: 'http://127.0.0.1:5173',
      });
      const getResponse = await handler(get.event as never);
      expect(getResponse.status).toBe(405);
      expect(getResponse.headers.get('allow')).toBe('POST');
      for (const headers of [
        { origin: 'http://evil.test' },
        { 'sec-fetch-site': 'cross-site' },
        { 'sec-fetch-site': 'same-site' },
        {},
      ]) {
        const { event, deleted } = signOutEvent(sid, 'POST', headers);
        expect((await handler(event as never)).status).toBe(403);
        expect(deleted).toEqual([]);
      }
      const still = await runHandle(
        runtime.handle,
        testEvent('http://127.0.0.1:5173/', { sid }),
      );
      expect(still.locals.user).not.toBeNull();
    });
  });

  describe('onboarding hand-off files', () => {
    async function seedHandoff(runtime: { applicationStateRoot(): string }) {
      const stateRoot = runtime.applicationStateRoot();
      await mkdir(stateRoot, { recursive: true, mode: 0o700 });
      const files = ONBOARDING_HANDOFF_FILES.map((name) =>
        join(stateRoot, name),
      );
      for (const file of files) await writeFile(file, 'spent', { mode: 0o600 });
      return files;
    }
    const present = (files: string[]) => files.map((file) => existsSync(file));

    it('removes them after a successful claim, before the optional hook', async () => {
      const seen: boolean[][] = [];
      let files: string[] = [];
      const { runtime } = await localRuntime('handoff-ok');
      await runtime.init();
      files = await seedHandoff(runtime);
      const onOwnerClaimed = vi.fn(() => {
        seen.push(present(files));
      });
      const page = createOwnerSetupPage(runtime, {
        onOwnerClaimed,
      });
      const token = await bootstrapToken(runtime);
      const { redirect } = await runAction(
        page,
        testEvent(SETUP_URL, {
          form: { token, name: 'Owner', email: 'owner@example.com' },
        }),
      );
      expect(redirect).toMatchObject({ status: 303 });
      expect(present(files)).toEqual([false, false]);
      // The hook still runs for apps with extra cleanup.
      expect(onOwnerClaimed).toHaveBeenCalledOnce();
      expect(seen).toEqual([[false, false]]);
    });

    it('leaves them untouched when the claim fails', async () => {
      const { runtime } = await localRuntime('handoff-fail');
      await runtime.init();
      const files = await seedHandoff(runtime);
      const page = createOwnerSetupPage(runtime);
      const token = await bootstrapToken(runtime);
      for (const form of [
        { token: `${token}x`, name: 'Owner', email: 'owner@example.com' },
        { token, name: '', email: 'owner@example.com' },
      ]) {
        await runAction(page, testEvent(SETUP_URL, { form }));
      }
      await runAction(
        page,
        testEvent(SETUP_URL, {
          form: { token, name: 'Owner', email: 'owner@example.com' },
          clientAddress: '203.0.113.9',
        }),
      );
      expect(present(files)).toEqual([true, true]);
    });

    it('can be kept with removeOnboardingHandoff: false', async () => {
      const { runtime } = await localRuntime('handoff-keep');
      await runtime.init();
      const files = await seedHandoff(runtime);
      const page = createOwnerSetupPage(runtime, {
        removeOnboardingHandoff: false,
      });
      const token = await bootstrapToken(runtime);
      await runAction(
        page,
        testEvent(SETUP_URL, {
          form: { token, name: 'Owner', email: 'owner@example.com' },
        }),
      );
      expect(present(files)).toEqual([true, true]);
    });

    it('removes them even when setting the session cookie throws', async () => {
      const { runtime } = await localRuntime('handoff-cookie');
      await runtime.init();
      const files = await seedHandoff(runtime);
      const page = createOwnerSetupPage(runtime);
      const token = await bootstrapToken(runtime);
      const event = testEvent(SETUP_URL, {
        form: { token, name: 'Owner', email: 'owner@example.com' },
      });
      event.cookies.set = () => {
        throw new Error('bad cookie');
      };
      await expect(page.actions.default(event as never)).rejects.toThrow(
        'bad cookie',
      );
      expect(present(files)).toEqual([false, false]);
    });

    it('does not fail the claim when the state root cannot be cleaned', async () => {
      const { runtime } = await localRuntime('handoff-error');
      await runtime.init();
      const page = createOwnerSetupPage({
        resolvedRuntime: () => runtime.resolvedRuntime(),
        localRuntime: () => runtime.localRuntime(),
        sessionCookie: runtime.sessionCookie,
        applicationStateRoot: () => {
          throw new Error('boom');
        },
      });
      const token = await bootstrapToken(runtime);
      const { redirect } = await runAction(
        page,
        testEvent(SETUP_URL, {
          form: { token, name: 'Owner', email: 'owner@example.com' },
        }),
      );
      expect(redirect).toMatchObject({ status: 303 });
    });
  });

  it('reports a missing setup token from load without echoing anything', async () => {
    const { runtime } = await localRuntime('missing-token');
    await runtime.init();
    const page = createOwnerSetupPage(runtime);
    await expect(page.load(testEvent(SETUP_URL))).resolves.toEqual({
      available: true,
      token: '',
      link: 'missing',
    });
  });

  it('rejects an expired bootstrap token', async () => {
    let now = new Date('2026-10-02T12:00:00.000Z');
    const { runtime } = await localRuntime('expired', {
      now: () => now,
      bootstrapTtlSeconds: 60,
    });
    await runtime.init();
    const page = createOwnerSetupPage(runtime);
    const token = await bootstrapToken(runtime);
    now = new Date(now.getTime() + 61_000);
    // load reports the lapsed link instead of echoing the dead token.
    await expect(
      page.load(testEvent(`${SETUP_URL}?token=${token}`)),
    ).resolves.toEqual({ available: true, token: '', link: 'expired' });
    const { failure } = await runAction(
      page,
      testEvent(SETUP_URL, {
        form: { token, name: 'Late', email: 'late@example.com' },
      }),
    );
    expect(failure).toMatchObject({
      status: 400,
      data: { code: 'setup_invalid' },
    });
    expect(JSON.stringify(failure)).not.toMatch(/expired_at|bootstrap_/);
    const local = await runtime.localRuntime();
    expect(await ownerCount(local.db)).toBe(0);
  });

  it('reports an owner tenant slug conflict as setup_conflict', async () => {
    const { runtime } = await localRuntime('conflict');
    await runtime.init();
    const page = createOwnerSetupPage(runtime);
    const local = await runtime.localRuntime();
    const token = await bootstrapToken(runtime);
    vi.spyOn(local, 'claimOwner').mockRejectedValueOnce(
      new LocalRuntimeError('owner_tenant_conflict', 'slug taken'),
    );
    const { failure } = await runAction(
      page,
      testEvent(SETUP_URL, {
        form: { token, name: 'Owner', email: 'owner@example.com' },
      }),
    );
    expect(failure).toMatchObject({
      status: 409,
      data: {
        code: 'setup_conflict',
        message: DEFAULT_OWNER_SETUP_MESSAGES.setup_conflict,
      },
    });
  });

  it('separates URL/header selection from the session-authorized tenant context', async () => {
    const { runtime } = await localRuntime('ordering');
    await runtime.init();
    const local = await runtime.localRuntime();
    const page = createOwnerSetupPage(runtime);
    const token = await bootstrapToken(runtime);
    const claimEvent = testEvent(SETUP_URL, {
      form: { token, name: 'Owner', email: 'owner@example.com' },
    });
    await runAction(page, claimEvent);
    const sid = claimEvent.setCookies[0]?.value as string;
    expect(sid).toBeTruthy();
    const ownerTenantId = String(
      (
        (await local.db.query("SELECT id FROM tenants WHERE slug = 'default'"))
          .rows[0] as { id: unknown }
      ).id,
    );
    const otherTenantId = await withSystemContext(async () => {
      const tenants = await TenantCollection.create({ db: local.db });
      const tenant = await tenants.create({
        name: 'Other',
        slug: 'other',
        status: TenantStatus.ACTIVE,
      });
      await tenant.save();
      return tenant.id as string;
    });
    const tablesBefore = await tableNames(local.db);

    // No session + spoofed hostname and header: selection only, no context.
    const anonymous = await runHandle(
      runtime.handle,
      testEvent('http://other.example.test/', {
        headers: { 'x-tenant-id': ownerTenantId },
      }),
    );
    expect(anonymous.locals).toMatchObject({
      selectedTenantId: otherTenantId,
      selectedTenantSlug: 'other',
      user: null,
      tenantId: null,
      sessionId: null,
    });
    expect(anonymous.activeTenantId).toBeUndefined();
    expect(anonymous.locals.tenantContext).toBeUndefined();

    // Forged session cookie: no identity, no context.
    const forged = await runHandle(
      runtime.handle,
      testEvent('http://other.example.test/', {
        sid: '00000000-0000-4000-8000-000000000000',
      }),
    );
    expect(forged.locals.user).toBeNull();
    expect(forged.activeTenantId).toBeUndefined();
    expect(forged.locals.tenantContext).toBeUndefined();

    // Owner session for the default tenant while the URL selects another
    // tenant: the session tenant wins; the selection stays informational.
    const crossTenant = await runHandle(
      runtime.handle,
      testEvent('http://other.example.test/', {
        sid,
        headers: { 'x-tenant-id': otherTenantId },
      }),
    );
    expect(crossTenant.locals.selectedTenantId).toBe(otherTenantId);
    expect(crossTenant.locals.tenantId).toBe(ownerTenantId);
    expect(crossTenant.activeTenantId).toBe(ownerTenantId);
    expect(
      (crossTenant.locals.tenantContext as { tenantId: string }).tenantId,
    ).toBe(ownerTenantId);

    // Owner session on a loopback host: no selection, authorized context.
    const owner = await runHandle(
      runtime.handle,
      testEvent('http://127.0.0.1:5173/', { sid }),
    );
    expect(owner.locals.selectedTenantId).toBeNull();
    expect(owner.activeTenantId).toBe(ownerTenantId);
    expect((owner.locals.tenantContext as { tenantId: string }).tenantId).toBe(
      ownerTenantId,
    );

    // A session re-pointed at a tenant the user has no membership in never
    // publishes that tenant as context.
    await local.db.query(
      'UPDATE sessions SET tenant_id = ? WHERE id = ?',
      otherTenantId,
      sid,
    );
    const requestDb = await applicationDb(runtime);
    expect(requestDb).not.toBe(local.db);
    expect(
      (
        await requestDb.query(
          'SELECT tenant_id FROM sessions WHERE id = ?',
          sid,
        )
      ).rows[0],
    ).toEqual({ tenant_id: otherTenantId });
    const unauthorized = await runHandle(
      runtime.handle,
      testEvent('http://other.example.test/', { sid }),
    );
    const sessionRow = await local.db.query(
      'SELECT tenant_id FROM sessions WHERE id = ?',
      sid,
    );
    expect(sessionRow.rows[0]).toEqual({ tenant_id: otherTenantId });
    // The request connection sees the changed session tenant. A session for a
    // membership-less tenant is unauthenticated; it cannot retain old authority.
    const published = {
      tenantId: unauthorized.locals.tenantId,
      membershipTenant: (
        unauthorized.locals.membership as { tenantId?: string } | null
      )?.tenantId,
      context: (
        unauthorized.locals.tenantContext as { tenantId?: string } | undefined
      )?.tenantId,
      active: unauthorized.activeTenantId,
    };
    expect(published.context).not.toBe(otherTenantId);
    expect(published.active).not.toBe(otherTenantId);
    expect(published).toEqual({
      tenantId: null,
      membershipTenant: undefined,
      context: undefined,
      active: undefined,
    });
    expect(unauthorized.locals.user).toBeNull();
    expect(unauthorized.locals.sessionId).toBeNull();
    expect(unauthorized.locals.permissions).toEqual([]);
    await local.db.query(
      'UPDATE sessions SET tenant_id = ? WHERE id = ?',
      ownerTenantId,
      sid,
    );
    const restored = await runHandle(
      runtime.handle,
      testEvent('http://127.0.0.1:5173/', { sid }),
    );
    expect(restored.locals.tenantId).toBe(ownerTenantId);
    expect(restored.activeTenantId).toBe(ownerTenantId);
    expect(
      (restored.locals.tenantContext as { tenantId: string }).tenantId,
    ).toBe(ownerTenantId);

    // The SvelteKit layer created no tables while serving requests.
    expect(await tableNames(local.db)).toEqual(tablesBefore);

    // Layout summary exposes selection and authorization separately.
    expect(createSessionLayoutLoad()({ locals: crossTenant.locals })).toEqual({
      session: {
        authenticated: true,
        activeTenantId: ownerTenantId,
        selectedTenantSlug: 'other',
        user: {
          id: expect.any(String),
          email: 'owner@example.com',
        },
      },
    });

    // Diagnostics route: real owner session authorizes; a member does not.
    const diagnostics = createRuntimeDiagnosticsHandler({
      runtime,
      toolNames: ['smrt.items.read'],
      now: () => new Date('2026-10-02T12:34:56Z'),
    });
    const ownerResponse = await diagnostics({
      locals: owner.locals,
    } as never);
    expect(ownerResponse.status).toBe(200);
    expect(await ownerResponse.json()).toMatchObject({
      schemaVersion: 1,
      profile: 'local',
    });
    const memberRole = await withSystemContext(async () =>
      (await RoleCollection.create({ db: local.db })).findSystemRoleBySlug(
        DEFAULT_ROLE_SLUGS.MEMBER,
      ),
    );
    expect(memberRole?.id).toBeTruthy();
    const ownerMembership = owner.locals.membership as {
      userId: string;
      tenantId: string;
      isActive: () => boolean;
    };
    const memberLocals = {
      ...owner.locals,
      membership: {
        userId: ownerMembership.userId,
        tenantId: ownerMembership.tenantId,
        roleId: memberRole?.id,
        isActive: () => true,
      },
      permissions: [],
    };
    const memberResponse = await diagnostics({
      locals: memberLocals,
    } as never);
    expect(memberResponse.status).toBe(403);
    const anonymousResponse = await diagnostics({
      locals: anonymous.locals,
    } as never);
    expect(anonymousResponse.status).toBe(401);

    // Health: local identity and the same fingerprint as the CLI computes.
    const health = await createRuntimeHealthHandler(runtime)({} as never);
    expect(await health.json()).toEqual({
      schemaVersion: 1,
      status: 'ready',
      profile: 'local',
      application: resolveApplicationId({ packageName: '@acme/ordering' }),
      instance: null,
      configuration: runtimeConfigurationFingerprint(LOCAL, {
        NODE_ENV: 'development',
        TENANT_BASE_DOMAIN: 'example.test',
      }),
    });
  });

  it('memoizes init, gates requests on readiness, and presents a new invitation once', async () => {
    const onBootstrapInvitation = vi.fn();
    const directories = await localDirectories('memo');
    const initializeLocal = vi.fn(
      (await import('./index.js')).initializeLocalApplicationRuntime,
    );
    const runtime = composeSmrtSvelteKitRuntime(
      {
        ...directories,
        runtime: LOCAL,
        env: { HOST: '127.0.0.1' },
        onBootstrapInvitation,
      },
      { initializeLocal },
    );
    openRuntimes.push(runtime);
    await Promise.all([runtime.init(), runtime.init(), runtime.ready()]);
    await runHandle(runtime.handle, testEvent('http://127.0.0.1/'));
    expect(initializeLocal).toHaveBeenCalledOnce();
    expect(onBootstrapInvitation).toHaveBeenCalledOnce();
    expect(onBootstrapInvitation.mock.calls[0]?.[0]).toMatchObject({
      token: expect.stringMatching(/^[A-Za-z0-9_-]{40,}$/),
    });
    expect(onBootstrapInvitation.mock.calls[0]?.[1]).toEqual({
      bindHost: '127.0.0.1',
    });
    expect(initializeLocal.mock.calls[0]?.[0]).toMatchObject({
      appId: resolveApplicationId({ packageName: '@acme/memo' }),
      bindHost: '127.0.0.1',
      backgroundJobs: false,
    });
  });

  it('fails closed on migration failure with the stable code and stays retryable', async () => {
    const release = vi.fn();
    const acquireWriterLease = vi.fn(() => ({ release }));
    let fail = true;
    const prepareDatabase = vi.fn(async () => {
      if (fail) {
        throw new Error('connect postgres://admin:hunter2@db/private failed');
      }
    });
    const { runtime } = await localRuntime('migration', {
      prepareDatabase,
      acquireWriterLease,
    });

    const failure = await Promise.resolve(runtime.init()).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(LocalRuntimeError);
    expect((failure as LocalRuntimeError).code).toBe('migration_failed');
    expect((failure as Error).message).toBe(MIGRATION_FAILED_MESSAGE);
    expect((failure as Error).message).not.toContain('hunter2');
    expect(release).toHaveBeenCalledOnce();

    // Requests are refused while startup is failed.
    await expect(
      runtime.handle({
        event: testEvent('http://127.0.0.1/') as never,
        resolve: async () => new Response('should not resolve'),
      }),
    ).rejects.toMatchObject({ code: 'migration_failed' });

    fail = false;
    await runtime.init();
    expect(acquireWriterLease).toHaveBeenCalledTimes(3);
    expect(prepareDatabase).toHaveBeenCalledTimes(3);
    await runHandle(runtime.handle, testEvent('http://127.0.0.1/'));
  });

  it.each([
    [undefined, true],
    [true, true],
    [false, false],
  ] as const)('forwards createSchema %s to the local runtime as %s', async (option, expected) => {
    const initializeLocal = vi.fn(async () => {
      throw new Error('stop after capturing the options');
    });
    const prepareDatabase = vi.fn(async () => undefined);
    const runtime = composeSmrtSvelteKitRuntime(
      {
        appId: 'schema-app',
        runtime: LOCAL,
        env: { NODE_ENV: 'development' },
        acquireWriterLease: false,
        enableTenancy: false,
        prepareDatabase,
        ...(option === undefined ? {} : { createSchema: option }),
      },
      { initializeLocal: initializeLocal as never },
    );
    await expect(Promise.resolve(runtime.init())).rejects.toThrow(
      'stop after capturing',
    );
    const call = (initializeLocal.mock.calls[0] as unknown[])[0] as {
      createSchema: boolean;
      prepareDatabase: unknown;
    };
    expect(call.createSchema).toBe(expected);
    expect(call.prepareDatabase).toBe(prepareDatabase);
  });

  it('requires a loopback bind host for local production startup', async () => {
    const release = vi.fn();
    const missingHost = await localRuntime('nohost', {
      env: { NODE_ENV: 'production' },
      acquireWriterLease: () => ({ release }),
    });
    await expect(Promise.resolve(missingHost.runtime.init())).rejects.toThrow(
      'Local production startup requires an explicit loopback HOST',
    );
    const publicHost = await localRuntime('publichost', {
      env: { NODE_ENV: 'production', HOST: '0.0.0.0' },
      acquireWriterLease: () => ({ release }),
    });
    await expect(
      Promise.resolve(publicHost.runtime.init()),
    ).rejects.toMatchObject({ code: 'unsafe_public_exposure' });
    expect(release).toHaveBeenCalledOnce();
  });

  describe('default writer lease (#3416)', () => {
    function stateRootOf(
      runtime: SmrtSvelteKitRuntime,
      directories: { sourceRoot: string; dataDirectory: string },
    ): string {
      return resolveApplicationStateRoot({
        appId: runtime.applicationId(),
        ...directories,
      });
    }

    it('holds the state-root writer lease shared with smrt app by default', async () => {
      const { runtime, ...directories } = await localRuntime('lease-default');
      await runtime.init();
      const stateRoot = stateRootOf(runtime, directories);
      const stateBase =
        platform() === 'darwin'
          ? join(stateHome, 'Library', 'Application Support')
          : stateHome;
      expect(stateRoot.startsWith(stateBase)).toBe(true);
      expect(readActiveWriterLease(stateRoot)).toMatchObject({
        schemaVersion: 1,
        pid: process.pid,
      });
    });

    it('takes no lease with acquireWriterLease: false', async () => {
      const { runtime, ...directories } = await localRuntime('lease-optout', {
        acquireWriterLease: false,
      });
      await runtime.init();
      expect(readActiveWriterLease(stateRootOf(runtime, directories))).toBe(
        null,
      );
    });

    it('records the supervisor loopback origin in the state root, only when ORIGIN is exact', async () => {
      const origin = 'http://127.0.0.1:43112';
      const { runtime, ...directories } = await localRuntime('origin-file', {
        env: { NODE_ENV: 'development', ORIGIN: origin },
      });
      await runtime.init();
      expect(await readOriginFile(stateRootOf(runtime, directories))).toEqual({
        version: 1,
        origin,
        pid: process.pid,
        startedAt: expect.any(String),
      });

      const other = await localRuntime('origin-file-none', {
        env: { NODE_ENV: 'development', ORIGIN: 'http://localhost:43112' },
      });
      await other.runtime.init();
      expect(
        await readOriginFile(stateRootOf(other.runtime, other)),
      ).toBeNull();
    });

    it('fails closed during a live operation unless it presents that operation instance', async () => {
      const directories = await localDirectories('lease-operation');
      const instance = 'a'.repeat(32);
      const probe = createSmrtSvelteKitRuntime({
        ...directories,
        runtime: LOCAL,
        acquireWriterLease: false,
      });
      const stateRoot = stateRootOf(probe, directories);
      await mkdir(stateRoot, { recursive: true, mode: 0o700 });
      // A live process other than this one (the test runner's parent).
      await writeFile(
        join(stateRoot, 'operation.lock'),
        JSON.stringify({ schemaVersion: 1, pid: process.ppid, instance }),
        { mode: 0o600 },
      );

      const outsider = createSmrtSvelteKitRuntime({
        ...directories,
        runtime: LOCAL,
        env: { NODE_ENV: 'development' },
      });
      await expect(Promise.resolve(outsider.init())).rejects.toThrow(
        'An application operation is active',
      );
      expect(readActiveWriterLease(stateRoot)).toBe(null);

      const managed = createSmrtSvelteKitRuntime({
        ...directories,
        runtime: LOCAL,
        env: { NODE_ENV: 'development', SMRT_OPERATION_INSTANCE: instance },
      });
      openRuntimes.push(managed);
      await managed.init();
      expect(readActiveWriterLease(stateRoot)?.pid).toBe(process.pid);
    });

    it('releases the default lease when local startup fails', async () => {
      const { runtime, ...directories } = await localRuntime('lease-release', {
        prepareDatabase: async () => {
          throw new Error('migration failed');
        },
      });
      await expect(Promise.resolve(runtime.init())).rejects.toMatchObject({
        code: 'migration_failed',
      });
      expect(readActiveWriterLease(stateRootOf(runtime, directories))).toBe(
        null,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Deployed profiles (initializer injected; PostgreSQL covered elsewhere)
// ---------------------------------------------------------------------------

describe('deployed SvelteKit runtime', () => {
  const SELF_HOSTED = resolveApplicationRuntime({ profile: 'self-hosted' });
  const CLOUD = resolveApplicationRuntime({ profile: 'cloud' });

  it('never creates schema on a deployed profile and hands prepareDatabase a deployed context', async () => {
    const initializeLocal = vi.fn();
    const initializeDeployed = vi.fn(async () => {
      throw new Error('stop after capturing the options');
    });
    const seen: unknown[] = [];
    const runtime = composeSmrtSvelteKitRuntime(
      {
        appId: 'deployed-app',
        runtime: CLOUD,
        env: { DATABASE_URL: 'postgres://u:p@db.example/app' },
        providerReadiness: () => async () => undefined,
        enableTenancy: false,
        createSchema: true,
        prepareDatabase: async (db, context) => {
          seen.push({ db, context });
        },
      },
      {
        initializeLocal: initializeLocal as never,
        initializeDeployed: initializeDeployed as never,
      },
    );
    await expect(Promise.resolve(runtime.init())).rejects.toThrow(
      'stop after capturing',
    );
    expect(initializeLocal).not.toHaveBeenCalled();
    const options = (initializeDeployed.mock.calls[0] as unknown[])[0] as {
      createSchema?: unknown;
      prepareDatabase: (db: unknown) => Promise<void>;
    };
    expect(options.createSchema).toBeUndefined();
    const db = { query: vi.fn() };
    await options.prepareDatabase(db);
    const { context } = seen[0] as {
      context: {
        db: unknown;
        profile: string;
        paths: unknown;
        firstRun: boolean;
        migrateSchemas: () => Promise<unknown>;
      };
    };
    expect(context).toMatchObject({
      db,
      profile: 'cloud',
      paths: null,
      firstRun: false,
    });
    await expect(context.migrateSchemas()).rejects.toThrow('smrt db:migrate');
  });

  function deployedStub(runtime: ResolvedApplicationRuntime) {
    return {
      db: {} as DatabaseInterface,
      resolvedRuntime: runtime,
      restoreSession: vi.fn(),
      createTaskWorker: vi.fn(),
      createScheduleWorker: vi.fn(),
      diagnostics: vi.fn(),
      health: () => ({
        schemaVersion: 1 as const,
        profile: runtime.profile as 'self-hosted',
        status: 'healthy' as const,
      }),
      readiness: async () => ({
        schemaVersion: 1 as const,
        profile: runtime.profile as 'self-hosted',
        status: 'ready' as const,
        components: {
          database: { status: 'ready' as const },
          authentication: { status: 'ready' as const },
          assets: { status: 'ready' as const },
          secrets: { status: 'ready' as const },
        },
        secretValuesIncluded: false as const,
      }),
      close: vi.fn(async () => undefined),
    };
  }

  it.each([
    ['self-hosted', SELF_HOSTED],
    ['cloud', CLOUD],
  ] as const)('composes %s with exact provider bindings', async (_label, resolved) => {
    const probes: string[] = [];
    const initializeDeployed = vi.fn(async () => deployedStub(resolved));
    const runtime = composeSmrtSvelteKitRuntime(
      {
        appId: 'deployed-app',
        runtime: resolved,
        env: { DATABASE_URL: 'postgres://u:p@db.example/app' },
        providerReadiness: (component, context) => async () => {
          probes.push(`${component}:${context.profile}:${context.provider}`);
        },
        enableTenancy: false,
      },
      { initializeDeployed: initializeDeployed as never },
    );
    await runtime.init();
    await runtime.init();
    expect(initializeDeployed).toHaveBeenCalledOnce();
    const call = (initializeDeployed.mock.calls[0] as unknown[])[0] as {
      profile: string;
      providers: Record<string, unknown>;
      database: { engine: string; connect: unknown; close: unknown };
      authentication: { provider: string; readiness: () => Promise<void> };
      assets: { provider: string; readiness: () => Promise<void> };
      secrets: { provider: string; readiness: () => Promise<void> };
    };
    expect(call.profile).toBe(resolved.profile);
    const { portability: _portability, ...expectedProviders } =
      resolved.providers;
    expect(call.providers).toEqual(expectedProviders);
    expect(call.database.engine).toBe('postgres');
    expect(typeof call.database.connect).toBe('function');
    expect(typeof call.database.close).toBe('function');
    expect(call.authentication.provider).toBe(
      resolved.providers.authentication.provider,
    );
    await call.authentication.readiness();
    await call.assets.readiness();
    await call.secrets.readiness();
    expect(probes).toEqual([
      `authentication:${resolved.profile}:${resolved.providers.authentication.provider}`,
      `assets:${resolved.profile}:${resolved.providers.assets.provider}`,
      `secrets:${resolved.profile}:${resolved.providers.secrets.provider}`,
    ]);
    expect(runtime.databaseConfig()).toEqual({
      type: 'postgres',
      url: 'postgres://u:p@db.example/app',
    });

    // Health never exposes local identity or fingerprints when deployed.
    const health = await createRuntimeHealthHandler(runtime)({} as never);
    expect(await health.json()).toEqual({
      schemaVersion: 1,
      status: 'ready',
      profile: resolved.profile,
    });

    // Diagnostics project deployed readiness.
    const diagnostics = await runtime.readDiagnostics({
      toolNames: [],
      observedAt: new Date('2026-10-02T00:00:00Z'),
    });
    expect(diagnostics).toMatchObject({
      profile: resolved.profile,
      health: 'healthy',
    });

    // Owner setup is disabled when deployed.
    await expect(runtime.localRuntime()).rejects.toThrow(/local profile/);
    const page = createOwnerSetupPage(runtime);
    await expect(page.load(testEvent(SETUP_URL))).resolves.toEqual({
      available: false,
      token: '',
      link: 'unavailable',
    });
    const { failure } = await runAction(
      page,
      testEvent(SETUP_URL, {
        form: { token: 't', name: 'n', email: 'e@example.com' },
      }),
    );
    expect(failure).toMatchObject({
      status: 404,
      data: { code: 'setup_disabled' },
    });
  });

  it('fails closed before connecting when deployed prerequisites are missing', async () => {
    const initializeDeployed = vi.fn();
    const cases: Array<[Partial<SmrtSvelteKitRuntimeOptions>, RegExp]> = [
      [
        {
          runtime: SELF_HOSTED,
          env: {},
          providerReadiness: () => async () => undefined,
        },
        /requires DATABASE_URL/,
      ],
      [
        {
          runtime: {
            ...SELF_HOSTED,
            providers: {
              ...SELF_HOSTED.providers,
              authentication: {
                ...SELF_HOSTED.providers.authentication,
                provider: 'owner-bootstrap',
              },
            },
          } as ResolvedApplicationRuntime,
          env: { DATABASE_URL: 'postgres://db/app' },
          providerReadiness: () => async () => undefined,
        },
        /require public authentication/,
      ],
    ];
    for (const [options, message] of cases) {
      const runtime = composeSmrtSvelteKitRuntime(
        { appId: 'deployed-app', enableTenancy: false, ...options },
        { initializeDeployed },
      );
      await expect(Promise.resolve(runtime.init())).rejects.toThrow(message);
    }
    expect(initializeDeployed).not.toHaveBeenCalled();
  });
});

describe('default provider readiness (#4864)', () => {
  const SELF_HOSTED = resolveApplicationRuntime({ profile: 'self-hosted' });
  it('wires the environment-named probes when the app passes none', async () => {
    const initializeDeployed = vi.fn(async (input: any) => {
      // The probes are the default: no module is configured, so each fails
      // closed with the setting that would name one.
      await expect(input.authentication.readiness()).rejects.toThrow(
        /SMRT_AUTH_READINESS_MODULE must name/,
      );
      return {} as never;
    });
    const runtime = composeSmrtSvelteKitRuntime(
      {
        appId: 'deployed-app',
        enableTenancy: false,
        runtime: SELF_HOSTED,
        env: { DATABASE_URL: 'postgres://db/app' },
      },
      { initializeDeployed: initializeDeployed as never },
    );
    await runtime.init();
    expect(initializeDeployed).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Diagnostics route authorization matrix (reader injected)
// ---------------------------------------------------------------------------

describe('runtime diagnostics route', () => {
  const publicDiagnostics = projectRuntimeDiagnostics({
    profile: 'local',
    health: 'healthy',
    schema: { status: 'ready', migrations: 'current' },
    capabilities: {
      'asset-storage': 'available',
      authentication: 'available',
      'background-jobs': 'disabled',
      database: 'available',
      'paid-capabilities': 'disabled',
      'secret-storage': 'available',
    },
    toolNames: ['smrt.items.read'],
    worker: { topology: 'inline', required: false },
    observedAt: '2026-09-01T12:34:56Z',
    recentErrors: [],
  });

  function ownerLocals(overrides: Record<string, unknown> = {}) {
    return {
      user: { id: 'owner-user' },
      tenantId: 'authorized-tenant',
      sessionId: 'authenticated-session',
      permissions: [],
      membership: {
        userId: 'owner-user',
        tenantId: 'authorized-tenant',
        roleId: 'owner-role',
        isActive: () => true,
      },
      ...overrides,
    };
  }

  it('authorizes before projection and returns only stable errors', async () => {
    const cases: Array<{
      locals: Record<string, unknown>;
      role: string | Error;
      expected: number;
      code?: string;
    }> = [
      { locals: ownerLocals(), role: 'owner', expected: 200 },
      {
        locals: ownerLocals({
          permissions: [RUNTIME_DIAGNOSTICS_READ_PERMISSION],
        }),
        role: 'member',
        expected: 200,
      },
      {
        locals: {},
        role: 'owner',
        expected: 401,
        code: 'authentication_required',
      },
      {
        locals: ownerLocals(),
        role: 'member',
        expected: 403,
        code: 'authorization_denied',
      },
      {
        locals: ownerLocals(),
        role: new Error('db down'),
        expected: 403,
        code: 'authorization_denied',
      },
      {
        locals: ownerLocals({ tenantId: 'other-tenant' }),
        role: 'owner',
        expected: 401,
      },
      {
        locals: ownerLocals({
          membership: null,
          permissions: [RUNTIME_DIAGNOSTICS_READ_PERMISSION],
        }),
        role: 'owner',
        expected: 401,
      },
      {
        locals: ownerLocals({
          membership: {
            userId: 'owner-user',
            tenantId: 'authorized-tenant',
            roleId: 'owner-role',
            isActive: () => false,
          },
        }),
        role: 'owner',
        expected: 401,
      },
      {
        locals: ownerLocals({ sessionId: null }),
        role: 'owner',
        expected: 401,
      },
    ];
    for (const testCase of cases) {
      const readDiagnostics = vi.fn(async () => publicDiagnostics);
      const handler = createRuntimeDiagnosticsHandler({
        readDiagnostics,
        resolveRoleSlug: async () => {
          if (testCase.role instanceof Error) throw testCase.role;
          return testCase.role;
        },
      });
      const response = await handler({ locals: testCase.locals } as never);
      expect(response.status).toBe(testCase.expected);
      if (testCase.expected === 200) {
        expect(await response.json()).toEqual(publicDiagnostics);
        expect(readDiagnostics).toHaveBeenCalledOnce();
      } else {
        expect(readDiagnostics).not.toHaveBeenCalled();
        const body = await response.json();
        expect(Object.keys(body)).toEqual(['schemaVersion', 'error']);
        if (testCase.code) expect(body.error.code).toBe(testCase.code);
      }
    }
  });

  it('replaces upstream failure text with diagnostics_unavailable', async () => {
    const handler = createRuntimeDiagnosticsHandler({
      resolveRoleSlug: async () => 'owner',
      readDiagnostics: async () => {
        throw new Error('postgresql://private.example/db token=secret');
      },
    });
    const response = await handler({ locals: ownerLocals() } as never);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe(
      '{"schemaVersion":1,"error":{"code":"diagnostics_unavailable"}}',
    );
  });

  it('honours an explicit principal resolver and requires a reader', async () => {
    const handler = createRuntimeDiagnosticsHandler({
      resolveRoleSlug: async () => 'owner',
      readDiagnostics: async () => publicDiagnostics,
      resolveLocals: () => ({}),
    });
    expect((await handler({ locals: ownerLocals() } as never)).status).toBe(
      401,
    );
    expect(() => createRuntimeDiagnosticsHandler({})).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// Review findings F1 (tenant authorization) and F2 (single downstream run)
// ---------------------------------------------------------------------------

async function claimedOwner(label: string) {
  const directories = await localDirectories(label);
  const options = {
    ...directories,
    runtime: LOCAL,
    env: { NODE_ENV: 'development', TENANT_BASE_DOMAIN: 'example.test' },
  } satisfies SmrtSvelteKitRuntimeOptions;
  const runtime = createSmrtSvelteKitRuntime(options);
  openRuntimes.push(runtime);
  await runtime.init();
  const local = await runtime.localRuntime();
  const token = await bootstrapToken(runtime);
  const claimEvent = testEvent(SETUP_URL, {
    form: { token, name: 'Owner', email: 'owner@example.com' },
  });
  await runAction(createOwnerSetupPage(runtime), claimEvent);
  const sid = claimEvent.setCookies[0]?.value as string;
  const row = (
    await local.db.query(
      `SELECT memberships.id AS membership_id, memberships.user_id, memberships.tenant_id
       FROM memberships JOIN roles ON roles.id = memberships.role_id
       WHERE roles.slug = 'owner'`,
    )
  ).rows[0] as { membership_id: string; user_id: string; tenant_id: string };
  return {
    runtime,
    local,
    sid,
    userId: row.user_id,
    ownerTenantId: row.tenant_id,
    membershipId: row.membership_id,
  };
}

/**
 * The connection the request layer reads through (`runtime.classOptions`).
 * Post-request writes go through it, as an application's own collections
 * would; see the lane report for the custody-connection visibility note.
 */
async function applicationDb(
  runtime: SmrtSvelteKitRuntime,
): Promise<DatabaseInterface> {
  const { SessionService } = await import('@happyvertical/smrt-users');
  const service = new SessionService(runtime.classOptions('Session'));
  await service.initialize();
  const db = service.getDatabase() as unknown as DatabaseInterface;
  openApplicationDatabases.add(db);
  return db;
}

function expectNoTenantAuthority(observed: Observation): void {
  expect(observed.activeTenantId).toBeUndefined();
  expect(observed.locals.tenantContext).toBeUndefined();
  expect(observed.locals.user).toBeNull();
  expect(observed.locals.tenantId).toBeNull();
  expect(observed.locals.membership ?? null).toBeNull();
  expect(observed.locals.permissions).toEqual([]);
  expect(observed.locals.sessionId).toBeNull();
}

describe('F1: tenant context requires verified membership authorization', () => {
  it('publishes no tenant authority for a deactivated membership with a still-valid session', async () => {
    const owner = await claimedOwner('f1-deactivated');
    const before = await runHandle(
      owner.runtime.handle,
      testEvent('http://127.0.0.1/', { sid: owner.sid }),
    );
    expect(before.activeTenantId).toBe(owner.ownerTenantId);

    await (await applicationDb(owner.runtime)).query(
      "UPDATE memberships SET status = 'inactive' WHERE id = ?",
      owner.membershipId,
    );
    // A fresh session service still accepts the session itself.
    const { SessionService } = await import('@happyvertical/smrt-users');
    const service = new SessionService({ db: owner.local.db });
    await service.initialize();
    const context = await service.loadSessionContext(owner.sid);
    expect(context?.user).toBeTruthy();
    expect(context?.tenantId).toBe(owner.ownerTenantId);
    expect(context?.membership ?? null).toBeNull();
    const after = await runHandle(
      owner.runtime.handle,
      testEvent('http://127.0.0.1/', { sid: owner.sid }),
    );
    expectNoTenantAuthority(after);
  });

  it('publishes no tenant authority when the membership row is deleted', async () => {
    const owner = await claimedOwner('f1-deleted');
    await owner.local.db.query(
      'DELETE FROM memberships WHERE id = ?',
      owner.membershipId,
    );
    const observed = await runHandle(
      owner.runtime.handle,
      testEvent('http://127.0.0.1/', { sid: owner.sid }),
    );
    expectNoTenantAuthority(observed);
  });

  it('allows legitimately inherited authorization and revokes it with the ancestor membership', async () => {
    const owner = await claimedOwner('f1-inherited');
    const childTenantId = await withSystemContext(async () => {
      const roles = await RoleCollection.create({ db: owner.local.db });
      const ownerRole = await roles.findSystemRoleBySlug(
        DEFAULT_ROLE_SLUGS.OWNER,
      );
      if (!ownerRole) throw new Error('owner role missing');
      ownerRole.inheritsToDescendants = true;
      await ownerRole.save();
      const tenants = await TenantCollection.create({ db: owner.local.db });
      const child = await tenants.createChild(owner.ownerTenantId, {
        name: 'Child',
        slug: 'child',
      });
      await child.save();
      return child.id as string;
    });
    const { SessionService } = await import('@happyvertical/smrt-users');
    const sessions = new SessionService({ db: owner.local.db });
    await sessions.initialize();
    const childSid = await sessions.createSession(owner.userId, childTenantId);

    const inherited = await runHandle(
      owner.runtime.handle,
      testEvent('http://127.0.0.1/', { sid: childSid }),
    );
    expect(inherited.locals.user).not.toBeNull();
    expect(inherited.locals.tenantId).toBe(childTenantId);
    expect(inherited.activeTenantId).toBe(childTenantId);
    expect(
      (inherited.locals.tenantContext as { tenantId: string }).tenantId,
    ).toBe(childTenantId);

    // The user no longer belongs to the ancestor the authority came from.
    await (await applicationDb(owner.runtime)).query(
      "UPDATE memberships SET status = 'inactive' WHERE id = ?",
      owner.membershipId,
    );
    const revoked = await runHandle(
      owner.runtime.handle,
      testEvent('http://127.0.0.1/', { sid: childSid }),
    );
    expectNoTenantAuthority(revoked);
  });
});

describe('F2: downstream failures run application code once', () => {
  it('propagates a downstream throw exactly once and never re-enters resolve', async () => {
    const owner = await claimedOwner('f2-once');
    const boom = new Error('downstream failure');
    let calls = 0;
    const outcome = await Promise.resolve(
      owner.runtime.handle({
        event: testEvent('http://127.0.0.1/', {
          sid: owner.sid,
        }) as unknown as Parameters<Handle>[0]['event'],
        resolve: async () => {
          calls += 1;
          throw boom;
        },
      }),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(outcome).toBe(boom);
    expect(calls).toBe(1);
  });

  it('fails closed with 500 and no downstream run when the session layer cannot load', async () => {
    const owner = await claimedOwner('f2-session-failure');
    const dataDirectory = owner.local.paths.root;
    const broken = createSmrtSvelteKitRuntime({
      runtime: LOCAL,
      sourceRoot: join(dirname(dataDirectory), 'source'),
      dataDirectory,
      env: { NODE_ENV: 'development' },
      classOverrides: {
        Session: {
          db: { type: 'sqlite', url: '/nonexistent-smrt-dir/denied.sqlite' },
        },
      },
    });
    openRuntimes.push(broken);
    const event = testEvent('http://127.0.0.1/', { sid: owner.sid });
    let calls = 0;
    const response = await broken.handle({
      event: event as unknown as Parameters<Handle>[0]['event'],
      resolve: async () => {
        calls += 1;
        return new Response('should not run');
      },
    });
    expect(response.status).toBe(500);
    expect(calls).toBe(0);
    expect(event.locals.user ?? null).toBeNull();
    expect(event.locals.tenantContext).toBeUndefined();
  });
});

describe('desktop owner link', () => {
  const SECRET = 'c0ffee'.repeat(10) + 'beef';
  const LINK_URL = `http://127.0.0.1:5173${OWNER_LINK_ROUTE}?launch=${SECRET}`;
  const OPTIONS = { launchSecret: SECRET };

  function linkEvent(
    headers: Record<string, string> = {},
    clientAddress = '127.0.0.1',
    url = LINK_URL,
  ) {
    return testEvent(url, {
      headers: { host: new URL(url).host, ...headers },
      clientAddress,
    });
  }

  it('is the documented fixed route', () => {
    expect(OWNER_LINK_ROUTE).toBe('/api/_runtime/owner-link');
  });

  it('answers only a same-origin loopback request and never asks for the token otherwise', async () => {
    const ownerSetupLocation = vi.fn(async () => '/setup?token=T');
    const handler = createOwnerLinkHandler({ ownerSetupLocation }, OPTIONS);
    const rejected: Array<ReturnType<typeof linkEvent>> = [
      linkEvent({}, '10.0.0.5'),
      linkEvent({}, '192.168.1.9'),
      linkEvent({ host: 'evil.example' }),
      linkEvent({ host: '127.0.0.1:9999' }),
      linkEvent({ origin: 'https://evil.example' }),
      linkEvent({ 'sec-fetch-site': 'cross-site' }),
      linkEvent({ 'sec-fetch-site': 'same-site' }),
      linkEvent(
        {},
        '127.0.0.1',
        `http://203.0.113.7:5173/api/_runtime/owner-link?launch=${SECRET}`,
      ),
      testEvent(LINK_URL, {
        headers: { host: '127.0.0.1:5173' },
        clientAddress: () => {
          throw new Error('no peer');
        },
      }),
    ];
    for (const event of rejected) {
      const response = await handler(event as never);
      expect(response.status).toBe(403);
      expect(response.headers.get('location')).toBeNull();
      expect(await response.text()).toBe('');
    }
    expect(ownerSetupLocation).not.toHaveBeenCalled();

    for (const headers of [
      {},
      { origin: 'http://127.0.0.1:5173' },
      { 'sec-fetch-site': 'none' },
      { 'sec-fetch-site': 'same-origin' },
    ]) {
      const response = await handler(linkEvent(headers) as never);
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/setup?token=T');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(await response.text()).toBe('');
    }
    const ipv6 = await handler(
      linkEvent(
        {},
        '::1',
        `http://localhost:5173/api/_runtime/owner-link?launch=${SECRET}`,
      ) as never,
    );
    expect(ipv6.status).toBe(302);
  });

  describe('launch secret', () => {
    const NOT_THE_SECRET = 'f'.repeat(SECRET.length);
    const urlWith = (query: string) =>
      `http://127.0.0.1:5173${OWNER_LINK_ROUTE}${query}`;

    async function expectRefused(
      handler: ReturnType<typeof createOwnerLinkHandler>,
      event: ReturnType<typeof linkEvent>,
    ) {
      const response = await handler(event as never);
      expect(response.status).toBe(403);
      expect(response.headers.get('location')).toBeNull();
      expect(await response.text()).toBe('');
      expect(response.headers.get('cache-control')).toBe('no-store');
      return response;
    }

    it('refuses a loopback request without the secret even when every other check passes', async () => {
      const ownerSetupLocation = vi.fn(async () => '/setup?token=T');
      const handler = createOwnerLinkHandler({ ownerSetupLocation }, OPTIONS);
      await expectRefused(
        handler,
        linkEvent(
          { origin: 'http://127.0.0.1:5173' },
          '127.0.0.1',
          urlWith(''),
        ),
      );
      await expectRefused(
        handler,
        linkEvent({}, '127.0.0.1', urlWith('?other=1')),
      );
      expect(ownerSetupLocation).not.toHaveBeenCalled();
    });

    it('redirects to /setup with the right secret and leaves the target unchanged', async () => {
      const handler = createOwnerLinkHandler(
        { ownerSetupLocation: async () => '/setup?token=T' },
        OPTIONS,
      );
      const response = await handler(linkEvent() as never);
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/setup?token=T');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(await response.text()).toBe('');
    });

    it('refuses a wrong secret, one of another length, a truncated or extended one, and an empty one', async () => {
      const ownerSetupLocation = vi.fn(async () => '/setup?token=T');
      const handler = createOwnerLinkHandler({ ownerSetupLocation }, OPTIONS);
      for (const wrong of [
        NOT_THE_SECRET,
        'short',
        SECRET.slice(0, -1),
        `${SECRET}0`,
        SECRET.toUpperCase(),
        '',
      ]) {
        await expectRefused(
          handler,
          linkEvent(
            {},
            '127.0.0.1',
            urlWith(`?launch=${encodeURIComponent(wrong)}`),
          ),
        );
      }
      await expectRefused(
        handler,
        linkEvent({}, '127.0.0.1', urlWith('?launch')),
      );
      expect(ownerSetupLocation).not.toHaveBeenCalled();
    });

    it('still applies every other check when the secret is right', async () => {
      const ownerSetupLocation = vi.fn(async () => '/setup?token=T');
      const handler = createOwnerLinkHandler({ ownerSetupLocation }, OPTIONS);
      await expectRefused(handler, linkEvent({}, '10.0.0.5'));
      await expectRefused(handler, linkEvent({ host: 'evil.example' }));
      await expectRefused(
        handler,
        linkEvent({ origin: 'https://evil.example' }),
      );
      await expectRefused(
        handler,
        linkEvent({ 'sec-fetch-site': 'same-site' }),
      );
      expect(ownerSetupLocation).not.toHaveBeenCalled();
    });

    it('refuses everything when no secret is configured, even if launch is sent', async () => {
      const ownerSetupLocation = vi.fn(async () => '/setup?token=T');
      for (const handler of [
        createOwnerLinkHandler({ ownerSetupLocation }, { launchSecret: null }),
        createOwnerLinkHandler({ ownerSetupLocation }, { launchSecret: '' }),
      ]) {
        await expectRefused(handler, linkEvent());
        await expectRefused(
          handler,
          linkEvent({}, '127.0.0.1', urlWith('?launch=')),
        );
        await expectRefused(
          handler,
          linkEvent({}, '127.0.0.1', urlWith('?launch=undefined')),
        );
      }
      expect(ownerSetupLocation).not.toHaveBeenCalled();
    });

    it('reads SMRT_DESKTOP_OWNER_LINK_SECRET per request by default', async () => {
      const ownerSetupLocation = vi.fn(async () => '/setup?token=T');
      const handler = createOwnerLinkHandler({ ownerSetupLocation });
      const previous = process.env[OWNER_LINK_SECRET_ENV];
      try {
        delete process.env[OWNER_LINK_SECRET_ENV];
        await expectRefused(handler, linkEvent());
        process.env[OWNER_LINK_SECRET_ENV] = SECRET;
        expect((await handler(linkEvent() as never)).status).toBe(302);
        await expectRefused(
          handler,
          linkEvent({}, '127.0.0.1', urlWith(`?launch=${NOT_THE_SECRET}`)),
        );
      } finally {
        if (previous === undefined) delete process.env[OWNER_LINK_SECRET_ENV];
        else process.env[OWNER_LINK_SECRET_ENV] = previous;
      }
    });

    it('never puts the secret in a response body, header or log', async () => {
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
        (method) => vi.spyOn(console, method).mockImplementation(() => {}),
      );
      try {
        const handler = createOwnerLinkHandler(
          { ownerSetupLocation: async () => '/setup?token=T' },
          OPTIONS,
        );
        const responses = [
          await handler(linkEvent() as never),
          await handler(
            linkEvent(
              {},
              '127.0.0.1',
              urlWith(`?launch=${NOT_THE_SECRET}`),
            ) as never,
          ),
          await handler(linkEvent({}, '127.0.0.1', urlWith('')) as never),
        ];
        for (const response of responses) {
          expect(await response.text()).not.toContain(SECRET);
          expect(JSON.stringify([...response.headers])).not.toContain(SECRET);
        }
        for (const spy of spies) {
          expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET);
        }
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    });
  });

  it('falls back to / when the runtime cannot answer', async () => {
    const handler = createOwnerLinkHandler(
      {
        ownerSetupLocation: async () => {
          throw new Error('secret-token-material');
        },
      },
      OPTIONS,
    );
    const response = await handler(linkEvent() as never);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/');
    expect(await response.text()).toBe('');
  });

  it('redirects to the startup invitation once, leaks it nowhere else, and goes to / after the claim', async () => {
    const onBootstrapInvitation = vi.fn();
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
      (method) => vi.spyOn(console, method).mockImplementation(() => {}),
    );
    try {
      const { runtime } = await localRuntime('owner-link', {
        onBootstrapInvitation,
      });
      await runtime.init();
      const token = onBootstrapInvitation.mock.calls[0]?.[0].token as string;
      expect(token).toBeTruthy();
      const handler = createOwnerLinkHandler(runtime, OPTIONS);

      const first = await handler(linkEvent() as never);
      expect(first.status).toBe(302);
      expect(first.headers.get('location')).toBe(
        `/setup?token=${encodeURIComponent(token)}`,
      );
      expect(await first.text()).toBe('');
      expect(
        [...first.headers].filter(
          ([name, value]) => name !== 'location' && value.includes(token),
        ),
      ).toEqual([]);
      // The same invitation is handed out again (a window reload) rather than
      // rotated: the startup token stays the one claim.
      const again = await handler(linkEvent() as never);
      expect(again.headers.get('location')).toBe(first.headers.get('location'));

      // The redirect leads to the real setup page, which claims once.
      const page = createOwnerSetupPage(runtime);
      const loaded = await page.load(
        testEvent(`http://127.0.0.1:5173${first.headers.get('location')}`),
      );
      expect(loaded).toMatchObject({ available: true, token, link: 'ready' });
      const claim = await runAction(
        page,
        testEvent(SETUP_URL, {
          form: { token, name: 'Owner', email: 'owner@example.com' },
        }),
      );
      expect(claim.redirect?.status).toBe(303);
      const replay = await runAction(
        page,
        testEvent(SETUP_URL, {
          form: { token, name: 'Other', email: 'other@example.com' },
        }),
      );
      expect(replay.failure?.status).toBe(400);

      const claimed = await handler(linkEvent() as never);
      expect(claimed.status).toBe(302);
      expect(claimed.headers.get('location')).toBe('/');

      for (const spy of spies) {
        expect(JSON.stringify(spy.mock.calls)).not.toContain(token);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('rotates to a fresh invitation when the startup one expired, and the old one stops working', async () => {
    let clock = new Date('2030-01-01T00:00:00.000Z');
    const onBootstrapInvitation = vi.fn();
    const { runtime } = await localRuntime('owner-link-expired', {
      bootstrapTtlSeconds: 60,
      now: () => clock,
      onBootstrapInvitation,
    });
    await runtime.init();
    const first = onBootstrapInvitation.mock.calls[0]?.[0].token as string;
    const handler = createOwnerLinkHandler(runtime, OPTIONS);
    clock = new Date(clock.getTime() + 120_000);

    const response = await handler(linkEvent() as never);
    const location = response.headers.get('location') ?? '';
    expect(location.startsWith('/setup?token=')).toBe(true);
    const fresh = decodeURIComponent(location.slice('/setup?token='.length));
    expect(fresh).not.toBe(first);

    const page = createOwnerSetupPage(runtime);
    const stale = await runAction(
      page,
      testEvent(SETUP_URL, {
        form: { token: first, name: 'Owner', email: 'owner@example.com' },
      }),
    );
    expect(stale.failure?.status).toBe(400);
    const claim = await runAction(
      page,
      testEvent(SETUP_URL, {
        form: { token: fresh, name: 'Owner', email: 'owner@example.com' },
      }),
    );
    expect(claim.redirect?.status).toBe(303);
  });

  it('answers / outside the local profile', async () => {
    const runtime = createSmrtSvelteKitRuntime({
      runtime: resolveApplicationRuntime({ profile: 'self-hosted' }),
      env: { NODE_ENV: 'development' },
    });
    const response = await createOwnerLinkHandler(
      runtime,
      OPTIONS,
    )(linkEvent() as never);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/');
  });
});

describe('desktop owner link auto sign-in', () => {
  const SECRET = 'a1b2c3'.repeat(10) + 'dead';
  const OTHER_SECRET = 'f'.repeat(SECRET.length);
  const LINK = `http://127.0.0.1:5173${OWNER_LINK_ROUTE}?launch=${SECRET}`;
  const OPTIONS = { launchSecret: SECRET, autoClaim: true };

  function linkEvent(
    overrides: {
      url?: string;
      headers?: Record<string, string>;
      clientAddress?: string;
      user?: { id: string };
    } = {},
  ) {
    const url = overrides.url ?? LINK;
    const event = testEvent(url, {
      headers: {
        host: new URL(url).host,
        'user-agent': 'wrapper-test',
        ...overrides.headers,
      },
      clientAddress: overrides.clientAddress ?? '127.0.0.1',
    });
    if (overrides.user) event.locals.user = overrides.user;
    return event;
  }

  async function ownerRows(runtime: SmrtSvelteKitRuntime) {
    const local = await runtime.localRuntime();
    const owners = (
      await local.db.query(
        `SELECT memberships.id AS membership_id, memberships.user_id, memberships.tenant_id
         FROM memberships JOIN roles ON roles.id = memberships.role_id
         WHERE roles.slug = 'owner'`,
      )
    ).rows as Array<{ user_id: string; tenant_id: string }>;
    const users = (await local.db.query('SELECT id, email FROM users'))
      .rows as Array<{ id: string; email: string }>;
    const sessions = (await local.db.query('SELECT id FROM sessions'))
      .rows as Array<{ id: string }>;
    return { owners, users, sessions };
  }

  it('creates the owner once, sets the session cookie and redirects to /', async () => {
    const { runtime } = await localRuntime('link-auto-create');
    await runtime.init();
    const handler = createOwnerLinkHandler(runtime, {
      ...OPTIONS,
      ownerName: 'Ada Lovelace',
    });
    const event = linkEvent();
    const response = await handler(event as never);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('');
    expect(event.setCookies).toHaveLength(1);
    const cookie = event.setCookies[0];
    expect(cookie?.name).toBe(runtime.sessionCookie.name);
    expect(cookie?.options).toMatchObject({ httpOnly: true, path: '/' });

    const rows = await ownerRows(runtime);
    expect(rows.owners).toHaveLength(1);
    expect(rows.users).toHaveLength(1);
    // No invented address: the owner has no email yet.
    expect(rows.users[0]?.email ?? '').toBe('');
    const local = await runtime.localRuntime();
    const context = await local.restoreSession(cookie?.value as string);
    expect(context?.user?.id).toBe(rows.owners[0]?.user_id);
    const person = (await local.db.query('SELECT name, email FROM profiles'))
      .rows as Array<{ name: string; email: string | null }>;
    expect(person.map((row) => row.name)).toContain('Ada Lovelace');
    expect(await runtime.ownerSetupLocation()).toBe('/');
  });

  it('names the owner after the OS account when no name is given', async () => {
    const { runtime } = await localRuntime('link-auto-os-name');
    await runtime.init();
    const response = await createOwnerLinkHandler(
      runtime,
      OPTIONS,
    )(linkEvent() as never);
    expect(response.status).toBe(302);
    const local = await runtime.localRuntime();
    const rows = (await local.db.query('SELECT name FROM profiles'))
      .rows as Array<{ name: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name.trim()).not.toBe('');
    expect(rows[0]?.name).not.toContain('@');
  });

  it('issues a new session for the sole owner when the request has none, and none when it has one', async () => {
    const { runtime } = await localRuntime('link-auto-reissue');
    await runtime.init();
    const handler = createOwnerLinkHandler(runtime, OPTIONS);
    const first = linkEvent();
    await handler(first as never);
    const before = await ownerRows(runtime);
    const userId = before.owners[0]?.user_id as string;

    // The session cookie was lost: a new session for the same owner.
    const lost = linkEvent();
    const reissued = await handler(lost as never);
    expect(reissued.status).toBe(302);
    expect(reissued.headers.get('location')).toBe('/');
    expect(lost.setCookies).toHaveLength(1);
    expect(lost.setCookies[0]?.value).not.toBe(first.setCookies[0]?.value);
    const after = await ownerRows(runtime);
    expect(after.owners).toHaveLength(1);
    expect(after.users).toHaveLength(1);
    expect(after.sessions.length).toBe(before.sessions.length + 1);
    const local = await runtime.localRuntime();
    expect(
      (await local.restoreSession(lost.setCookies[0]?.value as string))?.user
        ?.id,
    ).toBe(userId);

    // A valid owner session: nothing is issued.
    const signedIn = linkEvent({ user: { id: userId } });
    const kept = await handler(signedIn as never);
    expect(kept.headers.get('location')).toBe('/');
    expect(signedIn.setCookies).toHaveLength(0);
    expect((await ownerRows(runtime)).sessions).toHaveLength(
      after.sessions.length,
    );

    // A session of someone else is not the owner's: a new owner session.
    const stranger = linkEvent({ user: { id: 'someone-else' } });
    await handler(stranger as never);
    expect(stranger.setCookies).toHaveLength(1);
  });

  it('creates exactly one owner for concurrent first requests', async () => {
    const { runtime } = await localRuntime('link-auto-concurrent');
    await runtime.init();
    const handler = createOwnerLinkHandler(runtime, OPTIONS);
    const events = Array.from({ length: 6 }, () => linkEvent());
    const responses = await Promise.all(
      events.map((event) => handler(event as never)),
    );
    for (const response of responses) {
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/');
    }
    const rows = await ownerRows(runtime);
    expect(rows.owners).toHaveLength(1);
    expect(rows.users).toHaveLength(1);
    const local = await runtime.localRuntime();
    for (const event of events) {
      expect(event.setCookies).toHaveLength(1);
      expect(
        (await local.restoreSession(event.setCookies[0]?.value as string))?.user
          ?.id,
      ).toBe(rows.owners[0]?.user_id);
    }
  });

  it('creates nothing and answers 403 for every failed gate', async () => {
    const { runtime } = await localRuntime('link-auto-refused');
    await runtime.init();
    const withUrl = (query: string) =>
      `http://127.0.0.1:5173${OWNER_LINK_ROUTE}${query}`;
    const handler = createOwnerLinkHandler(runtime, OPTIONS);
    const events = [
      linkEvent({ url: withUrl('') }),
      linkEvent({ url: withUrl('?launch=') }),
      linkEvent({ url: withUrl(`?launch=${OTHER_SECRET}`) }),
      linkEvent({ url: withUrl(`?launch=${SECRET.slice(0, -1)}`) }),
      linkEvent({ headers: { host: 'evil.example' } }),
      linkEvent({ headers: { origin: 'https://evil.example' } }),
      linkEvent({ headers: { 'sec-fetch-site': 'cross-site' } }),
      linkEvent({ clientAddress: '10.0.0.5' }),
      linkEvent({
        url: `http://203.0.113.7:5173${OWNER_LINK_ROUTE}?launch=${SECRET}`,
      }),
    ];
    for (const event of events) {
      const response = await handler(event as never);
      expect(response.status).toBe(403);
      expect(response.headers.get('location')).toBeNull();
      expect(await response.text()).toBe('');
      expect(event.setCookies).toHaveLength(0);
    }
    const noSecret = createOwnerLinkHandler(runtime, {
      autoClaim: true,
      launchSecret: null,
    });
    expect((await noSecret(linkEvent() as never)).status).toBe(403);
    const rows = await ownerRows(runtime);
    expect(rows.owners).toHaveLength(0);
    expect(rows.users).toHaveLength(0);
    expect(rows.sessions).toHaveLength(0);
  });

  it('keeps the setup redirect and creates nothing when autoClaim is off', async () => {
    const { runtime } = await localRuntime('link-auto-off');
    await runtime.init();
    const event = linkEvent();
    const response = await createOwnerLinkHandler(runtime, {
      launchSecret: SECRET,
    })(event as never);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')?.startsWith('/setup?token=')).toBe(
      true,
    );
    expect(event.setCookies).toHaveLength(0);
    expect((await ownerRows(runtime)).owners).toHaveLength(0);
  });

  it('issues no session outside the local profile', async () => {
    const runtime = createSmrtSvelteKitRuntime({
      runtime: resolveApplicationRuntime({ profile: 'self-hosted' }),
      env: { NODE_ENV: 'development' },
    });
    const event = linkEvent();
    const response = await createOwnerLinkHandler(
      runtime,
      OPTIONS,
    )(event as never);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/');
    expect(event.setCookies).toHaveLength(0);
  });

  it('refuses to be built on a runtime that cannot sign the owner in', () => {
    expect(() =>
      createOwnerLinkHandler(
        { ownerSetupLocation: async () => '/' },
        { autoClaim: true },
      ),
    ).toThrow(/signInLocalOwner/);
  });

  it('fails closed with no session when the owner is not exactly one active owner', async () => {
    const { runtime } = await localRuntime('link-auto-fail-closed');
    await runtime.init();
    const handler = createOwnerLinkHandler(runtime, OPTIONS);
    await handler(linkEvent() as never);
    const local = await runtime.localRuntime();

    // Several active owners.
    const owner = (await ownerRows(runtime)).owners[0] as {
      user_id: string;
      tenant_id: string;
    };
    const roleRow = (
      await local.db.query(`SELECT id FROM roles WHERE slug = 'owner'`)
    ).rows[0] as { id: string };
    const membership = (
      await local.db.query(
        `SELECT * FROM memberships WHERE user_id = ?`,
        owner.user_id,
      )
    ).rows[0] as Record<string, unknown>;
    const clone = {
      ...membership,
      id: '00000000-0000-4000-8000-0000000000aa',
      user_id: '00000000-0000-4000-8000-0000000000bb',
      slug: 'second-owner',
      role_id: roleRow.id,
    };
    const columns = Object.keys(clone);
    // A second owner row for a user that does not exist is enough to make the
    // owner ambiguous; suspend the foreign-key check for the fixture insert.
    await local.db.query('PRAGMA foreign_keys = OFF');
    await local.db.query(
      `INSERT INTO memberships (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      ...Object.values(clone),
    );
    await local.db.query('PRAGMA foreign_keys = ON');
    const sessionsBefore = (await ownerRows(runtime)).sessions.length;
    const several = linkEvent();
    const severalResponse = await handler(several as never);
    expect(severalResponse.status).toBe(302);
    expect(severalResponse.headers.get('location')).toBe('/');
    expect(several.setCookies).toHaveLength(0);
    await local.db.query(
      `DELETE FROM memberships WHERE id = ?`,
      '00000000-0000-4000-8000-0000000000aa',
    );

    // No active owner but a spent invitation: nothing is created.
    await local.db.query(
      `UPDATE memberships SET status = 'suspended' WHERE user_id = ?`,
      owner.user_id,
    );
    const none = linkEvent();
    const noneResponse = await handler(none as never);
    expect(noneResponse.status).toBe(302);
    expect(noneResponse.headers.get('location')).toBe('/');
    expect(none.setCookies).toHaveLength(0);
    const rows = await ownerRows(runtime);
    expect(rows.sessions).toHaveLength(sessionsBefore);
    expect(rows.users).toHaveLength(1);
  });

  it('keeps the session id and tokens out of logs, bodies and headers', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
      (method) => vi.spyOn(console, method).mockImplementation(() => {}),
    );
    try {
      const { runtime } = await localRuntime('link-auto-logs');
      await runtime.init();
      const handler = createOwnerLinkHandler(runtime, OPTIONS);
      const event = linkEvent();
      const response = await handler(event as never);
      const sid = event.setCookies[0]?.value as string;
      const refused = await handler(
        linkEvent({
          url: `http://127.0.0.1:5173${OWNER_LINK_ROUTE}?launch=${OTHER_SECRET}`,
        }) as never,
      );
      for (const r of [response, refused]) {
        expect(await r.text()).toBe('');
        const headers = JSON.stringify([...r.headers]);
        expect(headers).not.toContain(sid);
        expect(headers).not.toContain(SECRET);
      }
      for (const spy of spies) {
        const logged = JSON.stringify(spy.mock.calls);
        expect(logged).not.toContain(sid);
        expect(logged).not.toContain(SECRET);
        expect(logged).not.toContain(OTHER_SECRET);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
