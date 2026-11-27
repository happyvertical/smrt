/**
 * The request principal record (#5195): one snapshot per REST request,
 * readable everywhere in the request and nowhere after it, and a bound
 * tenancy decision that the request's own code can narrow but never replace
 * or widen.
 *
 * - `getRequestPrincipal()` returns the request's snapshot inside it, and
 *   `undefined` outside it, after it ends, and in a worker thread.
 * - The snapshot and its permission view cannot be changed.
 * - An anonymous caller has an explicit principal.
 * - One snapshot feeds every operation of a request, sync items included.
 * - A decision bound by request code must carry the request's actor and may
 *   only narrow the membership REST resolved.
 * - Nothing exported enters or rebinds a principal scope.
 * - A `resolveTenant` host keeps its released behaviour; with both options
 *   the principal decides.
 *
 * Runs on SQLite, and on PostgreSQL when `SMRT_TEST_POSTGRES_URL` is set.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { field } from '../decorators/index.js';
import {
  type APIConfig,
  APIGenerator,
  type APIRequestPrincipal,
  type RequestPrincipal,
} from '../generators/rest.js';
import { getRequestPrincipal } from '../index.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import {
  getResolvedTenancy,
  resolveRequestTenancy,
  withResolvedTenancy,
} from '../request-tenancy.js';
import { getTestDatabase } from '../testing/database.js';

const TENANT_A = 'a0000000-5195-4000-8000-00000000000a';
const TENANT_B = 'b0000000-5195-4000-8000-00000000000b';

/** Work a test runs inside the `inspect` action, when set. */
let inspectWork: (() => Promise<unknown> | unknown) | undefined;
/** What the last `inspect` call returned from its work. */
let inspected: unknown;

@smrt({
  api: {
    include: ['list', 'get', 'create', 'update', 'delete', 'inspect'],
    routes: { inspect: { method: 'POST', scope: 'collection' } },
  },
})
class ScopeRecordNote extends SmrtObject {
  @field({ type: 'text' })
  title = '';
}
class ScopeRecordNoteCollection extends SmrtCollection<ScopeRecordNote> {
  static readonly _itemClass = ScopeRecordNote;

  async inspect(): Promise<{ ok: true }> {
    inspected = await inspectWork?.();
    return { ok: true };
  }
}

@smrt({
  tableStrategy: 'sti',
  api: {
    include: ['list', 'get', 'create', 'inspect'],
    routes: { inspect: { method: 'POST', scope: 'collection' } },
  },
})
class ScopeRecordDoc extends SmrtObject {
  @field({ type: 'text' })
  title = '';
}
class ScopeRecordDocCollection extends SmrtCollection<ScopeRecordDoc> {
  static readonly _itemClass = ScopeRecordDoc;

  async inspect(): Promise<{ ok: true }> {
    inspected = await inspectWork?.();
    return { ok: true };
  }
}

/** A subtype the doc route does not serve. */
@smrt({ api: false })
class ScopeRecordMemo extends ScopeRecordDoc {
  @field({ type: 'text' })
  memo = '';
}

/** Readable by anyone. */
@smrt({ api: { public: 'read', include: ['list', 'get'] } })
class ScopeRecordBoard extends SmrtObject {
  @field({ type: 'text' })
  title = '';
}

const CLASSES = [
  'ScopeRecordNote',
  'ScopeRecordDoc',
  'ScopeRecordMemo',
  'ScopeRecordBoard',
];
const segmentOf = (name: string) =>
  ObjectRegistry.getClass(name)?.collection as string;
const slug = (name: string, action: string) => `${segmentOf(name)}.${action}`;

function principals(): Record<string, APIRequestPrincipal | null> {
  return {
    writer: {
      tenantId: TENANT_A,
      userId: 'user-a',
      allowCrossTenant: false,
      authenticated: true,
      callerKind: 'user',
      permissions: [
        slug('ScopeRecordNote', 'create'),
        slug('ScopeRecordNote', 'inspect'),
      ],
    },
    noPermissions: {
      tenantId: TENANT_A,
      userId: 'user-b',
      allowCrossTenant: false,
      authenticated: true,
    },
    anonymous: null,
  };
}

