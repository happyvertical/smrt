/**
 * Emitted SvelteKit routes act for the tenant of the request, with the real
 * tenant interceptor.
 *
 * - The emitted sync route enters a signed-in caller's tenant for a model
 *   whose tenancy is registered at runtime, as the generated CRUD routes do,
 *   in an app whose manifest also declares tenant-scoped models: another
 *   tenant's row is never changed.
 * - The runtime exposure gate of emitted routes reads the tenant a host
 *   entered for the request when `locals` names none.
 *
 * The routes are generated into this package's ignored `.smrt/` folder and
 * imported through Vitest, sharing one core and one tenancy instance with the
 * test. Only `@sveltejs/kit` and the application's config module are
 * stand-ins.
 */

import { AsyncResource } from 'node:async_hooks';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  field,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { setRuntimeExposureGate } from '@happyvertical/smrt-core/runtime-exposure';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { generateSvelteKitRoutes } from '@happyvertical/smrt-core/vite-plugin';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { withSystemContext, withTenant } from '../context.js';
import { TenantScoped, tenantId } from '../decorators.js';
import { disableTenancy, enableTenancy } from '../interceptor.js';
import {
  registerTenantScopedClass,
  unregisterTenantScopedClass,
} from '../registry.js';

const OURS = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaa1';
const THEIRS = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbb2';
const THEIR_ROW = 'bbbbbbbb-0000-4000-8000-0000000000b1';

// Tenant-scoped in its manifest.
@smrt({ api: { include: ['list', 'get', 'create', 'update', 'delete'] } })
@TenantScoped({ mode: 'optional' })
class EmittedTenantLedger extends SmrtObject {
  @field({ type: 'text' })
  title = '';

  @tenantId({ nullable: true })
  tenantId: string | null = null;
}
class EmittedTenantLedgerCollection extends SmrtCollection<EmittedTenantLedger> {
  static readonly _itemClass = EmittedTenantLedger;
}

// No tenancy in its manifest: optional tenancy is registered at runtime.
@smrt({ api: { include: ['list', 'get', 'create', 'update', 'delete'] } })
class EmittedTenantMemo extends SmrtObject {
  @field({ type: 'text' })
  title = '';

  @field({ type: 'text', nullable: true })
  tenantId: string | null = null;
}
class EmittedTenantMemoCollection extends SmrtCollection<EmittedTenantMemo> {
  static readonly _itemClass = EmittedTenantMemo;
}

type Handler = (event: {
  locals: unknown;
  params: Record<string, string>;
  request: Request;
  url: URL;
}) => Promise<Response>;

const projectRoot = join(
  import.meta.dirname,
  '../../.smrt/generated-route-request-tenant',
);

