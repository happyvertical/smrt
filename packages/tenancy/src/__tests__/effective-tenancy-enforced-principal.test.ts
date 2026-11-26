/**
 * A principal the REST host resolves (`APIConfig.resolvePrincipal`) decides
 * who the request acts as; an ambient tenancy context does not (#5195 D2).
 *
 * - An active system context around the handler does not make the request
 *   a system actor.
 * - An active tenant context must agree with the principal and is never
 *   adopted: a different tenant, a different user, or any tenant when the
 *   principal has none, is refused before any hook or write; an agreeing
 *   context keeps the principal's permissions and bypass flag.
 * - The request's tenancy context is entered through the policy source's
 *   `runForPrincipal`: a frozen projection of the principal. A source
 *   without it serves a tenanted principal through `runInContext` and
 *   refuses a request that arrives inside a system context.
 * - A request admitted under a read grant still writes no tenant-scoped row
 *   in a nested handler or a sync item.
 *
 * Real SQLite, the real tenant interceptor.
 */

import {
  field,
  getResolvedTenancy,
  getTenantPolicySource,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  setTenantPolicySource,
  smrt,
  type TenantPolicySource,
} from '@happyvertical/smrt-core';
import {
  type APIConfig,
  APIGenerator,
  type APIRequestPrincipal,
} from '@happyvertical/smrt-core/generators/rest';
import { setRuntimeExposureGate } from '@happyvertical/smrt-core/runtime-exposure';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { getCurrentTenant, withSystemContext, withTenant } from '../context.js';
import { TenantScoped, tenantId } from '../decorators.js';
import { disableTenancy, enableTenancy } from '../interceptor.js';

const TENANT_A = 'aaaaaaaa-5195-4111-8111-aaaaaaaaaaa1';
const TENANT_B = 'bbbbbbbb-5195-4222-8222-bbbbbbbbbbb2';

/** What the `probe` action saw, set per call. */
let probed: Record<string, unknown> | undefined;
/** Work a test runs inside the `probe` action, when set. */
let probeWork: (() => Promise<unknown>) | undefined;

@smrt({
  api: {
    include: ['list', 'get', 'create', 'update', 'delete', 'probe'],
    routes: { probe: { method: 'GET', scope: 'collection' } },
  },
})
@TenantScoped({ mode: 'optional' })
class EnforcedNote extends SmrtObject {
  @field({ type: 'text' })
  title = '';

  @tenantId({ nullable: true })
  tenantId: string | null = null;
}

class EnforcedNoteCollection extends SmrtCollection<EnforcedNote> {
  static readonly _itemClass = EnforcedNote;

  async probe(): Promise<{ ok: true }> {
    const actor = getResolvedTenancy()?.actor;
    const context = getCurrentTenant();
    probed = {
      system: actor?.system ?? null,
      tenantId: actor?.tenantId ?? null,
      userId: actor?.userId ?? null,
      bypass: actor?.bypass ?? null,
      authenticated: actor?.authenticated ?? null,
      permissions: actor?.permissions ? [...actor.permissions].sort() : null,
      contextTenant: context?.tenantId ?? null,
      contextFrozen: context ? Object.isFrozen(context) : null,
      contextBypass: context?.superAdminBypass === true,
      contextPermissionsAreSet: context?.permissions instanceof Set,
    };
    probed.work = probeWork ? await probeWork() : undefined;
    return { ok: true };
  }
}

/** Readable by anyone; one tenant's rows for a principal of that tenant. */
@smrt({ api: { public: 'read', include: ['list', 'get'] } })
@TenantScoped({ mode: 'optional' })
class EnforcedBoard extends SmrtObject {
  @field({ type: 'text' })
  title = '';

  @tenantId({ nullable: true })
  tenantId: string | null = null;
}

class EnforcedBoardCollection extends SmrtCollection<EnforcedBoard> {
  static readonly _itemClass = EnforcedBoard;
}

const slug = (action: string) =>
  `${ObjectRegistry.getClass('EnforcedNote')?.collection}.${action}`;

function principals(): Record<string, APIRequestPrincipal | null> {
  const ofA = (overrides: Partial<APIRequestPrincipal> = {}) =>
    ({
      tenantId: TENANT_A,
      allowCrossTenant: false,
      authenticated: true,
      userId: 'user-a',
      permissions: [slug('create'), slug('update')],
      ...overrides,
    }) as APIRequestPrincipal;
  return {
    a: ofA(),
    tenantless: ofA({ tenantId: null }),
    anonymousOfB: {
      tenantId: TENANT_B,
      allowCrossTenant: false,
      authenticated: false,
    },
    reader: { tenantId: null, allowCrossTenant: true, authenticated: true },
    anonymous: null,
  };
}

