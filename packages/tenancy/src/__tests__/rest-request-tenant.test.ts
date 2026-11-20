/**
 * Runtime REST acts for exactly the tenant its host names for a request.
 *
 * - A request whose resolved tenant differs from a tenant context the host
 *   already entered is refused with 403 (a sync item `forbidden`), never run
 *   inside the other tenant. A host that only enters an ambient context, and
 *   names no tenant per request, keeps working.
 * - A custom collection action read by a caller with no tenant is refused;
 *   it is not served across tenants.
 * - A create whose natural key belongs to another tenant's row is a 403 that
 *   says nothing about that row.
 *
 * Real SQLite file, the real tenant interceptor and entry-point gate.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  field,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import {
  type APIConfig,
  APIGenerator,
} from '@happyvertical/smrt-core/generators/rest';
import { setRuntimeExposureGate } from '@happyvertical/smrt-core/runtime-exposure';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withSystemContext, withTenant } from '../context.js';
import { TenantScoped, tenantId } from '../decorators.js';
import { disableTenancy, enableTenancy } from '../interceptor.js';

const TENANT_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaa1';
const TENANT_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbb2';
const ROW_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const ROW_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const ROW_GLOBAL = '99999999-0000-4000-8000-000000000009';

@smrt({
  api: {
    include: [
      'list',
      'get',
      'create',
      'update',
      'delete',
      'recent',
      'latest',
      'unscanned',
      'newest',
      'paged',
      'annotated',
      'filtered',
      'windowed',
      'lineCr',
      'lineSeparator',
      'paragraphSeparator',
      'shadowed',
    ],
    routes: {
      recent: { method: 'GET', scope: 'collection' },
      latest: { method: 'GET', scope: 'collection' },
      unscanned: { method: 'GET', scope: 'collection' },
      newest: { method: 'GET', scope: 'collection' },
      paged: { method: 'GET', scope: 'collection' },
      annotated: { method: 'GET', scope: 'collection' },
      filtered: { method: 'GET', scope: 'collection' },
      windowed: { method: 'GET', scope: 'collection' },
      lineCr: { method: 'GET', scope: 'collection' },
      lineSeparator: { method: 'GET', scope: 'collection' },
      paragraphSeparator: { method: 'GET', scope: 'collection' },
      shadowed: { method: 'GET', scope: 'collection' },
    },
  },
})
@TenantScoped({ mode: 'optional' })
class ScopedMemo extends SmrtObject {
  @field({ type: 'text' })
  title = '';

  @tenantId({ nullable: true })
  tenantId: string | null = null;

  constructor(options: any = {}) {
    super(options);
    if (options.title !== undefined) this.title = options.title;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }
}
class ScopedMemoCollection extends SmrtCollection<ScopedMemo> {
  static readonly _itemClass = ScopedMemo;

  /** A collection-scoped read with no tenant scope of its own. */
  async recent(): Promise<{ titles: string[] }> {
    const rows = await this.list({});
    return { titles: rows.map((row) => row.title).sort() };
  }

  /** A collection-scoped read whose one parameter carries no ownership. */
  async latest(limit?: number): Promise<{ titles: string[] }> {
    const rows = await this.list({ limit: Number(limit ?? 10) });
    return { titles: rows.map((row) => row.title).sort() };
  }

  /** A collection-scoped read with no parameters and no scanned metadata. */
  async unscanned(): Promise<{ titles: string[] }> {
    const rows = await this.list({});
    return { titles: rows.map((row) => row.title).sort() };
  }

  /** No scanned metadata; one page-size parameter with a default. */
  async newest(limit = 10): Promise<{ titles: string[] }> {
    const rows = await this.list({ limit: Number(limit) || 10 });
    return { titles: rows.map((row) => row.title).sort() };
  }

  /** No scanned metadata; takes an object but keeps only its page size. */
  async paged({ limit }: { limit?: unknown } = {}): Promise<{
    titles: string[];
  }> {
    const rows = await this.list({ limit: Number(limit) || 10 });
    return { titles: rows.map((row) => row.title).sort() };
  }

  /** No scanned metadata, and a name a scanned item static method shares. */
  async shadowed(): Promise<{ titles: string[] }> {
    const rows = await this.list({});
    return { titles: rows.map((row) => row.title).sort() };
  }

  /** No scanned metadata; reads with its options as the filter. */
  async filtered(options: Record<string, unknown> = {}): Promise<{
    titles: string[];
  }> {
    const rows = await this.list({ where: options });
    return { titles: rows.map((row) => row.title).sort() };
  }

  /** No scanned metadata; a destructured, defaulted page and its options. */
  async windowed(
    { limit }: { limit?: unknown } = {},
    options: Record<string, unknown> = {},
  ): Promise<{ titles: string[] }> {
    const rows = await this.list({
      where: options,
      limit: Number(limit) || 10,
    });
    return { titles: rows.map((row) => row.title).sort() };
  }
}

