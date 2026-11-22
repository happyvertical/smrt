/**
 * Runtime REST acts for the principal its host resolves for a request
 * (`APIConfig.resolvePrincipal`), and nothing in the request widens it.
 *
 * - Sign-in follows `authenticated` and the model's `api.public`.
 * - Create, update, delete, a mutating custom action and each sync item need
 *   `<collection>.<action>`; a row of a subtype needs its own model's slug.
 *   A missing permission is 403 `PERMISSION_DENIED`.
 * - A write body naming another tenant is 403 `TENANT_MISMATCH`; a query
 *   filter on the tenant is removed unless the principal is cross-tenant.
 * - The principal is resolved once per request, sync batches included.
 * - `onRequest` sees each request and each sync item, and may answer it;
 *   an answer for a sync item rejects that item only.
 * - `_changes` and `_events` read in the principal's tenant.
 * - Without `resolvePrincipal`, behaviour is unchanged.
 *
 * Runs on SQLite, and on PostgreSQL when `SMRT_TEST_POSTGRES_URL` is set.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { field } from '../decorators/index.js';
import { setDispatchTenantResolver } from '../dispatch/tenant-resolver.js';
import { normalizeRequestPrincipal } from '../generators/request-principal.js';
import {
  type APIConfig,
  APIGenerator,
  type APIRequestInfo,
  type APIRequestPrincipal,
} from '../generators/rest.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { getResolvedTenancy } from '../request-tenancy.js';
import { setRequestTenantContextHooks } from '../request-tenant-context.js';
import { getTestDatabase } from '../testing/database.js';

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
class PrincipalNote extends SmrtObject {
  @field({ type: 'text' })
  title = '';

  @field({ type: 'text', readPermission: 'principalnotes.read.secret' })
  secret = '';

  tenantId: string | null = null;
}
/** What a test runs inside the `archive` action, when set. */
let archiveProbe: (() => void) | undefined;

class PrincipalNoteCollection extends SmrtCollection<PrincipalNote> {
  static readonly _itemClass = PrincipalNote;

  async archive(): Promise<{ archived: boolean }> {
    archiveProbe?.();
    return { archived: true };
  }

  async tally(): Promise<{ count: number }> {
    return { count: await this.count({}) };
  }
}

/** Readable by anyone; writes need a signed-in caller. */
@smrt({ api: { public: 'read', include: ['list', 'get', 'create'] } })
class PrincipalBulletin extends SmrtObject {
  @field({ type: 'text' })
  title = '';
}

/** A super-admin bypass stands in for permissions on this model only. */
@smrt({
  tenantScoped: {
    mode: 'optional',
    autoPopulate: false,
    allowSuperAdminBypass: true,
  },
  api: { include: ['list', 'get', 'create'] },
})
class PrincipalLedger extends SmrtObject {
  @field({ type: 'text' })
  title = '';

  tenantId: string | null = null;
}
class PrincipalLedgerCollection extends SmrtCollection<PrincipalLedger> {
  static readonly _itemClass = PrincipalLedger;
}
class PrincipalBulletinCollection extends SmrtCollection<PrincipalBulletin> {
  static readonly _itemClass = PrincipalBulletin;
}

@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
})
class PrincipalDoc extends SmrtObject {
  @field({ type: 'text' })
  title = '';
}
class PrincipalDocCollection extends SmrtCollection<PrincipalDoc> {
  static readonly _itemClass = PrincipalDoc;
}

/** A subtype with permission slugs of its own. */
@smrt({
  collection: 'principalsecretdocs',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
})
class PrincipalSecretDoc extends PrincipalDoc {
  @field({ type: 'text' })
  note = '';
}

const CLASSES = [
  'PrincipalNote',
  'PrincipalBulletin',
  'PrincipalLedger',
  'PrincipalDoc',
  'PrincipalSecretDoc',
];

const keyOf = (name: string) => {
  const info = ObjectRegistry.getClass(name);
  if (!info) throw new Error(`fixture not registered: ${name}`);
  return info.qualifiedName || info.name;
};
const segmentOf = (name: string) =>
  ObjectRegistry.getClass(name)?.collection as string;
const slug = (name: string, action: string) =>
  `${ObjectRegistry.getConfig(keyOf(name)).collection ?? segmentOf(name)}.${action}`;

/** Principals the test host knows, by the `x-principal` header. */
function principals(): Record<string, APIRequestPrincipal> {
  const signedIn = (permissions: string[]): APIRequestPrincipal => ({
    tenantId: TENANT_A,
    allowCrossTenant: false,
    authenticated: true,
    userId: 'user-a',
    callerKind: 'user',
    permissions,
  });
  const noteWrites = ['create', 'update', 'delete', 'archive'].map((action) =>
    slug('PrincipalNote', action),
  );
  return {
    writer: signedIn([
      ...noteWrites,
      slug('PrincipalBulletin', 'create'),
      slug('PrincipalDoc', 'update'),
      slug('PrincipalSecretDoc', 'update'),
    ]),
    reader: signedIn([]),
    creator: signedIn([
      slug('PrincipalNote', 'create'),
      slug('PrincipalNote', 'update'),
    ]),
    docEditor: signedIn([slug('PrincipalDoc', 'update')]),
    secretReader: signedIn(['principalnotes.read.secret']),
    guest: {
      tenantId: TENANT_A,
      allowCrossTenant: false,
      authenticated: false,
    },
    bypass: {
      tenantId: TENANT_A,
      allowCrossTenant: false,
      authenticated: true,
      superAdminBypass: true,
    },
    operator: {
      tenantId: null,
      allowCrossTenant: true,
      authenticated: true,
      permissions: noteWrites,
    },
    tenantless: {
      tenantId: null,
      allowCrossTenant: false,
      authenticated: true,
      permissions: noteWrites,
    },
    ofB: { ...signedIn(noteWrites), tenantId: TENANT_B },
  };
}

