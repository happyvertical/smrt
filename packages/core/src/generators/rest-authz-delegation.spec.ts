/**
 * The runtime REST handler decides authentication, `api.public`,
 * `<collection>.<action>` permission and tenant through the shared decision
 * module (`route-authz.ts`) at every call site (#5195, slice 3).
 *
 * The module is wrapped, not replaced: each decision is the module's own, and
 * the test reads which calls the handler made. Without `resolvePrincipal` the
 * server keeps its fixed principal and `authMiddleware` decides alone, so the
 * shared decision is not consulted.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { field } from '../decorators/index.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { getTestDatabase } from '../testing/database.js';
import {
  type APIConfig,
  APIGenerator,
  type APIRequestPrincipal,
} from './rest.js';

const decisions = vi.hoisted(() => ({
  authorize: [] as Array<Record<string, unknown>>,
  strip: [] as Array<{ columns: string[]; where: unknown }>,
}));

vi.mock('./route-authz.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./route-authz.js')>();
  return {
    ...actual,
    authorize: (input: Parameters<typeof actual.authorize>[0]) => {
      decisions.authorize.push({ ...input });
      return actual.authorize(input);
    },
    stripTenantFilters: (
      ...args: Parameters<typeof actual.stripTenantFilters>
    ) => {
      decisions.strip.push({ columns: [...args[1]], where: args[2] });
      return actual.stripTenantFilters(...args);
    },
  };
});

const TENANT_A = 'a0000000-0000-4000-8000-00000000000a';
const TENANT_B = 'b0000000-0000-4000-8000-00000000000b';

@smrt({
  tenantScoped: { mode: 'optional', autoPopulate: false },
  api: {
    include: ['list', 'get', 'create', 'update', 'delete', 'archive', 'tally'],
    routes: {
      archive: { method: 'POST', scope: 'collection' },
      tally: { method: 'GET', scope: 'collection' },
    },
  },
})
class AuthzNote extends SmrtObject {
  @field({ type: 'text' })
  title = '';

  tenantId: string | null = null;
}

class AuthzNoteCollection extends SmrtCollection<AuthzNote> {
  static readonly _itemClass = AuthzNote;

  async archive(): Promise<{ archived: boolean }> {
    return { archived: true };
  }

  async tally(): Promise<{ count: number }> {
    return { count: await this.count({}) };
  }
}

/** Opens every operation to anyone. */
@smrt({ api: { public: true, include: ['list', 'get', 'create'] } })
class AuthzOpen extends SmrtObject {
  @field({ type: 'text' })
  title = '';
}
class AuthzOpenCollection extends SmrtCollection<AuthzOpen> {
  static readonly _itemClass = AuthzOpen;
}

const keyOf = (name: string) => {
  const info = ObjectRegistry.getClass(name);
  if (!info) throw new Error(`fixture not registered: ${name}`);
  return info.qualifiedName || info.name;
};
const segmentOf = (name: string) =>
  ObjectRegistry.getClass(name)?.collection as string;
const slug = (name: string, action: string) =>
  `${ObjectRegistry.getConfig(keyOf(name)).collection ?? segmentOf(name)}.${action}`;

const signedIn = (permissions: string[]): APIRequestPrincipal => ({
  tenantId: TENANT_A,
  allowCrossTenant: false,
  authenticated: true,
  userId: 'user-a',
  permissions,
});

function known(): Record<string, APIRequestPrincipal> {
  const writes = ['create', 'update', 'delete', 'archive'].map((action) =>
    slug('AuthzNote', action),
  );
  return {
    writer: signedIn(writes),
    reader: signedIn([]),
    guest: {
      tenantId: TENANT_A,
      allowCrossTenant: false,
      authenticated: false,
    },
    operator: {
      tenantId: null,
      allowCrossTenant: true,
      authenticated: true,
      permissions: writes,
    },
  };
}

/** The decisions made for `op`, without the principal. */
const forOp = (op: string) => decisions.authorize.filter((d) => d.op === op);