// No scanned metadata, built from source text so the comments survive
// transpilation: an empty parameter list holding only a comment, and a page
// size followed by options where a line comment ends at each of the other
// ECMAScript line terminators.
const fromSource = (name: string, parameters: string) =>
  Object.defineProperty(ScopedMemoCollection.prototype, name, {
    configurable: true,
    writable: true,
    value: new Function(
      `return async function ${name}(${parameters}) {
        const rows = await this.list({ where: arguments[1] ?? {} });
        return { titles: rows.map((row) => row.title).sort() };
      };`,
    )(),
  });
fromSource('annotated', '/* takes nothing: options */');
fromSource('lineCr', '// page size\rlimit,\noptions');
fromSource('lineSeparator', '// page size limit,\noptions');
fromSource('paragraphSeparator', '// page size limit,\noptions');

/** A model whose own id is its owner: its ownership property is `id`. */
@smrt({
  api: {
    include: ['list', 'get', 'ownerOf'],
    routes: { ownerOf: { method: 'GET', scope: 'collection' } },
  },
})
@TenantScoped({ mode: 'optional', field: 'id' })
class ScopedWorkspace extends SmrtObject {
  @field({ type: 'text' })
  title = '';
}
class ScopedWorkspaceCollection extends SmrtCollection<ScopedWorkspace> {
  static readonly _itemClass = ScopedWorkspace;

  /** Takes the ownership property as a named parameter. */
  async ownerOf(id?: string | null, label?: string) {
    return { id: id === undefined ? 'absent' : id, label: label ?? null };
  }
}

/** A natural key that omits the tenant: the shape the ownership check guards. */
@smrt({
  api: { include: ['list', 'get', 'create'] },
  conflictColumns: ['slug', 'context'],
})
@TenantScoped({ mode: 'optional' })
class ScopedLegacyMemo extends SmrtObject {
  @field({ type: 'text' })
  title = '';

  @tenantId({ nullable: true })
  tenantId: string | null = null;

  constructor(options: any = {}) {
    super(options);
    if (options.title !== undefined) this.title = options.title;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }
}
class ScopedLegacyMemoCollection extends SmrtCollection<ScopedLegacyMemo> {
  static readonly _itemClass = ScopedLegacyMemo;
}

const SESSIONS: Record<string, { tenantId?: string; operator?: boolean }> = {
  'user-of-a': { tenantId: TENANT_A },
  'user-without-tenant': {},
  operator: { operator: true },
};
const sessionOf = (req: Request) =>
  SESSIONS[(req.headers.get('authorization') ?? '').replace('Bearer ', '')];