interface Rows {
  results: Array<{ status: string; reason?: string }>;
}

const SNAPSHOT_FIELDS = [
  'tenantId',
  'userId',
  'authenticated',
  'callerKind',
  'allowCrossTenant',
  'superAdminBypass',
  'permissions',
] as const;

describe('the principal a host resolves is read once into a snapshot', () => {
  const valid = {
    tenantId: TENANT_A,
    userId: 'user-a',
    authenticated: true,
    callerKind: 'user',
    allowCrossTenant: false,
    superAdminBypass: false,
    permissions: ['notes.create'],
  };

  it('each own property is read exactly once', () => {
    // Data properties.
    const fromData = normalizeRequestPrincipal({ ...valid });
    expect(fromData.tenantId).toBe(TENANT_A);
    expect([...fromData.permissions]).toEqual(['notes.create']);

    // Accessors: each runs once, and its first value is the one used.
    const reads = new Map<string, number>();
    const accessors: Record<string, unknown> = {};
    for (const key of SNAPSHOT_FIELDS) {
      Object.defineProperty(accessors, key, {
        enumerable: true,
        get() {
          const count = (reads.get(key) ?? 0) + 1;
          reads.set(key, count);
          // A second read would see another tenant and a wider grant.
          if (count > 1) {
            if (key === 'tenantId') return TENANT_B;
            if (key === 'allowCrossTenant') return true;
            if (key === 'permissions') return ['notes.create', 'notes.delete'];
          }
          return valid[key];
        },
      });
    }
    const fromAccessors = normalizeRequestPrincipal(accessors);
    expect(Object.fromEntries(reads)).toEqual(
      Object.fromEntries(SNAPSHOT_FIELDS.map((key) => [key, 1])),
    );
    expect(fromAccessors.tenantId).toBe(TENANT_A);
    expect(fromAccessors.allowCrossTenant).toBe(false);
    expect([...fromAccessors.permissions]).toEqual(['notes.create']);

    // A proxy: one trap per field, whatever traps it counts.
    const traps = new Map<string, number>();
    const count = (key: PropertyKey) => {
      if (typeof key !== 'string') return;
      traps.set(key, (traps.get(key) ?? 0) + 1);
    };
    const proxy = new Proxy(
      { ...valid },
      {
        get(target, key, receiver) {
          count(key);
          return Reflect.get(target, key, receiver);
        },
        getOwnPropertyDescriptor(target, key) {
          count(key);
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
        has(target, key) {
          count(key);
          return Reflect.has(target, key);
        },
      },
    );
    const fromProxy = normalizeRequestPrincipal(proxy);
    expect(fromProxy.userId).toBe('user-a');
    for (const key of SNAPSHOT_FIELDS) {
      expect(traps.get(key) ?? 0, key).toBeLessThanOrEqual(1);
    }

    // An accessor whose first value is invalid is refused, never retried.
    let tenantReads = 0;
    const flaky = {
      ...valid,
      get tenantId() {
        tenantReads += 1;
        return tenantReads === 1 ? 42 : TENANT_A;
      },
    };
    expect(() => normalizeRequestPrincipal(flaky)).toThrow(TypeError);
    expect(tenantReads).toBe(1);
  });

  it('only own properties of the answer are read', () => {
    const inherited = Object.create({
      allowCrossTenant: true,
      userId: 'someone-else',
      permissions: ['notes.delete'],
      superAdminBypass: true,
    }) as Record<string, unknown>;
    inherited.tenantId = TENANT_A;
    inherited.authenticated = true;
    const proto = Object.prototype as Record<string, unknown>;
    proto.allowCrossTenant = true;
    proto.permissions = ['notes.delete'];
    try {
      const snapshot = normalizeRequestPrincipal(inherited);
      expect(snapshot.tenantId).toBe(TENANT_A);
      expect(snapshot.allowCrossTenant).toBe(false);
      expect(snapshot.superAdminBypass).toBe(false);
      expect(snapshot.userId).toBeNull();
      expect([...snapshot.permissions]).toEqual([]);
    } finally {
      delete proto.allowCrossTenant;
      delete proto.permissions;
    }
  });

  it('an anonymous caller is an explicit principal that is not signed in', () => {
    for (const answer of [null, undefined]) {
      const snapshot = normalizeRequestPrincipal(answer);
      expect(snapshot).toMatchObject({
        tenantId: null,
        userId: null,
        authenticated: false,
        allowCrossTenant: false,
        superAdminBypass: false,
        requestScoped: false,
      });
      expect(snapshot.permissions.size).toBe(0);
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.getPrototypeOf(snapshot)).toBeNull();
    }
  });

  it('refuses a malformed answer and ignores an unknown field', () => {
    const malformed: Array<[string, unknown]> = [
      ['string permissions', { ...valid, permissions: 'notes.create' }],
      ['non-string slug', { ...valid, permissions: [1] }],
      ['slug with whitespace', { ...valid, permissions: ['notes create'] }],
      ['empty tenant id', { ...valid, tenantId: '' }],
      ['empty user id', { ...valid, userId: '' }],
      ['oversized tenant id', { ...valid, tenantId: 'x'.repeat(1000) }],
      [
        'oversized permissions',
        {
          ...valid,
          permissions: Array.from({ length: 5000 }, (_, i) => `a.${i}`),
        },
      ],
      ['non-boolean grant', { ...valid, allowCrossTenant: 'yes' }],
      ['non-boolean sign-in', { ...valid, authenticated: 1 }],
      ['non-boolean bypass', { ...valid, superAdminBypass: 'true' }],
      [
        'an own __proto__ key',
        JSON.parse(
          '{"__proto__": {"allowCrossTenant": true}, "tenantId": null, "authenticated": true}',
        ),
      ],
      ['an array', [valid]],
      ['a string', 'principal'],
    ];
    for (const [label, answer] of malformed) {
      expect(() => normalizeRequestPrincipal(answer), label).toThrow(TypeError);
    }
    const extra = normalizeRequestPrincipal({ ...valid, role: 'admin' });
    expect(extra.tenantId).toBe(TENANT_A);
    expect('role' in extra).toBe(false);
  });
});