describe('runtime REST decides through route-authz', () => {
  let db: DatabaseInterface;
  let notes: AuthzNoteCollection;
  let principals: Record<string, APIRequestPrincipal>;

  const handler = (config: APIConfig = {}) =>
    new APIGenerator(
      {
        basePath: '/api',
        resolvePrincipal: (req) =>
          principals[req.headers.get('x-principal') ?? ''] ?? null,
        ...config,
      },
      { db },
    ).generateHandler();
  const send = (
    target: (req: Request) => Promise<Response>,
    as: string | undefined,
    method: string,
    path: string,
    body?: unknown,
  ) =>
    target(
      new Request(`http://local/api/${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(as ? { 'x-principal': as } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const note = () => segmentOf('AuthzNote');
  const seed = async (title: string, tenantId: string | null) =>
    (await notes.create({ title, tenantId } as never)).id as string;

  beforeEach(async () => {
    ObjectRegistry.registerCollection(
      'AuthzNote',
      AuthzNoteCollection as never,
    );
    ObjectRegistry.registerCollection(
      'AuthzOpen',
      AuthzOpenCollection as never,
    );
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['AuthzNote', 'AuthzOpen'],
    });
    notes = await AuthzNoteCollection.create({ db });
    principals = known();
    decisions.authorize.length = 0;
    decisions.strip.length = 0;
  });
  afterEach(async () => {
    await db?.close?.();
  });

  describe('object CRUD', () => {
    it('decides create, update and delete with the operation and the write body', async () => {
      const api = handler();
      const id = await seed('first', TENANT_A);
      decisions.authorize.length = 0;

      expect(
        (await send(api, 'writer', 'POST', note(), { title: 'x' })).status,
      ).toBe(201);
      expect(
        (await send(api, 'writer', 'PUT', `${note()}/${id}`, { title: 'y' }))
          .status,
      ).toBe(200);
      expect(
        (await send(api, 'writer', 'DELETE', `${note()}/${id}`)).status,
      ).toBe(204);

      const create = forOp('create').find((d) => d.body !== undefined);
      expect(create).toMatchObject({
        op: 'create',
        publicAccess: false,
        body: { title: 'x' },
      });
      expect(forOp('update').some((d) => d.body !== undefined)).toBe(true);
      expect(forOp('delete')).not.toHaveLength(0);
      const collection = (
        ObjectRegistry.getConfig(keyOf('AuthzNote')) as {
          collection?: string;
        }
      ).collection;
      expect(create?.permissionCollection).toBe(collection ?? note());
    });

    it('refuses by the module’s order: sign-in, permission, then tenant', async () => {
      const api = handler();
      // Not signed in beats everything, with the code the generated routes
      // answer with.
      const unsigned = await send(api, 'guest', 'POST', note(), {
        title: 'x',
        tenantId: TENANT_B,
      });
      expect(unsigned.status).toBe(401);
      expect(
        ((await unsigned.json()) as { error: { code: string } }).error.code,
      ).toBe('AUTHENTICATION_REQUIRED');
      // Signed in without the permission: 403 PERMISSION_DENIED before the body
      // is looked at.
      const denied = await send(api, 'reader', 'POST', note(), {
        title: 'x',
        tenantId: TENANT_B,
      });
      expect(denied.status).toBe(403);
      expect(
        ((await denied.json()) as { error: { code: string } }).error.code,
      ).toBe('PERMISSION_DENIED');
      // Permitted, naming another tenant: 403 TENANT_MISMATCH.
      const mismatch = await send(api, 'writer', 'POST', note(), {
        title: 'x',
        tenantId: TENANT_B,
      });
      expect(mismatch.status).toBe(403);
      expect(
        ((await mismatch.json()) as { error: { code: string } }).error.code,
      ).toBe('TENANT_MISMATCH');
    });

    it('opens an api.public model to an anonymous caller through the same decision', async () => {
      const api = handler();
      const open = segmentOf('AuthzOpen');
      expect(
        (await send(api, undefined, 'POST', open, { title: 'x' })).status,
      ).toBe(201);
      expect(decisions.authorize.some((d) => d.publicAccess === true)).toBe(
        true,
      );
    });

    it('strips tenant filters on a read through stripTenantFilters', async () => {
      const api = handler();
      await seed('a', TENANT_A);
      await seed('b', TENANT_B);
      const response = await send(
        api,
        'writer',
        'GET',
        `${note()}?tenantId=${TENANT_B}`,
      );
      expect(response.status).toBe(200);
      expect(decisions.strip).not.toHaveLength(0);
      expect(decisions.strip.some((s) => s.columns.includes('tenant_id'))).toBe(
        true,
      );
    });
  });

  describe('custom actions', () => {
    it('decides a mutating action by its name and leaves a read action open', async () => {
      const api = handler();
      expect(
        (await send(api, 'reader', 'POST', `${note()}/archive`, {})).status,
      ).toBe(403);
      expect(forOp('archive')).toMatchObject([
        { op: 'archive', mutating: true },
      ]);
      expect(
        (await send(api, 'writer', 'POST', `${note()}/archive`, {})).status,
      ).toBe(200);
      decisions.authorize.length = 0;
      expect((await send(api, 'reader', 'GET', `${note()}/tally`)).status).toBe(
        200,
      );
      // A read action needs no permission.
      expect(forOp('tally').every((d) => d.mutating !== true)).toBe(true);
    });
  });

  describe('sync/apply', () => {
    it('decides each item on its own, with its operation and payload', async () => {
      const api = handler();
      const existing = await seed('existing', TENANT_A);
      decisions.authorize.length = 0;
      principals.creator = signedIn([slug('AuthzNote', 'create')]);
      const response = await send(api, 'creator', 'POST', 'sync/apply', {
        items: [
          {
            itemId: 'c',
            object: note(),
            op: 'create',
            id: 'c0000000-0000-4000-8000-000000000001',
            payload: { title: 'synced' },
          },
          { itemId: 'd', object: note(), op: 'delete', id: existing },
        ],
      });
      const { results } = (await response.json()) as {
        results: Array<{ status: string; reason?: string }>;
      };
      expect(results).toEqual([
        expect.objectContaining({ status: 'applied' }),
        expect.objectContaining({ status: 'rejected', reason: 'forbidden' }),
      ]);
      expect(forOp('create').length).toBeGreaterThan(0);
      expect(forOp('delete').length).toBeGreaterThan(0);
      expect(
        forOp('create').some(
          (d) => (d.body as { title?: string } | undefined)?.title === 'synced',
        ),
      ).toBe(true);
    });

    it('rejects an item naming another tenant with its own reason, and applies the rest', async () => {
      const api = handler();
      const response = await send(api, 'writer', 'POST', 'sync/apply', {
        items: [
          {
            itemId: 'bad',
            object: note(),
            op: 'create',
            id: 'c0000000-0000-4000-8000-000000000002',
            payload: { title: 'x', tenantId: TENANT_B },
          },
          {
            itemId: 'ok',
            object: note(),
            op: 'create',
            id: 'c0000000-0000-4000-8000-000000000003',
            payload: { title: 'y' },
          },
        ],
      });
      const { results } = (await response.json()) as {
        results: Array<{ itemId: string; status: string; reason?: string }>;
      };
      expect(results).toEqual([
        expect.objectContaining({
          itemId: 'bad',
          status: 'rejected',
          reason: 'forbidden',
        }),
        expect.objectContaining({ itemId: 'ok', status: 'applied' }),
      ]);
    });
  });

  describe('change feeds', () => {
    it('admits _changes and _events only to a signed-in principal, through the decision', async () => {
      const api = handler();
      for (const route of ['_changes', '_events']) {
        expect((await send(api, 'guest', 'GET', route)).status).toBe(401);
      }
      expect(decisions.authorize.length).toBeGreaterThanOrEqual(2);
      expect(decisions.authorize.every((d) => d.publicAccess === false)).toBe(
        true,
      );
      expect(
        (await send(api, 'reader', 'GET', '_changes?since=0')).status,
      ).toBe(200);
    });
  });

  describe('authMiddleware', () => {
    it('is an extra check on top of the decision, never in its place', async () => {
      const admitsAll = handler({ authMiddleware: () => async (req) => req });
      // The shared decision still refuses an unsigned caller, and a missing
      // permission, whatever the middleware admits.
      expect((await send(admitsAll, 'guest', 'GET', note())).status).toBe(401);
      expect(
        (await send(admitsAll, 'reader', 'POST', note(), { title: 'x' }))
          .status,
      ).toBe(403);
      // And it can still refuse what the decision admits, including on an
      // api.public model.
      const refusesAll = handler({
        authMiddleware: () => async () =>
          new Response('blocked', { status: 403 }),
      });
      expect(
        (await send(refusesAll, 'writer', 'GET', segmentOf('AuthzOpen')))
          .status,
      ).toBe(403);
    });

    it('keeps deciding alone when the host resolves no principal', async () => {
      const api = new APIGenerator(
        { basePath: '/api', authMiddleware: () => async (req) => req },
        { db },
      ).generateHandler();
      decisions.authorize.length = 0;
      const response = await send(api, undefined, 'POST', note(), {
        title: 'x',
      });
      expect(response.status).toBe(201);
      expect(decisions.authorize).toHaveLength(0);
    });
  });
});
