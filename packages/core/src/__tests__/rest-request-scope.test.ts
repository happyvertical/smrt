/**
 * What a runtime REST request may reach is decided for that request.
 *
 * - The runtime exposure gate and STI create targets are evaluated for the
 *   tenant `APIConfig.resolveTenant` returns for the admitted request, not
 *   the server's fixed context.
 * - `createRestServer(objects)` creates only the models it was given: an STI
 *   subtype of a served base is created through the base only when the
 *   subtype was given too.
 * - An update through a base route of a row that is a subtype obeys the
 *   subtype's own read-only fields and `api.writable` allowlist, on CRUD and
 *   on sync apply.
 *
 * Real SQLite; nothing is mocked.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { SmrtCollection } from '../collection.js';
import { field } from '../decorators/index.js';
import { APIGenerator, createRestServer } from '../generators/rest.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { setRuntimeExposureGate } from '../runtime-exposure.js';
import { getTestDatabase } from '../testing/database.js';
import {
  type EmittedProject,
  emitTransports,
} from './fixtures/emitted-transports.js';

@smrt({ api: { include: ['list', 'get', 'create'] } })
class ScopeReport extends SmrtObject {
  @field({ type: 'text' })
  title = '';
}

@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get', 'create', 'update'] },
})
class ScopeDoc extends SmrtObject {
  @field({ type: 'text' })
  title = '';
}
class ScopeDocCollection extends SmrtCollection<ScopeDoc> {
  static readonly _itemClass = ScopeDoc;
}

/** A subtype available to one tenant only (by the exposure gate). */
@smrt({ api: { include: ['list', 'get', 'create', 'update'] } })
class ScopeTenantDoc extends ScopeDoc {
  @field({ type: 'text' })
  note = '';
}

/** A subtype that narrows what an update may write. */
@smrt({
  api: {
    include: ['list', 'get', 'create', 'update'],
    writable: ['title', 'stamp'],
  },
})
class ScopeLockedDoc extends ScopeDoc {
  @field({ type: 'text' })
  note = '';

  @field({ type: 'text', readonly: true })
  stamp = '';
}

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const key = (name: string) => {
  const info = ObjectRegistry.getClass(name);
  if (!info) throw new Error(`fixture not registered: ${name}`);
  return info.qualifiedName || info.name;
};
const segmentOf = (name: string) =>
  ObjectRegistry.getClass(name)?.collection as string;

function quietly<T>(start: () => T): T {
  const log = console.log;
  console.log = () => {};
  try {
    return start();
  } finally {
    console.log = log;
  }
}

async function listening(server: Server): Promise<number> {
  if (!server.listening) {
    await new Promise<void>((resolve) => server.once('listening', resolve));
  }
  return (server.address() as AddressInfo).port;
}