describe('runtime REST request tenant', () => {
  let dir: string;
  let db: DatabaseInterface;
  let memos: ScopedMemoCollection;
  let legacy: ScopedLegacyMemoCollection;
  let workspaces: ScopedWorkspaceCollection;
  const serve = (config: APIConfig) => {
    const api = new APIGenerator({ basePath: '/api', ...config });
    api.registerCollection('memos', memos as never);
    api.registerCollection('legacymemos', legacy as never);
    api.registerCollection('workspaces', workspaces as never);
    return api.generateHandler();
  };
  let handler: (req: Request) => Promise<Response>;
  let ambientHandler: (req: Request) => Promise<Response>;

  beforeAll(async () => {
    ObjectRegistry.registerCollection(
      'ScopedMemo',
      ScopedMemoCollection as never,
    );
    ObjectRegistry.registerCollection(
      'ScopedLegacyMemo',
      ScopedLegacyMemoCollection as never,
    );
    // A loaded manifest records a collection-hosted action's parameters under
    // the collection class, which is registered for them.
    ObjectRegistry.register(ScopedMemoCollection as never, {});
    ObjectRegistry.register(ScopedWorkspaceCollection as never, {});
    // Registration introspects the prototype; keep only what a manifest names.
    ObjectRegistry.getMethods('ScopedMemoCollection').clear();
    ObjectRegistry.getMethods('ScopedWorkspaceCollection').clear();
    // The scanned manifest (under the collection class that hosts it) says
    // `recent` takes no options, so nothing hands it
    // a tenant scope.
    ObjectRegistry.getMethods('ScopedMemoCollection').set('recent', {
      name: 'recent',
      parameters: [],
      returnType: 'Promise<any>',
      isPublic: true,
    } as never);
    // A scanned static method on the ITEM class that takes options. The
    // collection method of the same name has no scanned metadata, and it is
    // the one a request reaches.
    ObjectRegistry.getMethods('ScopedMemo').set('shadowed', {
      name: 'shadowed',
      parameters: [{ name: 'options', type: 'object', optional: true }],
      returnType: 'Promise<any>',
      isPublic: true,
      isStatic: true,
    } as never);
    // `latest` takes a page size, not the options a scope is set in.
    // `unscanned` has no registered metadata at all.
    ObjectRegistry.getMethods('ScopedMemoCollection').set('latest', {
      name: 'latest',
      parameters: [{ name: 'limit', type: 'number', optional: true }],
      returnType: 'Promise<any>',
      isPublic: true,
    } as never);
    ObjectRegistry.registerCollection(
      'ScopedWorkspace',
      ScopedWorkspaceCollection as never,
    );
    // `ownerOf` names the ownership property `id`, which flat transports
    // expose as `actionId`.
    ObjectRegistry.getMethods('ScopedWorkspaceCollection').set('ownerOf', {
      name: 'ownerOf',
      parameters: [
        { name: 'id', type: 'string', optional: true },
        { name: 'label', type: 'string', optional: true },
      ],
      returnType: 'Promise<any>',
      isPublic: true,
    } as never);
    dir = mkdtempSync(join(tmpdir(), 'smrt-request-tenant-'));
    db = await getTestDatabase({
      type: 'sqlite',
      url: join(dir, 'app.db'),
      classes: ['ScopedMemo', 'ScopedLegacyMemo', 'ScopedWorkspace'],
    });
    memos = await ScopedMemoCollection.create({ db });
    legacy = await ScopedLegacyMemoCollection.create({ db });
    workspaces = await ScopedWorkspaceCollection.create({ db });
    enableTenancy();
    handler = serve({
      authMiddleware: () => async (req) =>
        sessionOf(req) ? req : new Response('unauthorized', { status: 401 }),
      resolveTenant: (req) => ({
        tenantId: sessionOf(req)?.tenantId,
        allowCrossTenant: sessionOf(req)?.operator === true,
      }),
    });
    // A host that enters the tenant context itself and names none per request.
    ambientHandler = serve({
      authMiddleware: () => async (req) => req,
      resolveTenant: () => ({ authenticated: true }),
    });
  });

  beforeEach(async () => {
    await withSystemContext(async () => {
      await db.query(`DELETE FROM ${memos.tableName}`);
      await db.query(`DELETE FROM ${legacy.tableName}`);
      await legacy.create({
        slug: 'shared-slug',
        title: 'owned by b',
        tenantId: TENANT_B,
      } as never);
      await memos.create({
        id: ROW_A,
        slug: 'memo-a',
        title: 'a',
        tenantId: TENANT_A,
      } as never);
      await memos.create({
        id: ROW_B,
        slug: 'memo-b',
        title: 'b',
        tenantId: TENANT_B,
      } as never);
      await memos.create({ id: ROW_GLOBAL, title: 'global' } as never);
    });
  });

  afterAll(async () => {
    disableTenancy();
    await db?.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  const titles = async () =>
    (
      await db.query(`SELECT title FROM ${memos.tableName} ORDER BY title`)
    ).rows.map((row) => row.title);
  const call = (
    target: (req: Request) => Promise<Response>,
    method: string,
    path: string,
    options: { as?: string; body?: unknown } = {},
  ) =>
    target(
      new Request(`http://local/api/${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(options.as ? { authorization: `Bearer ${options.as}` } : {}),
        },
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
      }),
    );
  const DENIED = {
    error: {
      code: 'permission_denied',
      message: 'Permission denied.',
      ok: false,
      status: 403,
    },
  };

  describe('a request whose tenant differs from the active context', () => {
    const insideB = <T>(fn: () => Promise<T>) =>
      withTenant({ tenantId: TENANT_B }, fn);

    it.each([
      ['an update', 'PUT', `memos/${ROW_B}`, { title: 'changed' }],
      ['a delete', 'DELETE', `memos/${ROW_B}`, undefined],
      ['a create', 'POST', 'memos', { title: 'created' }],
      ['a read', 'GET', 'memos', undefined],
    ])('is refused %s with 403', async (_label, method, path, body) => {
      const response = await insideB(() =>
        call(handler, method, path, { as: 'user-of-a', body }),
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual(DENIED);
      expect(await titles()).toEqual(['a', 'b', 'global']);
    });

    it('has a sync item rejected as forbidden', async () => {
      const response = await insideB(() =>
        call(handler, 'POST', 'sync/apply', {
          as: 'user-of-a',
          body: {
            items: [
              {
                itemId: 'item-1',
                object: 'memos',
                op: 'update',
                id: ROW_B,
                payload: { title: 'changed' },
              },
            ],
          },
        }),
      );
      expect(
        ((await response.json()) as { results: unknown[] }).results[0],
      ).toMatchObject({ status: 'rejected', reason: 'forbidden' });
      expect(await titles()).toEqual(['a', 'b', 'global']);
    });

    it('still works for a host that names no tenant per request', async () => {
      const response = await insideB(() =>
        call(ambientHandler, 'PUT', `memos/${ROW_B}`, {
          body: { title: 'b2' },
        }),
      );
      expect(response.status).toBe(200);
      const listed = await insideB(() => call(ambientHandler, 'GET', 'memos'));
      expect(JSON.stringify(await listed.json())).not.toContain('"a"');
      expect(await titles()).toEqual(['a', 'b2', 'global']);
    });
  });

  describe('an explicitly cross-tenant caller', () => {
    it('reads the rows of every tenant', async () => {
      const listed = await call(handler, 'GET', 'memos', { as: 'operator' });
      expect(listed.status).toBe(200);
      const titles = ((await listed.json()) as Array<{ title: string }>).map(
        (row) => row.title,
      );
      expect(titles.sort()).toEqual(['a', 'b', 'global']);
      const counted = await call(handler, 'GET', 'memos/count', {
        as: 'operator',
      });
      expect(await counted.json()).toEqual({ count: 3 });
      const read = await call(handler, 'GET', `memos/${ROW_B}`, {
        as: 'operator',
      });
      expect(read.status).toBe(200);
      expect(((await read.json()) as { title: string }).title).toBe('b');
    });
  });

  describe('the runtime exposure gate on an ambient-tenant host', () => {
    // On for tenant A only.
    const gated = () => {
      const model = ObjectRegistry.getClass('ScopedMemo');
      const key = model?.qualifiedName || model?.name;
      setRuntimeExposureGate({
        isEnabled: (candidate, context) =>
          candidate.qualifiedName !== key || context.tenantId === TENANT_A,
      });
    };

    it('reads the tenant the host entered', async () => {
      gated();
      try {
        const insideA = await withTenant({ tenantId: TENANT_A }, () =>
          call(ambientHandler, 'GET', 'memos'),
        );
        expect(insideA.status).toBe(200);
        const insideB = await withTenant({ tenantId: TENANT_B }, () =>
          call(ambientHandler, 'GET', 'memos'),
        );
        expect(insideB.status).toBe(404);
      } finally {
        setRuntimeExposureGate(undefined);
      }
    });
  });

  describe('a custom collection read', () => {
    it('is refused for a caller with no tenant', async () => {
      const response = await call(handler, 'GET', 'memos/recent', {
        as: 'user-without-tenant',
      });
      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).not.toContain('"a"');
      expect(text).not.toContain('"b"');
    });

    it('serves the caller the rows of its own tenant', async () => {
      const response = await call(handler, 'GET', 'memos/recent', {
        as: 'user-of-a',
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        result: { titles: ['a'] },
      });
    });

    it.each([
      ['whose parameter carries no ownership', 'memos/latest?limit=50'],
      ['with no parameters and no registered metadata', 'memos/unscanned'],
      [
        'with a defaulted parameter and no registered metadata',
        'memos/newest?limit=50',
      ],
      [
        'with a destructured parameter and no registered metadata',
        'memos/paged?limit=50',
      ],
      [
        'with a commented empty parameter list and no registered metadata',
        'memos/annotated',
      ],
    ])('%s is refused for a caller with no tenant', async (_label, path) => {
      const response = await call(handler, 'GET', path, {
        as: 'user-without-tenant',
      });
      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).not.toContain('"a"');
      expect(text).not.toContain('"b"');
    });

    it.each([
      ['whose parameter carries no ownership', 'memos/latest?limit=50'],
      ['with no parameters and no registered metadata', 'memos/unscanned'],
      [
        'with a defaulted parameter and no registered metadata',
        'memos/newest?limit=50',
      ],
      [
        'with a destructured parameter and no registered metadata',
        'memos/paged?limit=50',
      ],
      [
        'with a commented empty parameter list and no registered metadata',
        'memos/annotated',
      ],
      ['taking options and no registered metadata', 'memos/filtered'],
    ])('%s serves the caller the rows of its own tenant', async (_label, path) => {
      const response = await call(handler, 'GET', path, { as: 'user-of-a' });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        result: { titles: ['a'] },
      });
    });
  });

  describe('a custom collection read with no registered metadata', () => {
    // The server does not read a method's source: without scanned parameters
    // it cannot tell what the scoped options reach, so whatever the method
    // declares, a caller with no tenant is refused.
    const EVERY_ROW = ['a', 'b', 'global'];
    // [label, path, what an explicitly cross-tenant caller is served]. An
    // action filtering by its options is handed the scoped options, as before.
    const UNSCANNED: Array<[string, string, string[]]> = [
      ['declaring no parameters', 'memos/unscanned', EVERY_ROW],
      ['taking options', `memos/filtered?tenantId=${TENANT_B}`, ['global']],
      [
        'taking a destructured, defaulted page and options',
        'memos/windowed?limit=50',
        EVERY_ROW,
      ],
      [
        'whose line comment ends at a carriage return',
        'memos/lineCr',
        EVERY_ROW,
      ],
      ['whose line comment ends at U+2028', 'memos/lineSeparator', EVERY_ROW],
      [
        'whose line comment ends at U+2029',
        'memos/paragraphSeparator',
        EVERY_ROW,
      ],
    ];

    it.each(
      UNSCANNED,
    )('%s is refused for a caller with no tenant', async (_label, path) => {
      const response = await call(handler, 'GET', path, {
        as: 'user-without-tenant',
      });
      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).not.toContain('"a"');
      expect(text).not.toContain('"b"');
      expect(text).not.toContain('"global"');
    });

    it.each(
      UNSCANNED,
    )('%s serves the caller the rows of its own tenant', async (_label, path) => {
      const response = await call(handler, 'GET', path, { as: 'user-of-a' });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        result: { titles: ['a'] },
      });
    });

    it.each(
      UNSCANNED,
    )('%s still serves an explicitly cross-tenant caller', async (_label, path, served) => {
      const response = await call(handler, 'GET', path, { as: 'operator' });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        result: { titles: served },
      });
    });
  });

  describe('a collection method sharing its name with a scanned item static method', () => {
    it('is not admitted by the item method signature for a caller with no tenant', async () => {
      const response = await call(handler, 'GET', 'memos/shadowed', {
        as: 'user-without-tenant',
      });
      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).not.toContain('"a"');
      expect(text).not.toContain('"b"');
      expect(text).not.toContain('"global"');
    });

    it('serves a caller with a tenant its own rows', async () => {
      const response = await call(handler, 'GET', 'memos/shadowed', {
        as: 'user-of-a',
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        result: { titles: ['a'] },
      });
    });
  });

  describe('a custom collection read naming an ownership property called id', () => {
    const ownerOf = async (query: string, as: string) => {
      const response = await call(
        handler,
        'GET',
        `workspaces/ownerOf${query}`,
        {
          as,
        },
      );
      expect(response.status).toBe(200);
      return ((await response.json()) as { result: unknown }).result;
    };

    it.each([
      ['its transport name', `?actionId=${TENANT_B}&label=kept`],
      ['its property name', `?id=${TENANT_B}&label=kept`],
      ['both names', `?id=${TENANT_B}&actionId=${TENANT_B}&label=kept`],
    ])('takes the scope, not the caller value under %s, for a caller with no tenant', async (_label, query) => {
      expect(await ownerOf(query, 'user-without-tenant')).toEqual({
        id: null,
        label: 'kept',
      });
    });

    it('takes the caller tenant, not the caller value, for a caller with a tenant', async () => {
      expect(
        await ownerOf(`?actionId=${TENANT_B}&label=kept`, 'user-of-a'),
      ).toEqual({ id: TENANT_A, label: 'kept' });
    });
  });

  describe('a create whose natural key another tenant holds', () => {
    it('answers 403 without naming the other tenant', async () => {
      const response = await call(handler, 'POST', 'legacymemos', {
        as: 'user-of-a',
        body: { slug: 'shared-slug', title: 'taken' },
      });
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body).toEqual(DENIED);
      expect(JSON.stringify(body)).not.toContain(TENANT_B);
      const rows = (
        await db.query(`SELECT title, tenant_id FROM ${legacy.tableName}`)
      ).rows;
      expect(rows).toEqual([{ title: 'owned by b', tenant_id: TENANT_B }]);
    });
  });
});
