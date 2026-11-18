/**
 * The tenant filter is recognised by the column a key resolves to.
 *
 * A `where` key is caller spelling: `tenantId`, `tenant_id`, `TenantId` and
 * `tenantId =` all filter the column `tenant_id`. These tests hold the
 * guarantee that follows: under a tenant context, a read returns that tenant's
 * rows or is refused, whatever spellings a filter uses and in whatever order,
 * through `collection.list/count/get`, the runtime REST list and count routes,
 * and the in-process MCP list and get tools.
 *
 * Real in-memory SQLite and the real tenant interceptor; nothing is mocked.
 * The suite lives here because core cannot depend on tenancy.
 */

import {
  applyWhereScope,
  field,
  ObjectRegistry,
  parseRestListWhere,
  SmrtCollection,
  SmrtObject,
  smrt,
  WhereClauseError,
} from '@happyvertical/smrt-core';
import { MCPGenerator } from '@happyvertical/smrt-core/generators/mcp';
import { APIGenerator } from '@happyvertical/smrt-core/generators/rest';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TenantIsolationError, withTenant } from '../context.js';
import { TenantScoped, tenantId } from '../decorators.js';
import { disableTenancy, enableTenancy } from '../interceptor.js';
import { withTenantGlobalRead } from '../tenant-global-queries.js';
import { runTenantHierarchyReadScope } from '../tenant-hierarchy-read-scope.js';

const OURS = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaa1';
const THEIRS = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbb2';
const PARENT = 'cccccccc-3333-4333-8333-ccccccccccc3';

// Authenticated model in the default `required` mode.
@smrt({ mcp: { include: ['list', 'get'] } })
@TenantScoped()
class SpellingOrder extends SmrtObject {
  @field({ type: 'text' })
  title = '';

  @field({ type: 'integer' })
  amount = 0;

  @tenantId({ nullable: true })
  tenantId: string | null = null;

  constructor(options: any = {}) {
    super(options);
    if (options.title !== undefined) this.title = options.title;
    if (options.amount !== undefined) this.amount = options.amount;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }
}

class SpellingOrderCollection extends SmrtCollection<SpellingOrder> {
  static readonly _itemClass = SpellingOrder;
}