describe('runtime REST request scope', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    ObjectRegistry.registerCollection('ScopeDoc', ScopeDocCollection);
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['ScopeReport', 'ScopeDoc', 'ScopeTenantDoc', 'ScopeLockedDoc'],
    });
  });
  afterEach(async () => {
    setRuntimeExposureGate(undefined);
    await db?.close?.();
  });

  describe('the tenant of the request', () => {
    // The host knows each request's tenant; the server has no fixed one.
    const handler = () =>
      new APIGenerator(
        {
          basePath: '/api',
          authMiddleware: () => async (req) => req,
          resolveTenant: (req) => ({
            tenantId: req.headers.get('x-tenant'),
          }),
        },
        { db },
      ).generateHandler();
    const send = (
      tenant: string,
      method: string,
      path: string,
      body?: unknown,
    ) =>
      handler()(
        new Request(`http://local/api/${path}`, {
          method,
          headers: { 'content-type': 'application/json', 'x-tenant': tenant },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );

    beforeEach(() => {
      const onlyForA = new Set([key('ScopeReport'), key('ScopeTenantDoc')]);
      setRuntimeExposureGate({
        isEnabled: (model, context) =>
          !onlyForA.has(model.qualifiedName ?? '') ||
          context.tenantId === TENANT_A,
      });
    });

    it('serves a model switched on for one tenant to that tenant only', async () => {
      const segment = segmentOf('ScopeReport');
      expect((await send(TENANT_A, 'GET', segment)).status).toBe(200);
      expect(
        (await send(TENANT_A, 'POST', segment, { title: 'a' })).status,
      ).toBe(201);
      expect((await send(TENANT_B, 'GET', segment)).status).toBe(404);
      expect(
        (await send(TENANT_B, 'POST', segment, { title: 'b' })).status,
      ).toBe(404);
    });

    it('applies a sync item for that tenant only', async () => {
      const item = (id: string) => ({
        items: [
          {
            itemId: 'item-1',
            object: segmentOf('ScopeReport'),
            op: 'create',
            id,
            payload: { title: id },
          },
        ],
      });
      const resultOf = async (tenant: string, id: string) =>
        (
          (await (
            await send(tenant, 'POST', 'sync/apply', item(id))
          ).json()) as {
            results: Array<{ status: string; reason?: string }>;
          }
        ).results[0];
      expect(
        await resultOf(TENANT_A, 'aaaaaaaa-0000-4000-8000-000000000001'),
      ).toMatchObject({ status: 'applied' });
      expect(
        await resultOf(TENANT_B, 'bbbbbbbb-0000-4000-8000-000000000002'),
      ).toMatchObject({ status: 'rejected', reason: 'unknown_object' });
    });

    it('authorizes a sync item before the exposure gate without resolveTenant', async () => {
      // The server's own tenant is one the model is switched off for.
      const fixed = new APIGenerator(
        {
          basePath: '/api',
          authMiddleware: () => async (req) =>
            req.headers.get('x-user')
              ? req
              : new Response(null, { status: 401 }),
        },
        { db, tenantId: TENANT_B },
      ).generateHandler();
      const resultOf = async (headers: Record<string, string>) =>
        (
          (await (
            await fixed(
              new Request('http://local/api/sync/apply', {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...headers },
                body: JSON.stringify({
                  items: [
                    {
                      itemId: 'item-1',
                      object: segmentOf('ScopeReport'),
                      op: 'create',
                      id: 'cccccccc-0000-4000-8000-000000000006',
                      payload: { title: 'x' },
                    },
                  ],
                }),
              }),
            )
          ).json()) as {
            results: Array<{ status: string; reason?: string }>;
          }
        ).results[0];
      expect(await resultOf({})).toMatchObject({
        status: 'rejected',
        reason: 'auth_required',
      });
      expect(await resultOf({ 'x-user': 'someone' })).toMatchObject({
        status: 'rejected',
        reason: 'unknown_object',
      });
    });

    it('offers an STI create target for that tenant only', async () => {
      const segment = segmentOf('ScopeDoc');
      const body = { title: 'x', createType: key('ScopeTenantDoc') };
      expect((await send(TENANT_A, 'POST', segment, body)).status).toBe(201);
      const refused = await send(TENANT_B, 'POST', segment, body);
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(refused.status).toBeLessThan(500);
      const types = (
        await db.query('SELECT _meta_type FROM scope_docs')
      ).rows.map((row) => row._meta_type);
      expect(types).toEqual([key('ScopeTenantDoc')]);
    });
  });

  describe('createRestServer(objects) with an STI base', () => {
    const post = async (
      objects: Array<typeof SmrtObject>,
      body: Record<string, unknown>,
    ) => {
      const { server } = quietly(() =>
        createRestServer(objects, { db }, { port: 0, basePath: '/api' }),
      );
      try {
        const port = await listening(server);
        return await fetch(
          `http://127.0.0.1:${port}/api/${segmentOf('ScopeDoc')}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
        );
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    };
    // Public create: the server-scope rule is what decides here.
    beforeEach(() => {
      for (const name of ['ScopeDoc', 'ScopeTenantDoc']) {
        const config = ObjectRegistry.getConfig(key(name)) as {
          api?: { public?: unknown };
        };
        if (config.api) config.api.public = true;
      }
    });

    it('refuses a subtype it was not given and creates the base', async () => {
      const refused = await post([ScopeDoc], {
        title: 'child',
        createType: key('ScopeTenantDoc'),
      });
      expect(refused.status).toBe(400);
      expect((await post([ScopeDoc], { title: 'base' })).status).toBe(201);
      const types = (
        await db.query('SELECT _meta_type FROM scope_docs')
      ).rows.map((row) => row._meta_type);
      expect(types).toEqual([key('ScopeDoc')]);
    });

    it('creates the subtype when it was given too', async () => {
      const created = await post([ScopeDoc, ScopeTenantDoc], {
        title: 'child',
        createType: key('ScopeTenantDoc'),
      });
      expect(created.status).toBe(201);
    });
  });

  describe('an update of a subtype row through the base route', () => {
    let id: string;
    const handler = () =>
      new APIGenerator(
        { basePath: '/api', authMiddleware: () => async (req) => req },
        { db },
      ).generateHandler();
    const stored = async () =>
      (
        await db.query(
          'SELECT title, note, stamp FROM scope_docs WHERE id = ?',
          [id],
        )
      ).rows[0];

    beforeEach(async () => {
      const docs = await ScopeDocCollection.create({ db });
      const created = await docs.create({
        title: 'before',
        note: 'kept',
        stamp: 'original',
        _meta_type: key('ScopeLockedDoc'),
      } as never);
      id = created.id as string;
      expect(await stored()).toMatchObject({ note: 'kept', stamp: 'original' });
    });

    it('leaves fields the subtype withholds unchanged on CRUD', async () => {
      const response = await handler()(
        new Request(`http://local/api/${segmentOf('ScopeDoc')}/${id}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title: 'after',
            note: 'changed',
            stamp: 'changed',
          }),
        }),
      );
      expect(response.status).toBe(200);
      expect(await stored()).toEqual({
        title: 'after',
        note: 'kept',
        stamp: 'original',
      });
    });

    it('leaves fields the subtype withholds unchanged on sync apply', async () => {
      const response = await handler()(
        new Request('http://local/api/sync/apply', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            items: [
              {
                itemId: 'item-1',
                object: segmentOf('ScopeDoc'),
                op: 'update',
                id,
                payload: { title: 'synced', note: 'changed', stamp: 'changed' },
              },
            ],
          }),
        }),
      );
      expect(
        ((await response.json()) as { results: Array<{ status: string }> })
          .results[0],
      ).toMatchObject({ status: 'applied' });
      expect(await stored()).toEqual({
        title: 'synced',
        note: 'kept',
        stamp: 'original',
      });
    });
  });
});