for (const type of ['sqlite', 'postgres'] as const) {
  const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
  const suite = type === 'postgres' && !pgUrl ? describe.skip : describe;

  suite(`the request principal record on ${type}`, () => {
    let db: DatabaseInterface;
    let known: Record<string, APIRequestPrincipal | null>;

    const handler = (config: APIConfig = {}) =>
      new APIGenerator(
        {
          basePath: '/api',
          resolvePrincipal: (req) =>
            known[req.headers.get('x-principal') ?? ''] ?? null,
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
    const inspect = async (
      api: (req: Request) => Promise<Response>,
      as: string,
      work: () => Promise<unknown> | unknown,
    ) => {
      inspectWork = work;
      const response = await send(
        api,
        as,
        'POST',
        `${segmentOf('ScopeRecordNote')}/inspect`,
        {},
      );
      return { status: response.status, seen: inspected };
    };

    beforeEach(async () => {
      ObjectRegistry.registerCollection(
        'ScopeRecordNote',
        ScopeRecordNoteCollection as never,
      );
      ObjectRegistry.registerCollection(
        'ScopeRecordDoc',
        ScopeRecordDocCollection as never,
      );
      db = await getTestDatabase({
        type,
        url: type === 'postgres' ? pgUrl : ':memory:',
        classes: CLASSES,
      });
      known = principals();
      inspectWork = undefined;
      inspected = undefined;
    });
    afterEach(async () => {
      await db?.close?.();
    });

    it('custom actions read the resolved principal', async () => {
      expect(getRequestPrincipal()).toBeUndefined();
      const { status, seen } = await inspect(handler(), 'writer', () => {
        const principal = getRequestPrincipal();
        return principal
          ? { ...principal, permissions: [...principal.permissions].sort() }
          : undefined;
      });
      expect(status).toBe(200);
      expect(seen).toEqual({
        tenantId: TENANT_A,
        userId: 'user-a',
        authenticated: true,
        callerKind: 'user',
        allowCrossTenant: false,
        superAdminBypass: false,
        requestScoped: false,
        permissions: [
          slug('ScopeRecordNote', 'create'),
          slug('ScopeRecordNote', 'inspect'),
        ].sort(),
      });
      expect(getRequestPrincipal()).toBeUndefined();
    });

    it('the snapshot and its permission view cannot be changed', async () => {
      const { seen } = await inspect(handler(), 'writer', () => {
        const principal = getRequestPrincipal() as RequestPrincipal;
        const writable = principal as unknown as Record<string, unknown>;
        const outcomes: Record<string, string> = {};
        const attempt = (name: string, change: () => void) => {
          try {
            change();
            outcomes[name] = 'no error';
          } catch {
            outcomes[name] = 'refused';
          }
        };
        attempt('assign', () => {
          writable.tenantId = TENANT_B;
        });
        attempt('defineProperty', () =>
          Object.defineProperty(principal, 'allowCrossTenant', {
            value: true,
          }),
        );
        attempt('setPrototypeOf', () =>
          Object.setPrototypeOf(principal, { allowCrossTenant: true }),
        );
        attempt('Set.prototype.add', () =>
          Set.prototype.add.call(principal.permissions, 'x.delete'),
        );
        let collectionArg: unknown;
        principal.permissions.forEach((_value, _key, collection) => {
          collectionArg = collection;
        });
        return {
          outcomes,
          tenantId: getRequestPrincipal()?.tenantId,
          allowCrossTenant: getRequestPrincipal()?.allowCrossTenant,
          size: principal.permissions.size,
          has: principal.permissions.has(slug('ScopeRecordNote', 'create')),
          iterated: [...principal.permissions].length,
          forEachPassesView: collectionArg === principal.permissions,
        };
      });
      expect(seen).toEqual({
        outcomes: {
          assign: 'refused',
          defineProperty: 'refused',
          setPrototypeOf: 'refused',
          'Set.prototype.add': 'refused',
        },
        tenantId: TENANT_A,
        allowCrossTenant: false,
        size: 2,
        has: true,
        iterated: 2,
        forEachPassesView: true,
      });
      // A principal without permissions holds an empty view.
      known.writer = {
        ...(known.writer as APIRequestPrincipal),
        permissions: undefined,
      };
      const empty = await inspect(
        handler({ authMiddleware: undefined }),
        'noPermissions',
        () => getRequestPrincipal()?.permissions.size,
      );
      expect(empty.status).toBe(403);
    });

    it('an anonymous caller has an explicit principal', async () => {
      const seen: Array<RequestPrincipal | undefined> = [];
      const api = handler({
        onRequest: () => {
          seen.push(getRequestPrincipal());
          return undefined;
        },
      });
      expect(
        (await send(api, undefined, 'GET', segmentOf('ScopeRecordBoard')))
          .status,
      ).toBe(200);
      expect(
        (await send(api, undefined, 'GET', segmentOf('ScopeRecordNote')))
          .status,
      ).toBe(401);
      expect(seen.map((principal) => principal?.authenticated)).toEqual([
        false,
        false,
      ]);
      expect(seen.every((principal) => principal?.tenantId === null)).toBe(
        true,
      );
    });

    it('one snapshot feeds every operation', async () => {
      const seen: Array<RequestPrincipal | undefined> = [];
      const hooked: RequestPrincipal[] = [];
      const api = handler({
        onRequest: (principal) => {
          hooked.push(principal);
          seen.push(getRequestPrincipal());
          return undefined;
        },
      });
      const response = await send(api, 'writer', 'POST', 'sync/apply', {
        items: [1, 2, 3].map((n) => ({
          itemId: `item-${n}`,
          object: segmentOf('ScopeRecordNote'),
          op: 'create',
          id: `c0000000-5195-4000-8000-00000000000${n}`,
          payload: { title: `n${n}` },
        })),
      });
      expect(response.status).toBe(200);
      expect(hooked).toHaveLength(4);
      for (const principal of [...hooked, ...seen]) {
        expect(Object.is(principal, hooked[0])).toBe(true);
      }
    });

    it('a handler invoked inside a request runs as that request', async () => {
      let innerResolutions = 0;
      const inner = new APIGenerator(
        {
          basePath: '/api',
          resolvePrincipal: () => {
            innerResolutions += 1;
            return {
              ...(known.writer as APIRequestPrincipal),
              tenantId: TENANT_B,
            };
          },
        },
        { db },
      ).generateHandler();
      const { status, seen } = await inspect(handler(), 'writer', async () => {
        const outer = getRequestPrincipal();
        let innerPrincipal: RequestPrincipal | undefined;
        inspectWork = () => {
          innerPrincipal = getRequestPrincipal();
          return undefined;
        };
        const response = await inner(
          new Request(
            `http://local/api/${segmentOf('ScopeRecordNote')}/inspect`,
            { method: 'POST', body: '{}' },
          ),
        );
        return {
          status: response.status,
          same: Object.is(innerPrincipal, outer),
          tenantId: innerPrincipal?.tenantId,
        };
      });
      expect(status).toBe(200);
      expect(seen).toEqual({ status: 200, same: true, tenantId: TENANT_A });
      expect(innerResolutions).toBe(0);
    });

    it('a worker thread sees no principal', async () => {
      const { seen } = await inspect(handler(), 'writer', async () => {
        const worker = new Worker(
          `const { parentPort } = require('node:worker_threads');
           parentPort.postMessage(typeof globalThis.__smrtRequestPrincipalScope?.read === 'function'
             ? String(globalThis.__smrtRequestPrincipalScope.read())
             : 'none');`,
          { eval: true },
        );
        const answer = await new Promise((resolve, reject) => {
          worker.once('message', resolve);
          worker.once('error', reject);
        });
        await worker.terminate();
        return { main: getRequestPrincipal()?.tenantId, worker: answer };
      });
      expect(seen).toEqual({ main: TENANT_A, worker: 'none' });
    });

    it('a bound decision cannot be replaced or widened', async () => {
      const { status, seen } = await inspect(handler(), 'writer', async () => {
        const current = getResolvedTenancy();
        if (!current) throw new Error('no bound tenancy');
        const results: Record<string, string> = {};
        const tryBind = async (
          name: string,
          tenancy: ReturnType<typeof resolveRequestTenancy>,
        ) => {
          try {
            await withResolvedTenancy(tenancy, async () => undefined);
            results[name] = 'bound';
          } catch {
            results[name] = 'refused';
          }
        };
        const actor = current.actor;
        await tryBind(
          'same actor',
          resolveRequestTenancy({ model: current.model, actor }),
        );
        await tryBind(
          'another tenant',
          resolveRequestTenancy({
            model: current.model,
            actor: { ...actor, tenantId: TENANT_B },
          }),
        );
        await tryBind(
          'system',
          resolveRequestTenancy({
            model: current.model,
            actor: { ...actor, tenantId: null, system: 'write' },
          }),
        );
        await tryBind(
          'bypass',
          resolveRequestTenancy({
            model: current.model,
            actor: { ...actor, bypass: true },
          }),
        );
        await tryBind(
          'more permissions',
          resolveRequestTenancy({
            model: current.model,
            actor: {
              ...actor,
              permissions: new Set([
                ...(actor.permissions ?? []),
                slug('ScopeRecordNote', 'delete'),
              ]),
            },
          }),
        );
        return results;
      });
      expect(status).toBe(200);
      expect(seen).toEqual({
        'same actor': 'bound',
        'another tenant': 'refused',
        system: 'refused',
        bypass: 'refused',
        'more permissions': 'refused',
      });
    });

    it('a bound decision for a family cannot widen what the route admitted', async () => {
      const docModel =
        ObjectRegistry.getClass('ScopeRecordDoc')?.qualifiedName ||
        'ScopeRecordDoc';
      const memoModel =
        ObjectRegistry.getClass('ScopeRecordMemo')?.qualifiedName ||
        'ScopeRecordMemo';
      known.writer = {
        ...(known.writer as APIRequestPrincipal),
        permissions: [slug('ScopeRecordDoc', 'inspect')],
      };
      inspectWork = async () => {
        const current = getResolvedTenancy();
        if (!current?.family) throw new Error('no family tenancy');
        const results: Record<string, string> = {
          admitted: [...(current.admitted ?? [])].sort().join(','),
        };
        for (const [name, served] of [
          ['wider', [memoModel]],
          ['narrower', []],
        ] as const) {
          try {
            await withResolvedTenancy(
              resolveRequestTenancy({
                model: docModel,
                served: [...served],
                actor: current.actor,
              }),
              async () => undefined,
            );
            results[name] = 'bound';
          } catch {
            results[name] = 'refused';
          }
        }
        return results;
      };
      const response = await send(
        handler(),
        'writer',
        'POST',
        `${segmentOf('ScopeRecordDoc')}/inspect`,
        {},
      );
      expect(response.status).toBe(200);
      expect(inspected).toEqual({
        admitted: docModel,
        wider: 'refused',
        narrower: 'bound',
      });
    });

    it('a permission decided outside the live request is refused', async () => {
      // The decision REST makes for every write (`APIGenerator.decide`) runs
      // for the live request it belongs to, never for work that escaped it
      // or outlived it.
      const api = new APIGenerator(
        {
          basePath: '/api',
          resolvePrincipal: (req) =>
            known[req.headers.get('x-principal') ?? ''] ?? null,
        },
        { db },
      );
      type Decision = { allow: boolean; status?: number; code?: string };
      const decide = (
        api as unknown as {
          decide(
            principal: unknown,
            model: string,
            op: string,
          ): Decision | undefined;
        }
      ).decide.bind(api);
      const model =
        ObjectRegistry.getClass('ScopeRecordNote')?.qualifiedName ||
        'ScopeRecordNote';
      let escaped: (() => Decision | undefined) | undefined;
      const { status, seen } = await inspect(
        api.generateHandler(),
        'writer',
        () => {
          const resolved = {
            enforced: true,
            principal: getRequestPrincipal() as RequestPrincipal,
            tenantId: TENANT_A,
            userId: 'user-a',
            allowCrossTenant: false,
            authenticated: true,
            effectiveTenantId: TENANT_A,
            permissions: getRequestPrincipal()?.permissions,
            superAdminBypass: false,
          };
          escaped = () => decide(resolved, model, 'create');
          // In the request: the snapshot is live, and the writer holds it.
          return decide(resolved, model, 'create');
        },
      );
      expect(status).toBe(200);
      expect(seen).toMatchObject({ allow: true });
      // After the request ended, the same decision refuses.
      expect(escaped?.()).toMatchObject({
        allow: false,
        status: 403,
        code: 'PERMISSION_DENIED',
      });
    });

    it('nothing exported enters or rebinds a scope', async () => {
      const core = await import('../index.js');
      const names = Object.keys(core);
      for (const forbidden of [
        'enterRequestPrincipal',
        'runWithRequestPrincipal',
        'withRequestPrincipal',
        'bindRequestPrincipal',
        'runInPrincipalRecord',
      ]) {
        expect(names).not.toContain(forbidden);
      }
      expect(names).toContain('getRequestPrincipal');
      // No subpath export names a principal scope entry either.
      const here = dirname(fileURLToPath(import.meta.url));
      const pkg = JSON.parse(
        readFileSync(join(here, '..', '..', 'package.json'), 'utf8'),
      ) as { exports: Record<string, unknown> };
      expect(
        Object.keys(pkg.exports).filter((key) => /principal/i.test(key)),
      ).toEqual([]);
      // The shared object is frozen, non-writable, and carries no entry.
      await inspect(handler(), 'writer', () => undefined);
      const descriptor = Object.getOwnPropertyDescriptor(
        globalThis,
        '__smrtRequestPrincipalScope',
      );
      expect(descriptor?.writable).toBe(false);
      expect(descriptor?.configurable).toBe(false);
      const shared = descriptor?.value as Record<string, unknown>;
      expect(Object.isFrozen(shared)).toBe(true);
      expect(Object.keys(shared).sort()).toEqual(
        ['enterNonWidening', 'read', 'recordOf', 'version'].sort(),
      );
      for (const value of Object.values(shared)) {
        expect(value).not.toHaveProperty('run');
        expect(value).not.toHaveProperty('enter');
      }
    });

    it('resolveTenant hosts are unchanged, and the principal takes precedence', async () => {
      let tenantCalls = 0;
      const both = handler({
        resolveTenant: () => {
          tenantCalls += 1;
          return { tenantId: TENANT_B };
        },
      });
      const { seen } = await inspect(
        both,
        'writer',
        () => getResolvedTenancy()?.actor.tenantId ?? null,
      );
      expect(tenantCalls).toBe(0);
      // A fixed-context server has no request principal.
      const fixed = new APIGenerator(
        { basePath: '/api', authMiddleware: () => async (req) => req },
        { db, tenantId: TENANT_A },
      ).generateHandler();
      inspectWork = () => getRequestPrincipal();
      await send(
        fixed,
        undefined,
        'POST',
        `${segmentOf('ScopeRecordNote')}/inspect`,
        {},
      );
      expect(inspected).toBeUndefined();
      expect(seen === TENANT_A || seen === null).toBe(true);
    });
  });
}
