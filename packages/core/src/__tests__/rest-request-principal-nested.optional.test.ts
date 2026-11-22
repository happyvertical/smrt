/**
 * A handler invoked inside a principal request (#5195) inherits the outer
 * request exactly, and request code cannot open a trusted operation frame.
 *
 * - A nested handler built without `resolvePrincipal` does not consult its
 *   own `resolveTenant` or fixed tenant: the exposure gate sees the outer
 *   principal's tenant.
 * - A nested operation binds a membership no wider than the enclosing
 *   frame's ceiling: rows of a member the outer operation did not admit are
 *   not read, and an empty intersection reads nothing.
 * - `withResolvedTenancy(..., { principal: true })` from request code is
 *   held to the non-widening rule like any other bind.
 *
 * Runs on SQLite, and on PostgreSQL when `SMRT_TEST_POSTGRES_URL` is set.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { field } from '../decorators/index.js';
import {
  type APIConfig,
  type APIContext,
  APIGenerator,
  type APIRequestPrincipal,
} from '../generators/rest.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import {
  getResolvedTenancy,
  resolveRequestTenancy,
  withResolvedTenancy,
} from '../request-tenancy.js';
import { setRuntimeExposureGate } from '../runtime-exposure.js';
import { getTestDatabase } from '../testing/database.js';

const TENANT_A = 'a0000000-5195-4000-8000-0000000000a1';
const TENANT_B = 'b0000000-5195-4000-8000-0000000000b2';

/** Work a test runs inside the `inspect` action, when set. */
let inspectWork: (() => Promise<unknown> | unknown) | undefined;
/** What the last `inspect` call returned from its work. */
let inspected: unknown;

@smrt({
  tableStrategy: 'sti',
  api: {
    include: ['list', 'get', 'create', 'inspect', 'peek'],
    routes: {
      inspect: { method: 'POST', scope: 'collection' },
      peek: { method: 'GET', scope: 'collection' },
    },
  },
})
class NestedScopeDoc extends SmrtObject {
  @field({ type: 'text' })
  title = '';
}
class NestedScopeDocCollection extends SmrtCollection<NestedScopeDoc> {
  static readonly _itemClass = NestedScopeDoc;

  async inspect(): Promise<{ ok: true }> {
    inspected = await inspectWork?.();
    return { ok: true };
  }

  /** A read action: runs `peekWork` and returns what it returned. */
  async peek(): Promise<{ result: unknown }> {
    return { result: await peekWork?.() };
  }
}

/** Work a test runs inside the `peek` action, when set. */
let peekWork: (() => Promise<unknown> | unknown) | undefined;
/** Whether the outer request is served the page subtype (read only). */
let outerSeesPages = false;

/** A served subtype the outer request's exposure gate leaves out. */
@smrt({ collection: 'nested-scope-pages', api: { include: ['list', 'get'] } })
class NestedScopePage extends NestedScopeDoc {
  @field({ type: 'text' })
  page = '';
}
class NestedScopePageCollection extends SmrtCollection<NestedScopePage> {
  static readonly _itemClass = NestedScopePage;
}

/** Switched on for TENANT_B only. */
@smrt({ api: { include: ['list', 'get'] } })
class NestedScopeBoard extends SmrtObject {
  @field({ type: 'text' })
  title = '';
}

const CLASSES = ['NestedScopeDoc', 'NestedScopePage', 'NestedScopeBoard'];
const keyOf = (name: string) =>
  ObjectRegistry.getClass(name)?.qualifiedName || name;
const segmentOf = (name: string) =>
  ObjectRegistry.getClass(name)?.collection as string;

