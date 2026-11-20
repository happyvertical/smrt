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
    ],
    routes: {
      recent: { method: 'GET', scope: 'collection' },
      latest: { method: 'GET', scope: 'collection' },
      unscanned: { method: 'GET', scope: 'collection' },
      newest: { method: 'GET', scope: 'collection' },
      paged: { method: 'GET', scope: 'collection' },
      annotated: { method: 'GET', scope: 'collection' },
      filtered: { method: 'GET', scope: 'collection' },
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

  /** No scanned metadata; reads with its options as the filter. */
  async filtered(options: Record<string, unknown> = {}): Promise<{
    titles: string[];
  }> {
    const rows = await this.list({ where: options });
    return { titles: rows.map((row) => row.title).sort() };
  }
}

// No scanned metadata; an empty parameter list holding only a comment (built
// from source text so the comment survives transpilation).
Object.defineProperty(ScopedMemoCollection.prototype, 'annotated', {
  configurable: true,
  writable: true,
  value: new Function(
    `return async function annotated(/* takes nothing: options */) {
      const rows = await this.list({});
      return { titles: rows.map((row) => row.title).sort() };
    };`,
  )(),
});

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
  const serve = (config: APIConfig) => {
    const api = new APIGenerator({ basePath: '/api', ...config });
    api.registerCollection('memos', memos as never);
    api.registerCollection('legacymemos', legacy as never);
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
    // The scanned manifest says `recent` takes no options, so nothing hands it
    // a tenant scope.
    ObjectRegistry.getMethods('ScopedMemo').set('recent', {
      name: 'recent',
      parameters: [],
      returnType: 'Promise<any>',
      isPublic: true,
    } as never);
    // `latest` takes a page size, not the options a scope is set in.
    // `unscanned` has no registered metadata at all.
    ObjectRegistry.getMethods('ScopedMemo').set('latest', {
      name: 'latest',
      parameters: [{ name: 'limit', type: 'number', optional: true }],
      returnType: 'Promise<any>',
      isPublic: true,
    } as never);
    dir = mkdtempSync(join(tmpdir(), 'smrt-request-tenant-'));
    db = await getTestDatabase({
      type: 'sqlite',
      url: join(dir, 'app.db'),
      classes: ['ScopedMemo', 'ScopedLegacyMemo'],
    });
    memos = await ScopedMemoCollection.create({ db });
    legacy = await ScopedLegacyMemoCollection.create({ db });
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

  describe('a custom collection read taking options with no registered metadata', () => {
    it('serves a caller with no tenant only rows without an owner', async () => {
      const response = await call(
        handler,
        'GET',
        `memos/filtered?tenantId=${TENANT_B}`,
        {
          as: 'user-without-tenant',
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        result: { titles: ['global'] },
      });
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