// Publicly readable model in `optional` mode: anonymous reads see only rows
// that belong to no tenant.
@smrt({ api: { public: 'read' } })
@TenantScoped({ mode: 'optional' })
class SpellingNotice extends SmrtObject {
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

class SpellingNoticeCollection extends SmrtCollection<SpellingNotice> {
  static readonly _itemClass = SpellingNotice;
}

/** Every way to write an equality filter on the tenant column. */
const TENANT_KEY_SPELLINGS = [
  'tenantId',
  'tenant_id',
  'TenantId',
  'tenantId =',
  'tenant_id =',
  ' tenant_id ',
  'tenant_id  =',
] as const;

/** Two different spellings with the caller's own tenant on one of them. */
const MIXED_FILTERS: Array<[string, Record<string, unknown>]> = [];
for (const own of TENANT_KEY_SPELLINGS) {
  for (const other of TENANT_KEY_SPELLINGS) {
    if (own === other) continue;
    MIXED_FILTERS.push([
      `'${own}' ours then '${other}' theirs`,
      { [own]: OURS, [other]: THEIRS },
    ]);
    MIXED_FILTERS.push([
      `'${other}' theirs then '${own}' ours`,
      { [other]: THEIRS, [own]: OURS },
    ]);
  }
}

const titles = (rows: Array<{ title: string }>) =>
  rows.map((row) => row.title).sort();

const OUR_TITLES = ['our order 1', 'our order 2'];

describe('tenant filter key spellings', () => {
  let db: any;
  let orders: SpellingOrderCollection;
  let notices: SpellingNoticeCollection;
  let handler: (req: Request) => Promise<Response>;
  let anonymousHandler: (req: Request) => Promise<Response>;
  let theirOrderId: string;
  let ourOrderId: string;

  const asUs = <T>(run: () => Promise<T>): Promise<T> =>
    withTenant({ tenantId: OURS, userId: 'reader' }, run);

  beforeAll(async () => {
    ObjectRegistry.registerCollection('SpellingOrder', SpellingOrderCollection);
    ObjectRegistry.registerCollection(
      'SpellingNotice',
      SpellingNoticeCollection,
    );
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['SpellingOrder', 'SpellingNotice'],
    });
    orders = await SpellingOrderCollection.create({ db });
    notices = await SpellingNoticeCollection.create({ db });

    enableTenancy();

    await withTenant({ tenantId: OURS }, async () => {
      ourOrderId = (await orders.create({ title: 'our order 1', amount: 1 }))
        .id as string;
      await orders.create({ title: 'our order 2', amount: 5 });
      await notices.create({ title: 'our notice' });
    });
    await withTenant({ tenantId: THEIRS }, async () => {
      theirOrderId = (
        await orders.create({ title: 'their order 1', amount: 1 })
      ).id as string;
      await orders.create({ title: 'their order 2', amount: 5 });
      await notices.create({ title: 'their notice' });
    });
    await withTenant({ tenantId: PARENT }, async () => {
      await orders.create({ title: 'parent order', amount: 9 });
    });
    await notices.create({ title: 'notice for everyone' });

    const api = new APIGenerator(
      {
        basePath: '/api',
        authMiddleware: () => async (req: Request) =>
          req.headers.get('authorization') === 'Bearer reader'
            ? req
            : new Response('unauthorized', { status: 401 }),
      },
      { db },
    );
    api.registerCollection('orders', orders as any);
    handler = api.generateHandler();

    // No auth middleware: `api.public: 'read'` is what admits these reads.
    const anonymousApi = new APIGenerator({ basePath: '/api' }, { db });
    anonymousApi.registerCollection('notices', notices as any);
    anonymousHandler = anonymousApi.generateHandler();
  });

  afterAll(async () => {
    disableTenancy();
    await db?.close?.();
  });

