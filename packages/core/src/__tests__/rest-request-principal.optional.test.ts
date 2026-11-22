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
 * - `onRequest` sees each request and each sync item, and may answer it.
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
import {
  type APIConfig,
  APIGenerator,
  type APIRequestInfo,
  type APIRequestPrincipal,
} from '../generators/rest.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
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
class PrincipalNoteCollection extends SmrtCollection<PrincipalNote> {
  static readonly _itemClass = PrincipalNote;

  async archive(): Promise<{ archived: boolean }> {
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
        const seen: Array<[string | undefined, APIRequestInfo]> = [];
        const api = handler({
          onRequest: (principal, info) => {
            seen.push([principal?.callerKind, info]);
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

      it('stops a sync batch at the item it answers', async () => {
        let items = 0;
        const api = handler({
          onRequest: (_principal, info) => {
            if (info.route !== 'sync/apply' || !info.model) return;
            items += 1;
            if (items === 2) return new Response('slow down', { status: 429 });
          },
        });
        const response = await send(api, 'writer', 'POST', 'sync/apply', {
          items: ['first', 'second', 'third'].map((title, i) => ({
            itemId: title,
            object: noteSegment(),
            op: 'create',
            id: `f0000000-0000-4000-8000-00000000000${i}`,
            payload: { title },
          })),
        });
        expect(response.status).toBe(429);
        expect(await titles()).toEqual(['first']);
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
        const seen: Array<Readonly<APIRequestPrincipal> | null> = [];
        const api = new APIGenerator(
          {
            basePath: '/api',
            authMiddleware: () => async (req) => req,
            onRequest: (principal) => {
              seen.push(principal);
            },
          },
          { db, tenantId: TENANT_A, user: { id: 'fixed-user' } },
        ).generateHandler();
        await send(api, undefined, 'GET', noteSegment());
        expect(seen).toEqual([
          {
            tenantId: TENANT_A,
            allowCrossTenant: false,
            authenticated: true,
            userId: 'fixed-user',
          },
        ]);
      });
    });
  });
}