for (const type of ['sqlite', 'postgres'] as const) {
  const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
  const suite = type === 'postgres' && !pgUrl ? describe.skip : describe;

  suite(`nested dispatch inside a principal request on ${type}`, () => {
    let db: DatabaseInterface;
    /** Tenants the exposure gate was asked about, by model. */
    let gateTenants: Array<[string, string | null | undefined]>;

    const writer: APIRequestPrincipal = {
      tenantId: TENANT_A,
      userId: 'user-a',
      allowCrossTenant: false,
      authenticated: true,
      permissions: [],
    };

    const outer = (config: APIConfig = {}) =>
      new APIGenerator(
        {
          basePath: '/api',
          resolvePrincipal: (req) =>
            req.headers.get('x-principal') === 'writer' ? writer : null,
          ...config,
        },
        { db },
      ).generateHandler();
    const inner = (config: APIConfig = {}, context: APIContext = {}) =>
      new APIGenerator(
        { basePath: '/api', ...config },
        { db, ...context },
      ).generateHandler();
    const get = (target: (req: Request) => Promise<Response>, path: string) =>
      target(new Request(`http://local/api/${path}`));
    const inspectAsWriter = async (work: () => Promise<unknown> | unknown) => {
      inspectWork = work;
      const response = await outer()(
        new Request(`http://local/api/${segmentOf('NestedScopeDoc')}/inspect`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-principal': 'writer',
          },
          body: '{}',
        }),
      );
      return { status: response.status, seen: inspected };
    };

    beforeEach(async () => {
      ObjectRegistry.registerCollection(
        'NestedScopeDoc',
        NestedScopeDocCollection as never,
      );
      ObjectRegistry.registerCollection(
        'NestedScopePage',
        NestedScopePageCollection as never,
      );
      db = await getTestDatabase({
        type,
        url: type === 'postgres' ? pgUrl : ':memory:',
        classes: CLASSES,
      });
      writer.permissions = [`${segmentOf('NestedScopeDoc')}.inspect`];
      gateTenants = [];
      setRuntimeExposureGate({
        isEnabled(model, context) {
          const key = model.qualifiedName ?? '';
          gateTenants.push([key, context.tenantId]);
          if (key === keyOf('NestedScopeBoard')) {
            return context.tenantId === TENANT_B;
          }
          // The outer request (it carries the principal header) is not
          // served the page subtype; the nested request is.
          if (key === keyOf('NestedScopePage')) {
            return (
              outerSeesPages || !context.request?.headers.has('x-principal')
            );
          }
          return true;
        },
      });
      inspectWork = undefined;
      inspected = undefined;
      peekWork = undefined;
      outerSeesPages = false;
      const docs = new NestedScopeDocCollection({ db });
      await docs.initialize();
      await docs.create({ title: 'doc' } as never);
      const page = new NestedScopePage({ db, title: 'page', page: 'p' });
      await page.initialize();
      await page.save();
    });
    afterEach(async () => {
      setRuntimeExposureGate(undefined);
      await db?.close?.();
    });

    it("a nested handler's own tenant answers are not consulted", async () => {
      let tenantCalls = 0;
      const nested = inner(
        {
          resolveTenant: () => {
            tenantCalls += 1;
            return { tenantId: TENANT_B };
          },
        },
        { tenantId: TENANT_B },
      );
      const { status, seen } = await inspectAsWriter(async () => {
        const response = await get(nested, segmentOf('NestedScopeBoard'));
        return response.status;
      });
      expect(status).toBe(200);
      // Switched on for TENANT_B only: the principal's TENANT_A decides.
      expect(seen).toBe(404);
      expect(tenantCalls).toBe(0);
      expect(
        gateTenants.filter(([key]) => key === keyOf('NestedScopeBoard')),
      ).toEqual([[keyOf('NestedScopeBoard'), TENANT_A]]);
    });

    it('a nested operation reads no member the enclosing one left out', async () => {
      const nested = inner();
      const { status, seen } = await inspectAsWriter(async () => {
        const outerAdmitted = [...(getResolvedTenancy()?.admitted ?? [])];
        const list = await get(nested, segmentOf('NestedScopeDoc'));
        const titles = ((await list.json()) as Array<{ title: string }>)
          .map((row) => row.title)
          .sort();
        const pages = await get(nested, segmentOf('NestedScopePage'));
        return {
          outerAdmitted,
          listStatus: list.status,
          titles,
          pagesStatus: pages.status,
          pages: ((await pages.json()) as unknown[]).length,
        };
      });
      expect(status).toBe(200);
      expect(seen).toEqual({
        outerAdmitted: [keyOf('NestedScopeDoc')],
        listStatus: 200,
        titles: ['doc'],
        pagesStatus: 200,
        pages: 0,
      });
      // Outside a principal request the nested server serves both.
      const signedIn = inner({ authMiddleware: () => async (req) => req });
      const direct = (await (
        await get(signedIn, segmentOf('NestedScopeDoc'))
      ).json()) as Array<{ title: string }>;
      expect(direct.map((row) => row.title).sort()).toEqual(['doc', 'page']);
    });

    it('a nested read frame keeps the enclosing create ceiling', async () => {
      // The outer POST reads doc and page rows but creates docs only (the
      // page subtype does not open create).
      outerSeesPages = true;
      const nested = inner();
      peekWork = async () => {
        const tenancy = getResolvedTenancy();
        const outcome: Record<string, unknown> = {
          admitted: [...(tenancy?.admitted ?? [])].sort(),
        };
        for (const [name, make] of [
          ['page', () => new NestedScopePage({ db, title: 'n', page: 'x' })],
          ['doc', () => new NestedScopeDoc({ db, title: 'n' })],
        ] as const) {
          try {
            const row = make();
            await row.initialize();
            await row.save();
            outcome[name] = 'created';
          } catch (error) {
            outcome[name] = (error as { code?: string }).code ?? 'refused';
          }
        }
        return outcome;
      };
      const { status, seen } = await inspectAsWriter(async () => {
        const outerTenancy = getResolvedTenancy();
        const response = await get(
          nested,
          `${segmentOf('NestedScopeDoc')}/peek`,
        );
        return {
          outerAdmitted: [...(outerTenancy?.admitted ?? [])].sort(),
          outerCreatable: [...(outerTenancy?.creatable ?? [])].sort(),
          status: response.status,
          body: await response.json(),
        };
      });
      expect(status).toBe(200);
      const both = [keyOf('NestedScopeDoc'), keyOf('NestedScopePage')].sort();
      expect(seen).toEqual({
        outerAdmitted: both,
        outerCreatable: [keyOf('NestedScopeDoc')],
        status: 200,
        body: {
          action: 'peek',
          result: {
            result: {
              admitted: both,
              page: 'TENANT_MEMBER_EXCLUDED',
              doc: 'created',
            },
          },
        },
      });
    });

    it('request code cannot open a trusted operation frame', async () => {
      const { status, seen } = await inspectAsWriter(async () => {
        const current = getResolvedTenancy();
        if (!current) throw new Error('no bound tenancy');
        const results: Record<string, string> = {};
        for (const [name, actor] of [
          ['another tenant', { ...current.actor, tenantId: TENANT_B }],
          ['system', { ...current.actor, tenantId: null, system: 'write' }],
          ['bypass', { ...current.actor, bypass: true }],
          ['same actor', current.actor],
        ] as const) {
          try {
            results[name] = await withResolvedTenancy(
              resolveRequestTenancy({
                model: current.model,
                served: [],
                actor,
              }),
              async () => `bound:${getResolvedTenancy()?.actor.tenantId}`,
              { principal: true } as never,
            );
          } catch {
            results[name] = 'refused';
          }
        }
        return results;
      });
      expect(status).toBe(200);
      expect(seen).toEqual({
        'another tenant': 'refused',
        system: 'refused',
        bypass: 'refused',
        'same actor': `bound:${TENANT_A}`,
      });
    });
  });
}