  describe('collection reads under a tenant context', () => {
    it.each(
      MIXED_FILTERS,
    )('list, count and get refuse %s', async (_label, where) => {
      await expect(asUs(() => orders.list({ where }))).rejects.toThrow(
        TenantIsolationError,
      );
      await expect(asUs(() => orders.count({ where }))).rejects.toThrow(
        TenantIsolationError,
      );
      await expect(
        asUs(() => orders.get({ ...where, id: theirOrderId })),
      ).rejects.toThrow(TenantIsolationError);
    });

    it.each(
      TENANT_KEY_SPELLINGS,
    )('refuses another tenant under the single key %j', async (key) => {
      const where = { [key]: THEIRS };
      await expect(asUs(() => orders.list({ where }))).rejects.toThrow(
        TenantIsolationError,
      );
      await expect(asUs(() => orders.count({ where }))).rejects.toThrow(
        TenantIsolationError,
      );
      await expect(
        asUs(() => orders.get({ ...where, id: theirOrderId })),
      ).rejects.toThrow(TenantIsolationError);
    });

    it.each(
      TENANT_KEY_SPELLINGS,
    )('accepts an explicit own-tenant filter written as %j', async (key) => {
      const where = { [key]: OURS };
      expect(titles(await asUs(() => orders.list({ where })))).toEqual(
        OUR_TITLES,
      );
      expect(await asUs(() => orders.count({ where }))).toBe(2);
      const row = await asUs(() => orders.get({ ...where, id: ourOrderId }));
      expect(row?.title).toBe('our order 1');
      // The id of another tenant's row finds nothing under our tenant.
      expect(
        await asUs(() => orders.get({ ...where, id: theirOrderId })),
      ).toBeNull();
    });

    it('refuses two spellings of the tenant filter even when both name our tenant', async () => {
      const where = { tenantId: OURS, tenant_id: OURS };
      await expect(asUs(() => orders.list({ where }))).rejects.toThrow(
        WhereClauseError,
      );
      await expect(asUs(() => orders.count({ where }))).rejects.toMatchObject({
        code: 'INVALID_WHERE_CLAUSE',
        status: 400,
      });
      await expect(
        asUs(() => orders.get({ ...where, id: ourOrderId })),
      ).rejects.toThrow(WhereClauseError);
    });

    it('refuses an own-tenant list beside an explicit list of other tenants', async () => {
      // Both keys resolve to `tenant_id in`.
      const where = { tenantId: [OURS], 'tenant_id in': [THEIRS] };
      await expect(asUs(() => orders.list({ where }))).rejects.toThrow(
        WhereClauseError,
      );
      await expect(asUs(() => orders.count({ where }))).rejects.toThrow(
        WhereClauseError,
      );
    });

    it('keeps our tenant predicate beside operator filters on the tenant column', async () => {
      for (const where of [
        { 'tenant_id in': [THEIRS] },
        { 'TenantId !=': OURS },
        { 'tenant_id not in': [OURS] },
      ]) {
        expect(await asUs(() => orders.list({ where }))).toEqual([]);
        expect(await asUs(() => orders.count({ where }))).toBe(0);
      }
      // An operator filter that includes our tenant narrows to our rows only.
      expect(
        titles(
          await asUs(() =>
            orders.list({ where: { 'tenant_id in': [OURS, THEIRS] } }),
          ),
        ),
      ).toEqual(OUR_TITLES);
    });

    it('checks every branch and condition of a DNF filter', async () => {
      for (const where of [
        [[{ tenantId: OURS, tenant_id: THEIRS }]],
        [[{ tenantId: OURS }, { tenant_id: THEIRS }]],
        [[{ title: 'our order 1' }], [{ TenantId: THEIRS }]],
        [[{ 'tenant_id =': THEIRS }]],
      ]) {
        await expect(asUs(() => orders.list({ where }))).rejects.toThrow(
          TenantIsolationError,
        );
        await expect(asUs(() => orders.count({ where }))).rejects.toThrow(
          TenantIsolationError,
        );
      }
      const rows = await asUs(() =>
        orders.list({
          where: [[{ title: 'our order 1' }], [{ TenantId: OURS, amount: 5 }]],
        }),
      );
      expect(titles(rows)).toEqual(OUR_TITLES);
    });

    it('still serves a range: two operators on one column', async () => {
      const where = { 'amount >=': 1, 'amount <': 5 };
      expect(titles(await asUs(() => orders.list({ where })))).toEqual([
        'our order 1',
      ]);
      expect(await asUs(() => orders.count({ where }))).toBe(1);
    });
  });

  describe('hierarchy and tenant/global read scopes', () => {
    const scope = {
      actorTenantId: OURS,
      actorUserId: 'reader',
      collections: ['@happyvertical/smrt-tenancy:SpellingOrder'],
      tenantIds: [OURS, PARENT],
      includeGlobal: false,
    };

    it.each(
      TENANT_KEY_SPELLINGS,
    )('a hierarchy scope refuses an out-of-scope tenant written as %j', async (key) => {
      await asUs(() =>
        runTenantHierarchyReadScope(scope, async () => {
          await expect(
            orders.list({ where: { [key]: THEIRS } }),
          ).rejects.toThrow(TenantIsolationError);
          await expect(
            orders.list({ where: { title: 'their order 1', [key]: THEIRS } }),
          ).rejects.toThrow(TenantIsolationError);
          await expect(
            orders.list({ where: [[{ [key]: PARENT }, { [key]: THEIRS }]] }),
          ).rejects.toThrow(TenantIsolationError);
          expect(
            titles(await orders.list({ where: { [key]: PARENT } })),
          ).toEqual(['parent order']);
        }),
      );
    });

    it('a tenant/global read keeps its own predicate beside any spelling', async () => {
      for (const key of TENANT_KEY_SPELLINGS) {
        const rows = await asUs(() =>
          withTenantGlobalRead(OURS, () =>
            notices.list({ where: { [key]: THEIRS } }),
          ),
        );
        expect(rows).toEqual([]);
      }
      const visible = await asUs(() =>
        withTenantGlobalRead(OURS, () => notices.list({})),
      );
      expect(titles(visible)).toEqual(['notice for everyone', 'our notice']);
    });
  });

