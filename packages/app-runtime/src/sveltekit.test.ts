import { createHash } from 'node:crypto';
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
  RoleCollection,
  TenantCollection,
  TenantStatus,
} from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import { type Handle, isActionFailure, isRedirect } from '@sveltejs/kit';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  LocalRuntimeError,
  MIGRATION_FAILED_MESSAGE,
  projectRuntimeDiagnostics,
  resolveApplicationId,
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
  createOwnerSetupPage,
  createRuntimeDiagnosticsHandler,
  createRuntimeHealthHandler,
  createSessionLayoutLoad,
  createSmrtSvelteKitRuntime,
  createSubdomainTenantSelector,
  DEFAULT_OWNER_SETUP_MESSAGES,
  isLoopbackAddress,
  isLoopbackHostname,
  RUNTIME_DIAGNOSTICS_READ_PERMISSION,
  selectTenantSlug,
} from './sveltekit.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const temporaryRoots: string[] = [];
const initializationLockPaths = new Set<string>();
const openRuntimes: SmrtSvelteKitRuntime[] = [];

afterEach(async () => {
  for (const runtime of openRuntimes.splice(0)) {
    try {
      const local = await runtime.localRuntime();
      await local.db.close?.();
    } catch {
      // Runtime never started.
    }
  }
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

afterAll(() => {
  disableTenancy();
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
  it('keeps owner bootstrap loopback-only, single-use, and HMAC-only end to end', async () => {
    const onOwnerClaimed = vi.fn(() => {
      throw new Error('cleanup failure must not surface');
    });
    const { runtime } = await localRuntime('bootstrap');
    await runtime.init();
    const page = createOwnerSetupPage(runtime, { onOwnerClaimed });
    const local = await runtime.localRuntime();
    const token = await bootstrapToken(runtime);

    // load: loopback shows the form and echoes the URL token.
    await expect(
      page.load(testEvent(`${SETUP_URL}?token=${token}`)),
    ).resolves.toEqual({ available: true, token });
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
      });
    }

    const validForm = { token, name: 'Will Owner', email: 'will@example.com' };
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
    ).resolves.toEqual({ available: false, token: '' });
    const signedIn = testEvent(SETUP_URL);
    signedIn.locals.user = { id: 'someone' };
    await expect(page.load(signedIn)).rejects.toSatisfy(isRedirect);
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
    const unauthorized = await runHandle(
      runtime.handle,
      testEvent('http://other.example.test/', { sid }),
    );
    const sessionRow = await local.db.query(
      'SELECT tenant_id FROM sessions WHERE id = ?',
      sid,
    );
    expect(sessionRow.rows[0]).toEqual({ tenant_id: otherTenantId });
    // Whatever the session layer resolves, the published context is never
    // the membership-less tenant: it is the tenant of an active membership.
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
      tenantId: ownerTenantId,
      membershipTenant: ownerTenantId,
      context: ownerTenantId,
      active: ownerTenantId,
    });
    await local.db.query(
      'UPDATE sessions SET tenant_id = ? WHERE id = ?',
      ownerTenantId,
      sid,
    );

    // The SvelteKit layer created no tables while serving requests.
    expect(await tableNames(local.db)).toEqual(tablesBefore);

    // Layout summary exposes selection and authorization separately.
    expect(createSessionLayoutLoad()({ locals: crossTenant.locals })).toEqual({
      session: {
        authenticated: true,
        activeTenantId: ownerTenantId,
        selectedTenantSlug: 'other',
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
});

// ---------------------------------------------------------------------------
// Deployed profiles (initializer injected; PostgreSQL covered elsewhere)
// ---------------------------------------------------------------------------

describe('deployed SvelteKit runtime', () => {
  const SELF_HOSTED = resolveApplicationRuntime({ profile: 'self-hosted' });
  const CLOUD = resolveApplicationRuntime({ profile: 'cloud' });

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
        { runtime: SELF_HOSTED, env: { DATABASE_URL: 'postgres://db/app' } },
        /requires providerReadiness/,
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
  return service.getDatabase() as unknown as DatabaseInterface;
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