describe('emitted routes: the tenant of the request', () => {
  let dir: string;
  let db: DatabaseInterface;
  let emitted: EmittedProject;
  let segment: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'smrt-request-scope-'));
    const dbUrl = join(dir, 'app.db');
    db = await getTestDatabase({
      type: 'sqlite',
      url: dbUrl,
      classes: ['ScopeReport'],
    });
    segment = segmentOf('ScopeReport');
    emitted = await emitTransports(['ScopeReport'], { db, dbUrl });
  });
  beforeEach(() => {
    const onlyForA = key('ScopeReport');
    setRuntimeExposureGate({
      isEnabled: (model, context) =>
        model.qualifiedName !== onlyForA || context.tenantId === TENANT_A,
    });
  });
  afterEach(() => setRuntimeExposureGate(undefined));
  afterAll(async () => {
    emitted?.dispose();
    await db?.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  // The tenant the write helper accepts from \`locals.user\` decides exposure.
  const signedIn = (tenantId: string) => ({
    user: { id: 'user-1', tenantId },
    permissions: [`${segment}.create`],
  });

  it('serves a model switched on for one tenant to that tenant only', async () => {
    const list = (locals: Record<string, unknown>) =>
      emitted.http(`${segment}/+server.ts`, 'GET', {
        url: `http://local/api/${segment}`,
        locals,
      });
    expect((await list(signedIn(TENANT_A))).status).toBe(200);
    expect((await list(signedIn(TENANT_B))).status).toBe(404);
  });

  it('authenticates before it answers 404', async () => {
    const anonymous = await emitted.http(`${segment}/+server.ts`, 'GET', {
      url: `http://local/api/${segment}`,
      locals: {},
    });
    expect(anonymous.status).toBe(401);
  });

  it('applies a sync item for that tenant only, after authorization', async () => {
    const item = (id: string) => ({
      items: [
        {
          itemId: 'item-1',
          object: segment,
          op: 'create',
          id,
          payload: { title: id },
        },
      ],
    });
    const resultOf = async (locals: Record<string, unknown>, id: string) =>
      (
        (
          await emitted.http('sync/apply/+server.ts', 'POST', {
            body: item(id),
            locals,
          })
        ).body as { results: Array<{ status: string; reason?: string }> }
      ).results[0];
    expect(
      await resultOf(
        signedIn(TENANT_A),
        'aaaaaaaa-0000-4000-8000-000000000003',
      ),
    ).toMatchObject({ status: 'applied' });
    expect(
      await resultOf(
        signedIn(TENANT_B),
        'bbbbbbbb-0000-4000-8000-000000000004',
      ),
    ).toMatchObject({ status: 'rejected', reason: 'unknown_object' });
    expect(
      await resultOf({}, 'cccccccc-0000-4000-8000-000000000005'),
    ).toMatchObject({ status: 'rejected', reason: 'auth_required' });
  });
});