  describe('runtime REST list and count', () => {
    const asUsOverRest = (path: string) =>
      asUs(() =>
        handler(
          new Request(`http://local/api/${path}`, {
            headers: { authorization: 'Bearer reader' },
          }),
        ),
      );
    const enc = encodeURIComponent;

    /** Query strings that pair our tenant with another under two spellings. */
    const MIXED_QUERIES = [
      `tenantId=${OURS}&tenant_id=${THEIRS}`,
      `tenant_id=${THEIRS}&tenantId=${OURS}`,
      `tenantId=${OURS}&TenantId=${THEIRS}`,
      `TenantId=${THEIRS}&tenantId=${OURS}`,
      `tenantId=${OURS}&${enc('tenant_id =')}=${THEIRS}`,
      `tenantId=${OURS}&${enc('tenant_id[=]')}=${THEIRS}`,
      `${enc('tenantId[=]')}=${THEIRS}&tenant_id=${OURS}`,
      `tenantId=${OURS}&${enc(' tenant_id')}=${THEIRS}`,
      `tenant_id=${OURS}&tenantId=${THEIRS}`,
    ];

    it.each(MIXED_QUERIES)('refuses ?%s on list and count', async (query) => {
      for (const path of [`orders?${query}`, `orders/count?${query}`]) {
        const response = await asUsOverRest(path);
        expect(response.status).not.toBe(200);
        expect(await response.text()).not.toContain('their order');
      }
    });

    it.each([
      `tenant_id=${THEIRS}`,
      `TenantId=${THEIRS}`,
      `${enc('tenant_id[=]')}=${THEIRS}`,
    ])('refuses another tenant under the single alias ?%s', async (query) => {
      for (const path of [`orders?${query}`, `orders/count?${query}`]) {
        const response = await asUsOverRest(path);
        expect(response.status).not.toBe(200);
        expect(await response.text()).not.toContain('their order');
      }
    });

    it('answers 400 when two spellings both name our tenant', async () => {
      const list = await asUsOverRest(
        `orders?tenantId=${OURS}&tenant_id=${OURS}`,
      );
      expect(list.status).toBe(400);
      expect((await list.json()).error.code).toBe('INVALID_WHERE_CLAUSE');
      const count = await asUsOverRest(
        `orders/count?tenantId=${OURS}&tenant_id=${OURS}`,
      );
      expect(count.status).toBe(400);
    });

    it.each([
      'tenantId',
      'tenant_id',
      'TenantId',
    ])('serves an explicit own-tenant filter written as %s', async (key) => {
      const list = await asUsOverRest(`orders?${key}=${OURS}`);
      expect(list.status).toBe(200);
      expect(titles(await list.json())).toEqual(OUR_TITLES);
      const count = await asUsOverRest(`orders/count?${key}=${OURS}`);
      expect(await count.json()).toEqual({ count: 2 });
    });

    it('serves a range filter and plain reads', async () => {
      const ranged = await asUsOverRest(
        `orders?${enc('amount[gte]')}=1&${enc('amount[lt]')}=5`,
      );
      expect(ranged.status).toBe(200);
      expect(titles(await ranged.json())).toEqual(['our order 1']);
      const all = await asUsOverRest('orders');
      expect(titles(await all.json())).toEqual(OUR_TITLES);
      const count = await asUsOverRest('orders/count');
      expect(await count.json()).toEqual({ count: 2 });
    });

    it('keeps our tenant predicate beside operator filters', async () => {
      const response = await asUsOverRest(
        `orders?tenantId=${OURS}&${enc('tenant_id[in]')}=${THEIRS}`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([]);
    });
  });

  describe('anonymous reads of a publicly readable model', () => {
    const enc = encodeURIComponent;
    const QUERIES = [
      `tenantId=x&tenant_id=${THEIRS}`,
      `tenant_id=${THEIRS}&tenantId=x`,
      `TenantId=${THEIRS}`,
      `${enc(' tenant_id')}=${THEIRS}`,
      `${enc('tenant_id[=]')}=${THEIRS}`,
      `${enc('tenant_id[ne]')}=x`,
      `${enc('TenantId[in]')}=${THEIRS},${OURS}`,
    ];

    it.each(
      QUERIES,
    )('runtime REST serves only rows without a tenant for ?%s', async (query) => {
      const list = await anonymousHandler(
        new Request(`http://local/api/notices?${query}`),
      );
      expect(list.status).toBe(200);
      expect(titles(await list.json())).toEqual(['notice for everyone']);
      const count = await anonymousHandler(
        new Request(`http://local/api/notices/count?${query}`),
      );
      expect(await count.json()).toEqual({ count: 1 });
    });

    it.each(
      QUERIES,
    )('the where the generated list route builds serves only rows without a tenant for ?%s', async (query) => {
      // The emitted SvelteKit route runs exactly this expression when tenancy
      // is enabled and no tenant context is active; its emission is asserted
      // in core's generator suites.
      const where = applyWhereScope(
        parseRestListWhere(new URLSearchParams(query)),
        { tenantId: null },
      );
      expect(where).toEqual({ tenantId: null });
      expect(titles(await notices.list({ where }))).toEqual([
        'notice for everyone',
      ]);
      expect(await notices.count({ where })).toBe(1);
    });
  });

  describe('in-process MCP list and get', () => {
    let call: (tool: string, args: unknown) => Promise<any>;
    let listTool: string;
    let getTool: string;

    beforeAll(async () => {
      const generator = new MCPGenerator(
        { classNames: ['SpellingOrder'] } as any,
        { db, tenantId: OURS, user: { id: 'reader' } } as any,
      );
      const tools = await generator.generateTools();
      const named = (suffix: string) =>
        tools.find((tool: { name: string }) => tool.name.endsWith(suffix))
          ?.name as string;
      listTool = named('_list');
      getTool = named('_get');
      call = (tool, args) =>
        generator.handleToolCall({
          method: 'tools/call',
          params: { name: tool, arguments: args },
        } as any);
    });

    const text = (result: any) =>
      result.content.map((entry: { text: string }) => entry.text).join('\n');

    it.each(MIXED_FILTERS)('list refuses %s', async (_label, where) => {
      const result = await call(listTool, { where });
      expect(result.isError).toBe(true);
      expect(text(result)).not.toContain('their order');
    });

    it.each(
      MIXED_FILTERS,
    )('get refuses an object id with %s', async (_label, where) => {
      const result = await call(getTool, {
        id: { ...where, id: theirOrderId },
      });
      expect(result.isError).toBe(true);
      expect(text(result)).not.toContain('their order');
    });

    it('get by the id of another tenant row finds nothing', async () => {
      const result = await call(getTool, { id: theirOrderId });
      expect(result.isError).toBe(true);
      expect(text(result)).not.toContain('their order');
    });

    it('list serves our rows, an own-tenant alias and a range', async () => {
      const plain = JSON.parse(text(await call(listTool, {})));
      expect(titles(plain.data)).toEqual(OUR_TITLES);
      expect(plain.meta.total).toBe(2);

      const aliased = JSON.parse(
        text(await call(listTool, { where: { tenant_id: OURS } })),
      );
      expect(titles(aliased.data)).toEqual(OUR_TITLES);

      const ranged = JSON.parse(
        text(
          await call(listTool, { where: { 'amount >=': 1, 'amount <': 5 } }),
        ),
      );
      expect(titles(ranged.data)).toEqual(['our order 1']);
      expect(ranged.meta.total).toBe(1);
    });

    it('get serves our own row', async () => {
      const result = await call(getTool, { id: ourOrderId });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(text(result)).title).toBe('our order 1');
    });
  });
});