describe('a host-resolved principal against an ambient tenancy context', () => {
  let db: DatabaseInterface;
  let notes: EnforcedNoteCollection;
  let boards: EnforcedBoardCollection;
  let source: TenantPolicySource | undefined;
  let hooks: Array<{ authenticated: boolean }>;
  const exposureTenants: Array<string | undefined> = [];

  const config = (overrides: Partial<APIConfig> = {}): APIConfig => {
    const known = principals();
    return {
      basePath: '/api',
      resolvePrincipal: (req) => known[req.headers.get('x-as') ?? ''] ?? null,
      onRequest: (principal) => {
        hooks.push({ authenticated: principal.authenticated });
        return undefined;
      },
      ...overrides,
    };
  };
  const serve = (overrides: Partial<APIConfig> = {}) => {
    const api = new APIGenerator(config(overrides), { db });
    api.registerCollection('notes', notes as never);
    api.registerCollection('boards', boards as never);
    return api.generateHandler();
  };
  const call = (
    handler: (req: Request) => Promise<Response>,
    method: string,
    path: string,
    as?: string,
    body?: unknown,
  ) =>
    handler(
      new Request(`http://local/api/${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(as ? { 'x-as': as } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const titlesOf = async (response: Response) =>
    ((await response.json()) as Array<{ title: string }>)
      .map((row) => row.title)
      .sort();
  const storedTitles = async () =>
    (
      await db.query(`SELECT title FROM ${notes.tableName} ORDER BY title`)
    ).rows.map((row) => row.title as string);

  beforeAll(async () => {
    ObjectRegistry.registerCollection(
      'EnforcedNote',
      EnforcedNoteCollection as never,
    );
    ObjectRegistry.registerCollection(
      'EnforcedBoard',
      EnforcedBoardCollection as never,
    );
    ObjectRegistry.register(EnforcedNoteCollection as never, {});
    ObjectRegistry.getMethods('EnforcedNoteCollection').clear();
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['EnforcedNote', 'EnforcedBoard'],
    });
    notes = await EnforcedNoteCollection.create({ db });
    boards = await EnforcedBoardCollection.create({ db });
    enableTenancy();
    source = getTenantPolicySource();
    setRuntimeExposureGate({
      isEnabled: (_model, context) => {
        exposureTenants.push(context.tenantId ?? undefined);
        return true;
      },
    });
  });

  afterAll(async () => {
    setRuntimeExposureGate(undefined);
    disableTenancy();
    await db?.close?.();
  });

  beforeEach(async () => {
    hooks = [];
    probed = undefined;
    probeWork = undefined;
    exposureTenants.length = 0;
    setTenantPolicySource(source);
    await withSystemContext(async () => {
      await db.query(`DELETE FROM ${notes.tableName}`);
      await db.query(`DELETE FROM ${boards.tableName}`);
      for (const [title, owner] of [
        ['a', TENANT_A],
        ['b', TENANT_B],
        ['global', null],
      ] as const) {
        await notes.create({ title, tenantId: owner } as never);
        await boards.create({ title, tenantId: owner } as never);
      }
    });
  });

  afterEach(() => {
    setTenantPolicySource(source);
  });

  it('an ambient system context does not widen a host-resolved principal', async () => {
    const api = serve();
    const baseline = await titlesOf(await call(api, 'GET', 'notes', 'a'));
    expect(baseline).toContain('a');
    expect(baseline).not.toContain('b');

    const inSystem = await withSystemContext(() =>
      call(api, 'GET', 'notes', 'a'),
    );
    expect(inSystem.status).toBe(200);
    expect(await titlesOf(inSystem)).toEqual(baseline);

    expect(
      (await withSystemContext(() => call(api, 'GET', 'notes/probe', 'a')))
        .status,
    ).toBe(200);
    expect(probed).toMatchObject({ system: null, tenantId: TENANT_A });

    const created = await withSystemContext(() =>
      call(api, 'POST', 'notes', 'a', { title: 'from-system' }),
    );
    expect(created.status).toBe(201);
    const owner = await db.query(
      `SELECT tenant_id FROM ${notes.tableName} WHERE title = ?`,
      ['from-system'],
    );
    expect(owner.rows[0]?.tenant_id).toBe(TENANT_A);

    // Without `resolvePrincipal` the ambient system context still decides,
    // as released.
    const legacy = new APIGenerator(
      {
        basePath: '/api',
        authMiddleware: () => async (req) => req,
        resolveTenant: () => ({ authenticated: true }),
      },
      { db },
    );
    legacy.registerCollection('notes', notes as never);
    const legacyHandler = legacy.generateHandler();
    expect(
      (await withSystemContext(() => call(legacyHandler, 'GET', 'notes/probe')))
        .status,
    ).toBe(200);
    expect(probed).toMatchObject({ system: 'write' });
  });

  it('an ambient context must agree and is never adopted', async () => {
    const api = serve();
    // Another tenant: refused before anything is written.
    for (const [method, path, body] of [
      ['GET', 'notes', undefined],
      ['POST', 'notes', { title: 'into-b' }],
    ] as const) {
      const refused = await withTenant({ tenantId: TENANT_B }, () =>
        call(api, method, path, 'a', body),
      );
      expect(refused.status).toBe(403);
    }
    // The same tenant, another user.
    const otherUser = await withTenant(
      { tenantId: TENANT_A, userId: 'someone-else' },
      () => call(api, 'GET', 'notes', 'a'),
    );
    expect(otherUser.status).toBe(403);
    expect(await storedTitles()).toEqual(['a', 'b', 'global']);

    // The same tenant and user, with wider permissions and the bypass flag:
    // served, with the principal's permissions and no bypass.
    const agreeing = await withTenant(
      {
        tenantId: TENANT_A,
        userId: 'user-a',
        permissions: new Set([slug('delete'), slug('create')]),
        superAdminBypass: true,
      },
      () => call(api, 'GET', 'notes/probe', 'a'),
    );
    expect(agreeing.status).toBe(200);
    expect(probed).toMatchObject({
      tenantId: TENANT_A,
      userId: 'user-a',
      bypass: false,
      permissions: [slug('create'), slug('update')].sort(),
      contextBypass: false,
    });
    const deleteAttempt = await withTenant(
      {
        tenantId: TENANT_A,
        userId: 'user-a',
        permissions: new Set([slug('delete')]),
      },
      async () => {
        const [row] = await notes.list({ where: { title: 'a' } });
        return call(api, 'DELETE', `notes/${row?.id}`, 'a');
      },
    );
    expect(deleteAttempt.status).toBe(403);
    expect(await storedTitles()).toEqual(['a', 'b', 'global']);

    // An anonymous principal inside a tenant: refused, and never signed in.
    const anonymous = await withTenant({ tenantId: TENANT_A }, () =>
      call(api, 'GET', 'boards'),
    );
    expect(anonymous.status).toBe(403);
    expect(hooks.at(-1)).toEqual({ authenticated: false });
  });

  it('a tenantless principal inside a tenant context is refused', async () => {
    const api = serve();
    // No ambient context: rows without an owner only.
    expect(
      await titlesOf(await call(api, 'GET', 'notes', 'tenantless')),
    ).toEqual(['global']);
    exposureTenants.length = 0;
    for (const [method, path, body] of [
      ['GET', 'notes', undefined],
      ['GET', 'notes/count', undefined],
      ['POST', 'notes', { title: 'adopted' }],
      ['GET', '_changes?since=0', undefined],
    ] as const) {
      const refused = await withTenant({ tenantId: TENANT_B }, () =>
        call(api, method, path, 'tenantless', body),
      );
      expect(refused.status, `${method} ${path}`).toBe(403);
    }
    expect(exposureTenants).not.toContain(TENANT_B);
    expect(await storedTitles()).toEqual(['a', 'b', 'global']);

    // A host that enters a tenant for anonymous visitors names it instead.
    const named = await withTenant({ tenantId: TENANT_B }, () =>
      call(api, 'GET', 'boards', 'anonymousOfB'),
    );
    expect(named.status).toBe(200);
    const served = await titlesOf(named);
    expect(served).toContain('b');
    expect(served).not.toContain('a');
  });

  it('the request context is entered through the source, with a defined fallback', async () => {
    const api = serve();
    expect((await call(api, 'GET', 'notes/probe', 'a')).status).toBe(200);
    expect(probed).toMatchObject({
      contextTenant: TENANT_A,
      contextFrozen: true,
      contextBypass: false,
      contextPermissionsAreSet: false,
    });

    // A source without `runForPrincipal` (an older tenancy copy).
    const { runForPrincipal: _omitted, ...older } =
      source as TenantPolicySource & { runForPrincipal?: unknown };
    setTenantPolicySource(older as TenantPolicySource);
    expect((await call(api, 'GET', 'notes/probe', 'a')).status).toBe(200);
    expect(probed).toMatchObject({ tenantId: TENANT_A, system: null });
    const insideSystem = await withSystemContext(() =>
      call(api, 'GET', 'notes', 'a'),
    );
    expect(insideSystem.status).toBe(403);
  });

  it('a read grant keeps refusing writes in nested dispatch and sync items', async () => {
    const api = serve();
    const nested = serve();
    probeWork = async () => {
      const write = await call(nested, 'POST', 'notes', 'a', {
        title: 'nested-write',
      });
      const sync = await call(nested, 'POST', 'sync/apply', 'a', {
        items: [
          {
            itemId: 'one',
            object: 'notes',
            op: 'create',
            id: 'cccccccc-5195-4000-8000-00000000000c',
            payload: { title: 'synced' },
          },
        ],
      });
      return {
        write: write.status,
        sync: ((await sync.json()) as { results: Array<{ status: string }> })
          .results[0]?.status,
      };
    };
    const read = await call(api, 'GET', 'notes/probe', 'reader');
    expect(read.status).toBe(200);
    expect(probed?.work).toEqual({ write: 403, sync: 'rejected' });
    expect(await storedTitles()).toEqual(['a', 'b', 'global']);
  });
});