for (const type of ['sqlite', 'postgres'] as const) {
  const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
  const suite = type === 'postgres' && !pgUrl ? describe.skip : describe;

  suite(`runtime REST with a host-resolved principal on ${type}`, () => {
    let db: DatabaseInterface;
    let notes: PrincipalNoteCollection;
    let resolutions: number;
    let known: Record<string, APIRequestPrincipal>;

    const resolvePrincipal: APIConfig['resolvePrincipal'] = (req) => {
      resolutions += 1;
      return known[req.headers.get('x-principal') ?? ''] ?? null;
    };
    const handler = (config: APIConfig = {}) =>
      new APIGenerator(
        { basePath: '/api', resolvePrincipal, ...config },
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
    const noteSegment = () => segmentOf('PrincipalNote');
    const titles = async () =>
      (
        await db.query(`SELECT title FROM ${notes.tableName} ORDER BY title`)
      ).rows.map((row) => row.title);
    const seedNote = async (
      title: string,
      tenantId: string | null,
    ): Promise<string> =>
      (await notes.create({ title, tenantId } as never)).id as string;

    beforeEach(async () => {
      ObjectRegistry.registerCollection(
        'PrincipalNote',
        PrincipalNoteCollection as never,
      );
      ObjectRegistry.registerCollection(
        'PrincipalDoc',
        PrincipalDocCollection as never,
      );
      db = await getTestDatabase({
        type,
        url: type === 'postgres' ? pgUrl : ':memory:',
        classes: CLASSES,
      });
      notes = await PrincipalNoteCollection.create({ db });
      const docs = await PrincipalDocCollection.create({ db });
      if (type === 'postgres') {
        const ledgers = await PrincipalLedgerCollection.create({ db });
        const bulletins = await PrincipalBulletinCollection.create({ db });
        for (const table of [
          notes.tableName,
          docs.tableName,
          ledgers.tableName,
          bulletins.tableName,
        ]) {
          await db.query(`DELETE FROM ${table}`);
        }
      }
      resolutions = 0;
      known = principals();
    });
    afterEach(async () => {
      setRequestTenantContextHooks(undefined);
      setDispatchTenantResolver(undefined);
      await db?.close?.();
    });

    describe('sign-in', () => {
      it('refuses an anonymous or unsigned caller on a route that is not public', async () => {
        const api = handler();
        expect((await send(api, undefined, 'GET', noteSegment())).status).toBe(
          401,
        );
        expect((await send(api, 'guest', 'GET', noteSegment())).status).toBe(
          401,
        );
        expect((await send(api, 'reader', 'GET', noteSegment())).status).toBe(
          200,
        );
      });

      it('opens the reads of a public-read model and nothing else', async () => {
        const api = handler();
        const segment = segmentOf('PrincipalBulletin');
        expect((await send(api, undefined, 'GET', segment)).status).toBe(200);
        expect(
          (await send(api, undefined, 'POST', segment, { title: 'x' })).status,
        ).toBe(401);
        expect(
          (await send(api, 'writer', 'POST', segment, { title: 'x' })).status,
        ).toBe(201);
      });

      it('keeps authMiddleware as a check on top that cannot admit an unsigned caller', async () => {
        const admitsAll = handler({ authMiddleware: () => async (req) => req });
        expect(
          (await send(admitsAll, undefined, 'GET', noteSegment())).status,
        ).toBe(401);
        const refusesAll = handler({
          authMiddleware: () => async () =>
            new Response('blocked', { status: 403 }),
        });
        expect(
          (await send(refusesAll, 'writer', 'GET', noteSegment())).status,
        ).toBe(403);
      });
    });

    describe('a malformed principal', () => {
      it('is refused before any hook', async () => {
        const seen: unknown[] = [];
        for (const answer of [
          { tenantId: TENANT_A, authenticated: true, permissions: 'x' },
          { tenantId: '', authenticated: true },
          { tenantId: TENANT_A, authenticated: 'yes' },
        ]) {
          const api = new APIGenerator(
            {
              basePath: '/api',
              resolvePrincipal: () => answer as never,
              onRequest: (principal) => {
                seen.push(principal);
                return undefined;
              },
            },
            { db },
          ).generateHandler();
          expect((await send(api, 'x', 'GET', noteSegment())).status).toBe(500);
        }
        const rejecting = new APIGenerator(
          {
            basePath: '/api',
            resolvePrincipal: async () => {
              throw new Error('session store down');
            },
            onRequest: (principal) => {
              seen.push(principal);
              return undefined;
            },
          },
          { db },
        ).generateHandler();
        expect((await send(rejecting, 'x', 'GET', noteSegment())).status).toBe(
          500,
        );
        expect(seen).toEqual([]);
      });

      it('an anonymous caller reaches onRequest as a principal that is not signed in', async () => {
        const seen: Array<{ authenticated: boolean } | null> = [];
        const api = handler({
          onRequest: (principal) => {
            seen.push(principal as { authenticated: boolean } | null);
            return undefined;
          },
        });
        expect(
          (await send(api, undefined, 'GET', segmentOf('PrincipalBulletin')))
            .status,
        ).toBe(200);
        expect((await send(api, undefined, 'GET', noteSegment())).status).toBe(
          401,
        );
        expect(seen.map((principal) => principal?.authenticated)).toEqual([
          false,
          false,
        ]);
      });
    });

    describe('a read-only principal', () => {
      afterEach(() => {
        archiveProbe = undefined;
      });

      /** Try every mutator on a permission view; returns what happened. */
      const tryMutations = (
        view: ReadonlySet<string> | undefined,
        extra: string,
      ): string[] => {
        const mutable = view as unknown as Set<string>;
        const outcomes: string[] = [];
        for (const [name, attempt] of [
          ['add', () => mutable.add(extra)],
          ['delete', () => mutable.delete([...(view ?? [])][0] ?? extra)],
          ['clear', () => mutable.clear()],
          ['Set.prototype.add', () => Set.prototype.add.call(view, extra)],
          ['Set.prototype.clear', () => Set.prototype.clear.call(view)],
        ] as const) {
          try {
            attempt();
            outcomes.push(`${name}: changed`);
          } catch {
            outcomes.push(`${name}: refused`);
          }
        }
        return outcomes;
      };
      const allRefused = [
        'add: refused',
        'delete: refused',
        'clear: refused',
        'Set.prototype.add: refused',
        'Set.prototype.clear: refused',
      ];
      /** Every way of reading a set, as one comparable record. */
      const readAll = (view: ReadonlySet<string>) => {
        const forEachEntries: string[] = [];
        let collectionArg: unknown;
        view.forEach((value, _key, collection) => {
          forEachEntries.push(value);
          collectionArg = collection;
        });
        const iterated: string[] = [];
        for (const value of view) iterated.push(value);
        return {
          size: view.size,
          spread: [...view].sort(),
          iterated: iterated.sort(),
          forEach: forEachEntries.sort(),
          collectionIsView: collectionArg === view,
        };
      };

      it('a hook cannot add a permission, and reading is unchanged', async () => {
        const createSlug = slug('PrincipalNote', 'create');
        const hookOutcomes: string[][] = [];
        const hookReads: unknown[] = [];
        const api = handler({
          onRequest: (principal) => {
            const view = principal?.permissions as ReadonlySet<string>;
            hookOutcomes.push(tryMutations(view, createSlug));
            hookReads.push(readAll(view));
            return undefined;
          },
        });
        // The reader holds no permission; its hook tries to add one.
        const created = await send(api, 'reader', 'POST', noteSegment(), {
          title: 'new',
        });
        expect(created.status).toBe(403);
        expect(hookOutcomes).toEqual([allRefused]);
        expect(hookReads).toEqual([
          {
            size: 0,
            spread: [],
            iterated: [],
            forEach: [],
            collectionIsView: false,
          },
        ]);

        // An action reads the bound actor's permissions and tries the same.
        let actorOutcomes: string[] = [];
        let actorReads: unknown;
        archiveProbe = () => {
          const view = getResolvedTenancy()?.actor
            .permissions as ReadonlySet<string>;
          actorOutcomes = tryMutations(view, slug('PrincipalNote', 'delete'));
          actorReads = readAll(view);
        };
        const writer = principals().writer;
        const expected = [...(writer.permissions as string[])].sort();
        const archived = await send(
          api,
          'writer',
          'POST',
          `${noteSegment()}/archive`,
          {},
        );
        expect(archived.status).toBe(200);
        expect(actorOutcomes).toEqual(allRefused);
        expect(actorReads).toEqual({
          size: expected.length,
          spread: expected,
          iterated: expected,
          forEach: expected,
          collectionIsView: true,
        });
        expect(hookReads[1]).toEqual(actorReads);
        // Still refused after both attempts.
        expect(
          (
            await send(api, 'reader', 'POST', noteSegment(), {
              title: 'again',
            })
          ).status,
        ).toBe(403);
        expect(await titles()).toEqual([]);
      });
    });

    describe('operation permissions', () => {
      it('refuses create, update and delete without the permission', async () => {
        const api = handler();
        const id = await seedNote('kept', TENANT_A);
        const created = await send(api, 'reader', 'POST', noteSegment(), {
          title: 'new',
        });
        expect(created.status).toBe(403);
        expect(await created.json()).toMatchObject({
          error: { code: 'PERMISSION_DENIED', status: 403 },
        });
        expect(
          (
            await send(api, 'reader', 'PUT', `${noteSegment()}/${id}`, {
              title: 'changed',
            })
          ).status,
        ).toBe(403);
        expect(
          (await send(api, 'reader', 'DELETE', `${noteSegment()}/${id}`))
            .status,
        ).toBe(403);
        expect(await titles()).toEqual(['kept']);
      });

      it('allows create, update and delete with the permission', async () => {
        const api = handler();
        expect(
          (await send(api, 'writer', 'POST', noteSegment(), { title: 'new' }))
            .status,
        ).toBe(201);
        const id = await seedNote('old', TENANT_A);
        expect(
          (
            await send(api, 'writer', 'PUT', `${noteSegment()}/${id}`, {
              title: 'renamed',
            })
          ).status,
        ).toBe(200);
        expect(await titles()).toEqual(['new', 'renamed']);
        expect(
          (await send(api, 'writer', 'DELETE', `${noteSegment()}/${id}`))
            .status,
        ).toBe(204);
        expect(await titles()).toEqual(['new']);
      });

      it('refuses a mutating custom action without its permission and serves a read action', async () => {
        const api = handler();
        const refused = await send(
          api,
          'reader',
          'POST',
          `${noteSegment()}/archive`,
        );
        expect(refused.status).toBe(403);
        expect(await refused.json()).toMatchObject({
          error: { code: 'PERMISSION_DENIED' },
        });
        const allowed = await send(
          api,
          'writer',
          'POST',
          `${noteSegment()}/archive`,
        );
        expect(allowed.status).toBe(200);
        expect(await allowed.json()).toEqual({
          action: 'archive',
          result: { archived: true },
        });
        expect(
          (await send(api, 'reader', 'GET', `${noteSegment()}/tally`)).status,
        ).toBe(200);
      });

      it('refuses only the sync items whose permission is missing', async () => {
        const api = handler();
        const existing = await seedNote('existing', TENANT_A);
        const response = await send(api, 'creator', 'POST', 'sync/apply', {
          items: [
            {
              itemId: 'create',
              object: noteSegment(),
              op: 'create',
              id: 'c0000000-0000-4000-8000-000000000001',
              payload: { title: 'synced' },
            },
            {
              itemId: 'update',
              object: noteSegment(),
              op: 'update',
              id: existing,
              payload: { title: 'existing2' },
            },
            {
              itemId: 'delete',
              object: noteSegment(),
              op: 'delete',
              id: existing,
            },
          ],
        });
        expect(((await response.json()) as Rows).results).toEqual([
          expect.objectContaining({ status: 'applied' }),
          expect.objectContaining({ status: 'applied' }),
          expect.objectContaining({ status: 'rejected', reason: 'forbidden' }),
        ]);
        expect(await titles()).toEqual(['existing2', 'synced']);
      });

      it('refuses every sync item of an unsigned caller', async () => {
        const response = await send(handler(), 'guest', 'POST', 'sync/apply', {
          items: [
            {
              itemId: 'create',
              object: noteSegment(),
              op: 'create',
              id: 'c0000000-0000-4000-8000-000000000002',
              payload: { title: 'x' },
            },
          ],
        });
        expect(((await response.json()) as Rows).results[0]).toMatchObject({
          status: 'rejected',
          reason: 'auth_required',
        });
        expect(await titles()).toEqual([]);
      });

      it('re-checks the permission of a subtype row against its own model', async () => {
        const api = handler();
        const docs = await PrincipalDocCollection.create({ db });
        const row = await docs.create({
          title: 'before',
          _meta_type: keyOf('PrincipalSecretDoc'),
        } as never);
        const path = `${segmentOf('PrincipalDoc')}/${row.id}`;
        const refused = await send(api, 'docEditor', 'PUT', path, {
          title: 'after',
        });
        expect(refused.status).toBe(403);
        expect(await refused.json()).toMatchObject({
          error: { code: 'PERMISSION_DENIED' },
        });
        const synced = await send(api, 'docEditor', 'POST', 'sync/apply', {
          items: [
            {
              itemId: 'doc',
              object: segmentOf('PrincipalDoc'),
              op: 'update',
              id: row.id,
              payload: { title: 'after' },
            },
          ],
        });
        expect(((await synced.json()) as Rows).results[0]).toMatchObject({
          status: 'rejected',
          reason: 'forbidden',
        });
        expect(
          (await send(api, 'writer', 'PUT', path, { title: 'after' })).status,
        ).toBe(200);
      });

      it('lets a super-admin bypass stand in only on a model that opts in', async () => {
        const api = handler();
        expect(
          (
            await send(api, 'bypass', 'POST', segmentOf('PrincipalLedger'), {
              title: 'ledger',
            })
          ).status,
        ).toBe(201);
        expect(
          (
            await send(api, 'bypass', 'POST', noteSegment(), {
              title: 'note',
            })
          ).status,
        ).toBe(403);
      });

      it('redacts reads by the principal’s permissions, not the server context', async () => {
        const api = new APIGenerator(
          { basePath: '/api', resolvePrincipal },
          { db, permissions: ['principalnotes.read.secret'] },
        ).generateHandler();
        const id = (
          await notes.create({
            title: 'classified',
            secret: 'hidden',
            tenantId: TENANT_A,
          } as never)
        ).id as string;
        const plain = (await (
          await send(api, 'reader', 'GET', `${noteSegment()}/${id}`)
        ).json()) as Record<string, unknown>;
        expect(plain.secret).toBeUndefined();
        const granted = (await (
          await send(api, 'secretReader', 'GET', `${noteSegment()}/${id}`)
        ).json()) as Record<string, unknown>;
        expect(granted.secret).toBe('hidden');
      });
    });

    describe('the tenant of a request', () => {
      it.each([
        ['tenantId', TENANT_B],
        ['tenant_id', TENANT_B],
        ['tenantId', null],
      ])('refuses a create body naming %s %s', async (key, value) => {
        const response = await send(
          handler(),
          'writer',
          'POST',
          noteSegment(),
          {
            title: 'escaped',
            [key]: value,
          },
        );
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({
          error: { code: 'TENANT_MISMATCH', status: 403 },
        });
        expect(await titles()).toEqual([]);
      });

      it('accepts a body that names the principal’s own tenant', async () => {
        const response = await send(
          handler(),
          'writer',
          'POST',
          noteSegment(),
          {
            title: 'own',
            tenantId: TENANT_A,
          },
        );
        expect(response.status).toBe(201);
      });

      it('refuses an update body or a sync payload naming another tenant', async () => {
        const api = handler();
        const id = await seedNote('mine', TENANT_A);
        const updated = await send(
          api,
          'writer',
          'PUT',
          `${noteSegment()}/${id}`,
          {
            title: 'moved',
            tenantId: TENANT_B,
          },
        );
        expect(updated.status).toBe(403);
        expect(await updated.json()).toMatchObject({
          error: { code: 'TENANT_MISMATCH' },
        });
        const synced = await send(api, 'writer', 'POST', 'sync/apply', {
          items: [
            {
              itemId: 'moved',
              object: noteSegment(),
              op: 'update',
              id,
              payload: { title: 'moved', tenantId: TENANT_B },
            },
          ],
        });
        expect(((await synced.json()) as Rows).results[0]).toMatchObject({
          status: 'rejected',
          reason: 'forbidden',
        });
        expect(await titles()).toEqual(['mine']);
      });

      it('removes tenant filters from a query unless the principal is cross-tenant', async () => {
        await seedNote('a', TENANT_A);
        await seedNote('b', TENANT_B);
        await seedNote('global', null);
        const listed = async (
          target: (req: Request) => Promise<Response>,
          as: string | undefined,
          query: string,
        ) =>
          (
            (await (
              await send(target, as, 'GET', `${noteSegment()}?${query}`)
            ).json()) as Array<{ title: string }>
          )
            .map((row) => row.title)
            .sort();
        const api = handler();
        // No interceptor runs here, so an ignored filter shows every row.
        const unfiltered = await listed(api, 'writer', '');
        expect(unfiltered).toEqual(['a', 'b', 'global']);
        expect(await listed(api, 'writer', `tenantId=${TENANT_B}`)).toEqual(
          unfiltered,
        );
        expect(
          await listed(api, 'writer', `tenant_id[ne]=${TENANT_A}`),
        ).toEqual(unfiltered);
        const counted = await send(
          api,
          'writer',
          'GET',
          `${noteSegment()}/count?tenantId=${TENANT_B}`,
        );
        expect(await counted.json()).toEqual({ count: 3 });
        // Negative controls: a cross-tenant principal, and a server without
        // `resolvePrincipal`, filter as asked.
        expect(await listed(api, 'operator', `tenantId=${TENANT_B}`)).toEqual([
          'b',
        ]);
        const legacy = new APIGenerator(
          { basePath: '/api', authMiddleware: () => async (req) => req },
          { db },
        ).generateHandler();
        expect(await listed(legacy, undefined, `tenantId=${TENANT_B}`)).toEqual(
          ['b'],
        );
      });
    });

    describe('resolution', () => {
      it('resolves the principal once per request', async () => {
        const api = handler({ authMiddleware: () => async (req) => req });
        await send(api, 'writer', 'POST', noteSegment(), { title: 'one' });
        expect(resolutions).toBe(1);
        resolutions = 0;
        const docs = await PrincipalDocCollection.create({ db });
        const row = await docs.create({
          title: 'sub',
          _meta_type: keyOf('PrincipalSecretDoc'),
        } as never);
        await send(
          api,
          'writer',
          'PUT',
          `${segmentOf('PrincipalDoc')}/${row.id}`,
          {
            title: 'sub2',
          },
        );
        expect(resolutions).toBe(1);
      });

      it('resolves the principal once for a 50-item sync batch', async () => {
        let middlewareCalls = 0;
        const api = handler({
          authMiddleware: () => async (req) => {
            middlewareCalls += 1;
            return req;
          },
        });
        const items = Array.from({ length: 50 }, (_, i) => ({
          itemId: `item-${i}`,
          object: noteSegment(),
          op: 'create',
          id: `d0000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
          payload: { title: `n${String(i).padStart(2, '0')}` },
        }));
        const response = await send(api, 'writer', 'POST', 'sync/apply', {
          items,
        });
        const { results } = (await response.json()) as Rows;
        expect(results.filter((r) => r.status === 'applied')).toHaveLength(50);
        expect(resolutions).toBe(1);
        expect(middlewareCalls).toBe(50);
      });

      it('answers 500 without detail when the host cannot resolve', async () => {
        for (const resolve of [
          () => {
            throw new Error('session store unreachable: secret-detail');
          },
          () => ({ tenantId: 42 }) as unknown as APIRequestPrincipal,
        ]) {
          const response = await send(
            handler({ resolvePrincipal: resolve }),
            'writer',
            'GET',
            noteSegment(),
          );
          expect(response.status).toBe(500);
          const text = await response.text();
          expect(text).not.toContain('secret-detail');
          expect(JSON.parse(text)).toMatchObject({
            error: 'Internal server error',
          });
        }
      });
    });

    describe('onRequest', () => {
      it('sees the route, model and action of a request and of each sync item', async () => {
        const seen: Array<[string | null, APIRequestInfo]> = [];
        const api = handler({
          onRequest: (principal, info) => {
            seen.push([principal.callerKind, info]);
          },
        });
        await send(api, 'writer', 'GET', noteSegment());
        await send(api, 'writer', 'POST', `${noteSegment()}/archive`);
        await send(api, 'writer', 'POST', 'sync/apply', {
          items: [
            {
              itemId: 'one',
              object: noteSegment(),
              op: 'create',
              id: 'e0000000-0000-4000-8000-000000000001',
              payload: { title: 'x' },
            },
            {
              itemId: 'two',
              object: noteSegment(),
              op: 'delete',
              id: 'e0000000-0000-4000-8000-000000000002',
            },
          ],
        });
        const model = keyOf('PrincipalNote');
        expect(seen).toEqual([
          ['user', { route: 'object', model, action: 'list' }],
          ['user', { route: 'object', model, action: 'archive' }],
          ['user', { route: 'sync/apply' }],
          ['user', { route: 'sync/apply', model, action: 'create' }],
          ['user', { route: 'sync/apply', model, action: 'delete' }],
        ]);
      });

      it('answers a request with the Response it returns', async () => {
        const api = handler({
          onRequest: (_principal, info) =>
            info.action === 'create'
              ? new Response('slow down', { status: 429 })
              : undefined,
        });
        const refused = await send(api, 'writer', 'POST', noteSegment(), {
          title: 'x',
        });
        expect(refused.status).toBe(429);
        expect((await send(api, 'writer', 'GET', noteSegment())).status).toBe(
          200,
        );
        expect(await titles()).toEqual([]);
      });

      it('rejects only the sync item it answers, with its reason', async () => {
        const api = handler({
          onRequest: (_principal, info) => {
            if (info.route !== 'sync/apply' || !info.model) return;
            if (info.action === 'update') {
              return new Response('slow down', { status: 429 });
            }
            if (info.action === 'delete') {
              return new Response('sign in', { status: 401 });
            }
          },
        });
        const kept = await seedNote('kept', TENANT_A);
        const response = await send(api, 'writer', 'POST', 'sync/apply', {
          items: [
            {
              itemId: 'first',
              object: noteSegment(),
              op: 'create',
              id: 'f0000000-0000-4000-8000-000000000001',
              payload: { title: 'first' },
            },
            {
              itemId: 'limited',
              object: noteSegment(),
              op: 'update',
              id: kept,
              payload: { title: 'changed' },
            },
            {
              itemId: 'unsigned',
              object: noteSegment(),
              op: 'delete',
              id: kept,
            },
            {
              itemId: 'last',
              object: noteSegment(),
              op: 'create',
              id: 'f0000000-0000-4000-8000-000000000002',
              payload: { title: 'last' },
            },
          ],
        });
        expect(response.status).toBe(200);
        expect(((await response.json()) as Rows).results).toEqual([
          expect.objectContaining({ itemId: 'first', status: 'applied' }),
          expect.objectContaining({
            itemId: 'limited',
            status: 'rejected',
            reason: 'forbidden',
          }),
          expect.objectContaining({
            itemId: 'unsigned',
            status: 'rejected',
            reason: 'auth_required',
          }),
          expect.objectContaining({ itemId: 'last', status: 'applied' }),
        ]);
        expect(await titles()).toEqual(['first', 'kept', 'last']);
      });

      it('rejects a sync item whose hook throws, and applies the rest', async () => {
        const api = handler({
          onRequest: (_principal, info) => {
            if (info.route === 'sync/apply' && info.model) {
              throw new Error('meter unavailable');
            }
          },
        });
        const response = await send(api, 'writer', 'POST', 'sync/apply', {
          items: [
            {
              itemId: 'only',
              object: noteSegment(),
              op: 'create',
              id: 'f0000000-0000-4000-8000-000000000003',
              payload: { title: 'x' },
            },
          ],
        });
        expect(response.status).toBe(200);
        expect(((await response.json()) as Rows).results[0]).toMatchObject({
          status: 'rejected',
          reason: 'write_failed',
        });
        expect(await titles()).toEqual([]);
      });
    });

    describe('change feeds', () => {
      let entered: string[];

      beforeEach(async () => {
        await seedNote('feed-a', TENANT_A);
        await seedNote('feed-b', TENANT_B);
        await seedNote('feed-global', null);
        // A stand-in for tenancy: the request enters the tenant it acts in,
        // and reads see the tenant entered.
        const tenant = new AsyncLocalStorage<string>();
        entered = [];
        setRequestTenantContextHooks({
          enter: () => {
            throw new Error('not expected');
          },
          current: () => {
            const tenantId = tenant.getStore();
            return tenantId ? { tenantId } : undefined;
          },
          run: (context, fn) => {
            entered.push(context.tenantId);
            return tenant.run(context.tenantId, fn);
          },
          isSuperAdminBypass: () => false,
        });
        setDispatchTenantResolver(() => tenant.getStore() ?? null);
      });

      const feedTenants = async (response: Response) =>
        [
          ...new Set(
            (
              (await response.json()) as {
                changes: Array<{ table: string; tenantId: string | null }>;
              }
            ).changes
              .filter((change) => change.table === notes.tableName)
              .map((change) => change.tenantId),
          ),
        ].sort();

      it('reads _changes in the principal’s tenant', async () => {
        const api = handler();
        const ofA = await send(api, 'writer', 'GET', '_changes?since=0');
        expect(ofA.status).toBe(200);
        expect(await feedTenants(ofA)).toEqual([TENANT_A, null].sort());
        expect(
          await feedTenants(await send(api, 'ofB', 'GET', '_changes?since=0')),
        ).toEqual([TENANT_B, null].sort());
        expect(
          await feedTenants(
            await send(api, 'tenantless', 'GET', '_changes?since=0'),
          ),
        ).toEqual([null]);
        expect(entered).toEqual([TENANT_A, TENANT_B]);
      });

      it('refuses _changes and _events to an anonymous or unsigned caller', async () => {
        const api = handler();
        for (const as of [undefined, 'guest']) {
          expect((await send(api, as, 'GET', '_changes')).status).toBe(401);
          expect((await send(api, as, 'GET', '_events')).status).toBe(401);
        }
      });

      it('replays _events in the principal’s tenant', async () => {
        const api = handler();
        const response = await send(api, 'writer', 'GET', '_events?since=0');
        expect(response.status).toBe(200);
        const stream = response.body as ReadableStream<Uint8Array>;
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let text = '';
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline && !text.includes(TENANT_A)) {
          const next = await Promise.race([
            reader.read(),
            new Promise<'timeout'>((resolve) =>
              setTimeout(() => resolve('timeout'), 100),
            ),
          ]);
          if (next === 'timeout' || next.done) continue;
          text += decoder.decode(next.value, { stream: true });
        }
        await reader.cancel();
        expect(text).toContain(TENANT_A);
        expect(text).not.toContain(TENANT_B);
        expect(entered).toEqual([TENANT_A]);
      });
    });

    describe('without resolvePrincipal', () => {
      it('keeps today’s behaviour: the middleware decides and bodies drop tenant keys', async () => {
        const api = new APIGenerator(
          { basePath: '/api', authMiddleware: () => async (req) => req },
          { db },
        ).generateHandler();
        const created = await send(api, undefined, 'POST', noteSegment(), {
          title: 'legacy',
          tenantId: TENANT_B,
        });
        expect(created.status).toBe(201);
        const stored = await db.query(
          `SELECT tenant_id FROM ${notes.tableName} WHERE title = ?`,
          ['legacy'],
        );
        expect(stored.rows[0]?.tenant_id ?? null).toBeNull();
        expect(
          (await send(api, undefined, 'POST', `${noteSegment()}/archive`))
            .status,
        ).toBe(200);
        expect(resolutions).toBe(0);
        const anonymous = new APIGenerator(
          { basePath: '/api' },
          { db },
        ).generateHandler();
        expect(
          (await send(anonymous, undefined, 'GET', noteSegment())).status,
        ).toBe(401);
        expect(
          (await send(anonymous, undefined, 'GET', '_changes')).status,
        ).toBe(401);
      });

      it('gives onRequest the fixed context principal', async () => {
        const seen: unknown[] = [];
        const api = new APIGenerator(
          {
            basePath: '/api',
            authMiddleware: () => async (req) => req,
            onRequest: (principal) => {
              seen.push({
                ...principal,
                permissions: [...principal.permissions],
              });
            },
          },
          { db, tenantId: TENANT_A, user: { id: 'fixed-user' } },
        ).generateHandler();
        await send(api, undefined, 'GET', noteSegment());
        expect(seen).toEqual([
          {
            tenantId: TENANT_A,
            userId: 'fixed-user',
            authenticated: true,
            callerKind: null,
            allowCrossTenant: false,
            superAdminBypass: false,
            requestScoped: false,
            permissions: [],
          },
        ]);
      });
    });
  });
}