describe('emitted routes and the request tenant', () => {
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  let memos: EmittedTenantMemoCollection;
  let memoName = '';
  const collections = new Map<string, unknown>();
  const routes = new Map<string, Record<string, unknown>>();

  const manifestEntry = (
    name: string,
    collection: string,
    decoratorConfig: Record<string, unknown>,
  ) => {
    const info = ObjectRegistry.getClass(name);
    if (!info) throw new Error(`${name} is not registered`);
    return {
      name: name.toLowerCase(),
      className: name,
      qualifiedName: info.qualifiedName,
      collection,
      filePath: join(projectRoot, `src/lib/objects/${name}.ts`),
      fields: Object.fromEntries(info.fields),
      methods: {},
      decoratorConfig,
    };
  };

  beforeAll(async () => {
    ObjectRegistry.registerCollection(
      'EmittedTenantLedger',
      EmittedTenantLedgerCollection,
    );
    ObjectRegistry.registerCollection(
      'EmittedTenantMemo',
      EmittedTenantMemoCollection,
    );
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['EmittedTenantLedger', 'EmittedTenantMemo'],
    });
    const ledgers = await EmittedTenantLedgerCollection.create({ db });
    memos = await EmittedTenantMemoCollection.create({ db });
    await memos.create({ id: THEIR_ROW, title: 'theirs', tenantId: THEIRS });

    const ledger = manifestEntry(
      'EmittedTenantLedger',
      'emittedtenantledgers',
      {
        api: { include: ['list', 'get', 'create', 'update', 'delete'] },
        tenantScoped: { mode: 'optional' },
      },
    );
    const memo = manifestEntry('EmittedTenantMemo', 'emittedtenantmemos', {
      api: { include: ['list', 'get', 'create', 'update', 'delete'] },
    });
    memoName = String(memo.qualifiedName);
    for (const [entry, instance] of [
      [ledger, ledgers],
      [memo, memos],
    ] as const) {
      collections.set(String(entry.qualifiedName), instance);
      collections.set(String(entry.className), instance);
    }

    rmSync(projectRoot, { recursive: true, force: true });
    mkdirSync(projectRoot, { recursive: true });
    await generateSvelteKitRoutes(
      projectRoot,
      {
        version: '1',
        timestamp: 0,
        packageName: '@happyvertical/smrt-tenancy',
        objects: {
          [String(ledger.qualifiedName)]: ledger,
          [memoName]: memo,
        },
      } as never,
      {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
        configPath: 'src/lib/server',
        configFileName: 'smrt.ts',
      },
    );

    vi.doMock('@sveltejs/kit', () => ({
      error: (status: number, message: string) => {
        throw Object.assign(new Error(message), { status });
      },
      json: (body: unknown, init: ResponseInit = {}) =>
        new Response(JSON.stringify(body), init),
    }));
    vi.doMock('$lib/server/smrt', () => ({
      getCollection: undefined,
      getSmrtConfig: undefined,
      runtime: {
        getCollection: async (name: string) => {
          const collection = collections.get(name);
          if (!collection) throw new Error(`No collection for ${name}`);
          return collection;
        },
        classOptions: () => ({}),
      },
    }));
    vi.doMock('$lib/server/smrt-register', () => ({}));
    vi.doMock('@happyvertical/smrt-tenancy', () => import('../index.js'));

    for (const path of ['sync/apply', 'emittedtenantledgers']) {
      routes.set(
        path,
        (await import(
          /* @vite-ignore */ pathToFileURL(
            join(projectRoot, `src/routes/api/${path}/+server.ts`),
          ).href
        )) as Record<string, unknown>,
      );
    }

    enableTenancy();
    registerTenantScopedClass(memoName, { mode: 'optional' });
  }, 60_000);

  afterAll(async () => {
    vi.doUnmock('@sveltejs/kit');
    vi.doUnmock('$lib/server/smrt');
    vi.doUnmock('$lib/server/smrt-register');
    vi.doUnmock('@happyvertical/smrt-tenancy');
    if (memoName) unregisterTenantScopedClass(memoName);
    disableTenancy();
    await db?.close?.();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const call = (
    path: string,
    method: 'GET' | 'POST',
    locals: Record<string, unknown>,
    body?: unknown,
  ) =>
    new AsyncResource('emitted-route-request').runInAsyncScope(async () => {
      const url = new URL(`http://localhost/api/${path}`);
      const handler = routes.get(path)?.[method] as Handler | undefined;
      if (!handler) throw new Error(`No ${method} route for ${path}`);
      try {
        return await handler({
          locals,
          params: {},
          request: new Request(url, {
            method,
            headers: { 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
          url,
        });
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (typeof status === 'number') return new Response(null, { status });
        throw error;
      }
    });

  const signedIn = (tenant: string, permissions: string[]) => ({
    tenantId: tenant,
    user: { id: 'writer' },
    permissions,
  });

  it('a sync update by a signed-in caller leaves another tenant row unchanged', async () => {
    const response = await call(
      'sync/apply',
      'POST',
      signedIn(OURS, ['emittedtenantmemos.update']),
      {
        items: [
          {
            itemId: 'item-1',
            object: 'emittedtenantmemos',
            op: 'update',
            id: THEIR_ROW,
            payload: { title: 'changed by another tenant' },
          },
        ],
      },
    );
    const body = (await response.json()) as {
      results: Array<{ status: string }>;
    };
    const stored = await withSystemContext(() => memos.get(THEIR_ROW));
    expect(stored?.title).toBe('theirs');
    expect(body.results[0]?.status).toBe('rejected');
  });

  describe('a model switched off for the tenant the host entered', () => {
    const run = <T>(fn: () => Promise<T>) =>
      withTenant({ tenantId: THEIRS }, fn);

    beforeAll(() => {
      setRuntimeExposureGate({
        isEnabled: (model, context) =>
          !String(model.qualifiedName ?? '').endsWith('EmittedTenantLedger') ||
          context.tenantId !== THEIRS,
      });
    });
    afterAll(() => {
      setRuntimeExposureGate(undefined);
    });

    const locals = {
      user: { id: 'writer' },
      permissions: ['emittedtenantledgers.create'],
    };

    it('is not served by its emitted route', async () => {
      expect(
        (await run(() => call('emittedtenantledgers', 'GET', locals))).status,
      ).toBe(404);
    });

    it('is unknown to the emitted sync route', async () => {
      const response = await run(() =>
        call('sync/apply', 'POST', locals, {
          items: [
            {
              itemId: 'item-1',
              object: 'emittedtenantledgers',
              op: 'create',
              id: 'cccccccc-0000-4000-8000-0000000000c1',
              payload: { title: 'created' },
            },
          ],
        }),
      );
      const body = (await response.json()) as {
        results: Array<{ status: string; reason?: string }>;
      };
      expect(body.results[0]).toMatchObject({
        status: 'rejected',
        reason: 'unknown_object',
      });
    });

    it('is served to the tenant it is switched on for', async () => {
      expect(
        (
          await withTenant({ tenantId: OURS }, () =>
            call('emittedtenantledgers', 'GET', locals),
          )
        ).status,
      ).toBe(200);
    });
  });
});
