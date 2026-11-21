/**
 * Default change-feed table policy (#5446).
 *
 * With no table authorizer registered, every transport — the reads behind the
 * generated SvelteKit `_changes`/`_events` routes
 * (`getAuthorizedTenantScopedChangesSince`, `buildChangeEventStream`) and the
 * runtime REST generator's `handleChangesRoute`/`handleEventsRoute` — serves
 * a table only when a list/get of its model would be served on that
 * transport: a registered, non-internal model whose API action gate opens
 * `list`, admitted by the runtime exposure gate and, on REST, by the route's
 * `authMiddleware(model, 'get')`. Refused tables still advance the cursor.
 * A registered authorizer replaces the default; `allowAllChangeFeedTables`
 * restores the behaviour before #5446.
 *
 * Runs on SQLite always and on PGlite under `pnpm test:pglite`.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendChange,
  ensureChangeFeedTable,
  getChangesSince,
  registerChangeFeedWriter,
  resetChangeFeedWarnings,
} from '../change-feed';
import {
  allowAllChangeFeedTables,
  type ChangeFeedTableAuthorizer,
  getAuthorizedTenantScopedChangesSince,
  resolveAuthorizedChangeFeedTables,
  setChangeFeedAuthorizer,
  setChangeFeedEntryVisibility,
} from '../change-feed-authz';
import { publishChangeSignal, resetChangeSignals } from '../change-signals';
import { SmrtCollection } from '../collection';
import { setDispatchTenantResolver } from '../dispatch/tenant-resolver';
import {
  type ChangesAuthMiddleware,
  handleChangesRoute,
} from '../generators/changes-route';
import {
  buildChangeEventStream,
  handleEventsRoute,
} from '../generators/events-route';
import { APIGenerator, createRestServer } from '../generators/rest';
import { SmrtJunction } from '../junction';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import {
  setRuntimeExposureGate,
  setRuntimeModelOwner,
} from '../runtime-exposure';
import { getTestDatabase } from '../testing/database';

// ---------------------------------------------------------------------------
// Fixture models (one per rule)
// ---------------------------------------------------------------------------

@smrt({ tableName: 'issue5446_orders' })
class Issue5446Order extends SmrtObject {
  label: string = '';
  tenantId: string = '';
}

@smrt({ tableName: 'issue5446_hidden', api: false })
class Issue5446Hidden extends SmrtObject {
  label: string = '';
}

@smrt({
  tableName: 'issue5446_write_only',
  api: { include: ['create', 'get'] },
})
class Issue5446WriteOnly extends SmrtObject {
  label: string = '';
}

@smrt({ tableName: 'issue5446_no_list', api: { exclude: ['list'] } })
class Issue5446NoList extends SmrtObject {
  label: string = '';
}

@smrt({ tableName: 'issue5446_switched_off' })
class Issue5446SwitchedOff extends SmrtObject {
  label: string = '';
}

@smrt({ tableName: 'issue5446_links' })
class Issue5446Link extends SmrtObject {
  ownerId: string = '';
  assetId: string = '';
}

@smrt()
class Issue5446LinkCollection extends SmrtJunction<Issue5446Link> {
  static readonly _itemClass = Issue5446Link;
  protected leftField = 'ownerId';
  protected rightField = 'assetId';
}

@smrt({ tableName: 'issue5446_listed_links', api: { include: ['list'] } })
class Issue5446ListedLink extends SmrtObject {
  ownerId: string = '';
  assetId: string = '';
}

@smrt()
class Issue5446ListedLinkCollection extends SmrtJunction<Issue5446ListedLink> {
  static readonly _itemClass = Issue5446ListedLink;
  protected leftField = 'ownerId';
  protected rightField = 'assetId';
}

@smrt({ tableName: 'issue5446_shapes', tableStrategy: 'sti', api: false })
class Issue5446Shape extends SmrtObject {
  label: string = '';
}

@smrt()
class Issue5446Circle extends Issue5446Shape {
  radius: number = 0;
}

// Registered domain models on `_smrt_`-named tables (#2376): decided by the
// model's own rules, like any other model.
@smrt({ tableName: '_smrt_issue5446_settings' })
class Issue5446Setting extends SmrtObject {
  value: string = '';
}

@smrt({ tableName: '_smrt_issue5446_hidden_settings', api: false })
class Issue5446HiddenSetting extends SmrtObject {
  value: string = '';
}

@smrt({ tableName: 'issue5446_secrets', sensitive: true })
class Issue5446Secret extends SmrtObject {
  value: string = '';
}

// An STI table whose base is exposed: served through the base even though a
// subtype closes its own API.
@smrt({ tableName: 'issue5446_vehicles', tableStrategy: 'sti' })
class Issue5446Vehicle extends SmrtObject {
  label: string = '';
}

@smrt({ api: false })
class Issue5446Truck extends Issue5446Vehicle {
  axles: number = 0;
}

// Every registration of this table is abstract.
@smrt({ tableName: 'issue5446_abstract_only', abstract: true })
class Issue5446AbstractOnly extends SmrtObject {
  label: string = '';
}

// Two models decide one table; one closes its API, so the table is refused.
@smrt({ tableName: 'issue5446_shared' })
class Issue5446SharedOpen extends SmrtObject {
  label: string = '';
}

@smrt({ tableName: 'issue5446_shared', api: false })
class Issue5446SharedClosed extends SmrtObject {
  label: string = '';
}

void Issue5446Truck;
void Issue5446AbstractOnly;
void Issue5446SharedOpen;
void Issue5446SharedClosed;

// Collections referenced so the bundler keeps the junction classes.
void Issue5446LinkCollection;
void Issue5446ListedLinkCollection;
class Issue5446OrderCollection extends SmrtCollection<Issue5446Order> {
  static readonly _itemClass = Issue5446Order;
}
void Issue5446OrderCollection;
void Issue5446Hidden;
void Issue5446WriteOnly;
void Issue5446NoList;
void Issue5446Circle;
void Issue5446Setting;
void Issue5446HiddenSetting;
void Issue5446Secret;

const T = {
  orders: 'issue5446_orders',
  hidden: 'issue5446_hidden',
  writeOnly: 'issue5446_write_only',
  noList: 'issue5446_no_list',
  switchedOff: 'issue5446_switched_off',
  links: 'issue5446_links',
  listedLinks: 'issue5446_listed_links',
  shapes: 'issue5446_shapes',
  settings: '_smrt_issue5446_settings',
  hiddenSettings: '_smrt_issue5446_hidden_settings',
  secrets: 'issue5446_secrets',
  unregistered: 'issue5446_unregistered',
  vehicles: 'issue5446_vehicles',
  abstractOnly: 'issue5446_abstract_only',
  shared: 'issue5446_shared',
} as const;

/** One entry per table, in this order; seq = index + 1. */
const SEEDED = [
  T.orders,
  T.hidden,
  T.writeOnly,
  T.noList,
  T.switchedOff,
  T.links,
  T.listedLinks,
  T.shapes,
  T.settings,
  T.hiddenSettings,
  T.unregistered,
  T.vehicles,
  T.abstractOnly,
  T.shared,
];

/** The tables the default serves (with the runtime gate below installed). */
const DEFAULT_SERVED = [T.orders, T.listedLinks, T.settings, T.vehicles];

const locals = { user: { id: 'member-1' } };
const request = new Request('http://localhost/api/_changes');
const UNENFORCED_SCOPE = { enforced: false, tenantId: null } as const;
const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';

function registryKey(
  info: { qualifiedName?: string; name: string } | undefined,
): string | undefined {
  return info ? info.qualifiedName || info.name : undefined;
}

function isModel(objectName: string, className: string): boolean {
  return objectName === className || objectName.endsWith(`:${className}`);
}

/** REST middleware: admits everything except `get` on orders for `x-deny`. */
const restAuth: ChangesAuthMiddleware =
  (objectName, action) =>
  async (req: Request): Promise<Request | Response> =>
    action === 'get' &&
    isModel(objectName, 'Issue5446Order') &&
    req.headers.get('x-deny') === 'orders'
      ? new Response('Forbidden', { status: 403 })
      : req;

interface Engine {
  name: string;
  enabled: boolean;
  create(): Promise<DatabaseInterface>;
}

const engines: Engine[] = [
  {
    name: 'sqlite',
    enabled: true,
    create: () =>
      getTestDatabase({ type: 'sqlite', url: ':memory:', classes: [] }),
  },
  {
    name: 'pglite',
    enabled: process.env.SMRT_TEST_PGLITE === '1',
    create: async () =>
      (await getTestDatabase({
        type: 'pglite',
        classes: [],
      })) as DatabaseInterface,
  },
];

async function readChangesBody(response: Response): Promise<{
  changes: Array<{ rowId: string; table: string; tenantId: string | null }>;
  cursor: number;
}> {
  const body = (await response.json()) as {
    changes: Array<{ rowId: string; table: string; tenantId: string | null }>;
    cursor: number;
  };
  if (!Array.isArray(body.changes) || typeof body.cursor !== 'number') {
    throw new Error('Expected a changes response with rows and cursor');
  }
  return body;
}

/**
 * Read the SSE text a stream produced within `ms`, stopping early once
 * `done(text)` holds. A stream that ends on its own fails the read: every
 * stream here stays open until cancelled, so a missing frame can only mean
 * it was not framed, never that the stream closed on an error.
 */
async function readStreamText(
  stream: ReadableStream<Uint8Array> | null,
  ms = 400,
  done: (text: string) => boolean = () => false,
): Promise<string> {
  if (!stream) return '';
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline && !done(text)) {
      const timeout = new Promise<'timeout'>((resolve) =>
        setTimeout(
          () => resolve('timeout'),
          Math.max(1, deadline - Date.now()),
        ),
      );
      const result = await Promise.race([reader.read(), timeout]);
      if (result === 'timeout') break;
      if (result.done) throw new Error('stream ended before it was cancelled');
      if (result.value) text += decoder.decode(result.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
    await stream.cancel().catch(() => undefined);
  }
  return text;
}

function framedTables(text: string): string[] {
  const tables: string[] = [];
  for (const block of text.split('\n\n')) {
    if (!block.includes('event: change')) continue;
    const data = /^data: (.*)$/m.exec(block);
    if (data) tables.push((JSON.parse(data[1]) as { table: string }).table);
  }
  return tables;
}

const tablesOf = (changes: Array<{ table: string }>) =>
  changes.map((c) => c.table);

for (const engine of engines) {
  describe.skipIf(!engine.enabled)(
    `change-feed default table policy (#5446, ${engine.name})`,
    () => {
      let db: DatabaseInterface;

      beforeEach(async () => {
        registerChangeFeedWriter();
        resetChangeFeedWarnings();
        resetChangeSignals();
        setChangeFeedAuthorizer(undefined);
        setChangeFeedEntryVisibility(undefined);
        setRuntimeExposureGate({
          isEnabled: (model) =>
            !isModel(model.qualifiedName ?? '', 'Issue5446SwitchedOff'),
        });
        db = await engine.create();
        await ensureChangeFeedTable(db);
        for (const table of SEEDED) {
          await appendChange(db, { table, rowId: `${table}-1` });
        }
      });

      afterEach(async () => {
        setChangeFeedAuthorizer(undefined);
        setChangeFeedEntryVisibility(undefined);
        setRuntimeExposureGate(undefined);
        setDispatchTenantResolver(undefined);
        resetChangeSignals();
        await db?.close?.();
      });

      async function sveltekitChanges(tables?: string[]) {
        return getAuthorizedTenantScopedChangesSince(db, {
          since: 0,
          tables,
          locals,
          request,
        });
      }

      async function restChanges(headers: Record<string, string> = {}) {
        const response = await handleChangesRoute(
          new Request('http://localhost/api/v1/_changes?since=0', { headers }),
          { authMiddleware: restAuth, db },
        );
        expect(response.status).toBe(200);
        return readChangesBody(response);
      }

      async function streams(
        headers: Record<string, string> = {},
        expectedFrames?: number,
      ): Promise<{ sveltekit: string; rest: string }> {
        const sveltekit = buildChangeEventStream(db, {
          cursor: 0,
          tenantScope: UNENFORCED_SCOPE,
          heartbeatMs: 60_000,
          locals,
          request,
        });
        const restResponse = await handleEventsRoute(
          new Request('http://localhost/api/v1/_events?since=0', { headers }),
          { authMiddleware: restAuth, db },
        );
        const ms = expectedFrames ? 5_000 : 400;
        const done = expectedFrames
          ? (text: string) => framedTables(text).length >= expectedFrames
          : undefined;
        const [svelteText, restText] = await Promise.all([
          readStreamText(sveltekit, ms, done),
          readStreamText(restResponse.body, ms, done),
        ]);
        return { sveltekit: svelteText, rest: restText };
      }

      it('fixtures are registered on the tables each rule names', () => {
        expect(ObjectRegistry.getTableName('Issue5446Order')).toBe(T.orders);
        expect(ObjectRegistry.getTableName('Issue5446Circle')).toBe(T.shapes);
        expect(ObjectRegistry.getTableName('Issue5446Link')).toBe(T.links);
        expect(ObjectRegistry.getTableName('Issue5446Setting')).toBe(
          T.settings,
        );
        const link = ObjectRegistry.getClass('Issue5446Link');
        expect(
          (link?.collectionConstructor as { _isJunctionBase?: boolean })
            ?._isJunctionBase,
        ).toBe(true);
      });

      describe('pull reads (_changes)', () => {
        it('serves only tables whose models a list would serve, and the cursor still advances', async () => {
          const page = await sveltekitChanges();
          expect(tablesOf(page.changes)).toEqual(DEFAULT_SERVED);
          expect(page.cursor).toBe(SEEDED.length);

          const rest = await restChanges();
          expect(tablesOf(rest.changes)).toEqual(DEFAULT_SERVED);
          expect(rest.cursor).toBe(SEEDED.length);
        });

        it.each([
          ['an api: false model', T.hidden],
          ['an api.include without list', T.writeOnly],
          ['an api.exclude of list', T.noList],
          ['a model the runtime exposure gate switches off', T.switchedOff],
          ['a junction row model without its own api', T.links],
          ['an STI table whose base is not exposed', T.shapes],
          ['a _smrt_-named table of an api: false model', T.hiddenSettings],
          ['an unregistered table', T.unregistered],
          ['a table whose registrations are all abstract', T.abstractOnly],
          ['a table two models decide when one refuses', T.shared],
        ])('refuses %s even when the client names it', async (_case, table) => {
          const page = await sveltekitChanges([table]);
          expect(page.changes).toEqual([]);
          expect(page.cursor).toBe(SEEDED.length);
        });

        it('serves an exposed domain model whose table is _smrt_-named', async () => {
          const page = await sveltekitChanges([T.settings]);
          expect(tablesOf(page.changes)).toEqual([T.settings]);
        });

        it('never serves a sensitive model’s table, nor a framework table', async () => {
          const tables = await resolveAuthorizedChangeFeedTables(
            { locals, request },
            undefined,
          );
          expect(tables).not.toContain(T.secrets);
          expect(tables).not.toContain('_smrt_changes');
          expect(
            tables?.some((t) => t.startsWith('_smrt_') && t !== T.settings),
          ).toBe(false);
        });

        it('serves a junction row model whose own api opens list', async () => {
          const page = await sveltekitChanges([T.listedLinks]);
          expect(tablesOf(page.changes)).toEqual([T.listedLinks]);
        });

        it('REST asks the route middleware about each model get', async () => {
          const denied = await restChanges({ 'x-deny': 'orders' });
          expect(tablesOf(denied.changes)).toEqual([
            T.listedLinks,
            T.settings,
            T.vehicles,
          ]);
          expect(denied.cursor).toBe(SEEDED.length);
        });

        it('keeps the tenant filter: another tenant’s entries are never served', async () => {
          await appendChange(db, {
            table: T.orders,
            rowId: 'tenant-a',
            tenantId: TENANT_A,
          });
          await appendChange(db, {
            table: T.orders,
            rowId: 'tenant-b',
            tenantId: TENANT_B,
          });
          setDispatchTenantResolver(() => TENANT_A);
          const page = await sveltekitChanges([T.orders]);
          expect(page.changes.map((c) => c.rowId)).toEqual([
            `${T.orders}-1`,
            'tenant-a',
          ]);
        });

        it('a registered authorizer replaces the default', async () => {
          setChangeFeedAuthorizer(() => [T.hidden]);
          expect(tablesOf((await sveltekitChanges()).changes)).toEqual([
            T.hidden,
          ]);
          expect(tablesOf((await restChanges()).changes)).toEqual([T.hidden]);
        });

        it('allowAllChangeFeedTables restores every table', async () => {
          setChangeFeedAuthorizer(allowAllChangeFeedTables);
          expect(tablesOf((await sveltekitChanges()).changes)).toEqual(SEEDED);
          expect(tablesOf((await restChanges()).changes)).toEqual(SEEDED);
        });

        it('clearing a registered authorizer restores the default', async () => {
          setChangeFeedAuthorizer(allowAllChangeFeedTables);
          setChangeFeedAuthorizer(undefined);
          expect(tablesOf((await sveltekitChanges()).changes)).toEqual(
            DEFAULT_SERVED,
          );
        });

        it('a row hook narrows the default and grants nothing', async () => {
          setChangeFeedEntryVisibility(({ entry }) => entry.table !== T.orders);
          expect(tablesOf((await sveltekitChanges()).changes)).toEqual([
            T.listedLinks,
            T.settings,
            T.vehicles,
          ]);
        });

        it('a collection registration decides its item’s table through the item', async () => {
          // Manifest activation registers collection classes as registry
          // entries whose table is their item's (see r1 probe in notes).
          ObjectRegistry.register(
            Issue5446LinkCollection as unknown as Parameters<
              typeof ObjectRegistry.register
            >[0],
            { name: 'Issue5446LinkCollection' },
          );
          ObjectRegistry.setCollectionTableName(
            'Issue5446LinkCollection',
            T.links,
          );
          expect(ObjectRegistry.getTableName('Issue5446LinkCollection')).toBe(
            T.links,
          );
          expect(
            registryKey(
              ObjectRegistry.getExposureModel('Issue5446LinkCollection'),
            ),
          ).toBe(registryKey(ObjectRegistry.getClass('Issue5446Link')));
          const page = await sveltekitChanges([T.links]);
          expect(page.changes).toEqual([]);
        });

        it('serves an STI table through its exposed base even when a subtype closes its api', async () => {
          const page = await sveltekitChanges([T.vehicles]);
          expect(tablesOf(page.changes)).toEqual([T.vehicles]);
        });

        it('applies the default when the authorizer slot holds a non-function', async () => {
          globalThis.__smrtChangeFeedTableAuthorizer =
            'not-a-function' as unknown as ChangeFeedTableAuthorizer;
          expect(tablesOf((await sveltekitChanges()).changes)).toEqual(
            DEFAULT_SERVED,
          );
        });

        it('recognises the all-tables answer produced by another copy of core', async () => {
          setChangeFeedAuthorizer(
            () =>
              Symbol.for(
                '@happyvertical/smrt-core:change-feed-all-tables',
              ) as ReturnType<typeof allowAllChangeFeedTables>,
          );
          expect(tablesOf((await sveltekitChanges()).changes)).toEqual(SEEDED);
        });

        it('a default-policy check that throws refuses that model only', async () => {
          setRuntimeExposureGate({
            isEnabled: (model) => {
              if (isModel(model.qualifiedName ?? '', 'Issue5446Order')) {
                throw new Error('gate unavailable');
              }
              return true;
            },
          });
          const tables = await resolveAuthorizedChangeFeedTables(
            { locals, request },
            undefined,
          );
          expect(tables).not.toContain(T.orders);
          expect(tables).toContain(T.listedLinks);
        });

        it('reads that serve no principal are unaffected', async () => {
          const page = await getChangesSince(db, { since: 0 });
          expect(tablesOf(page.changes)).toEqual(SEEDED);
        });
      });

      describe('push reads (_events)', () => {
        it('frames only tables whose models a list would serve, catch-up and live', async () => {
          const { sveltekit, rest } = await streams({}, DEFAULT_SERVED.length);
          expect(framedTables(sveltekit)).toEqual(DEFAULT_SERVED);
          expect(framedTables(rest)).toEqual(DEFAULT_SERVED);
        });

        it('frames no live change of a refused table', async () => {
          const stream = buildChangeEventStream(db, {
            cursor: null,
            tenantScope: UNENFORCED_SCOPE,
            heartbeatMs: 60_000,
            locals,
            request,
          });
          await new Promise((resolve) => setTimeout(resolve, 30));
          for (const table of [T.hidden, T.orders]) {
            const seq = await appendChange(db, { table, rowId: `${table}-2` });
            publishChangeSignal(db, {
              table,
              operation: 'update',
              rowId: `${table}-2`,
              tenantId: null,
              seq: typeof seq === 'number' ? seq : 0,
            });
          }
          const text = await readStreamText(
            stream,
            5_000,
            (t) => framedTables(t).length >= 1,
          );
          expect(framedTables(text)).toEqual([T.orders]);
        });

        it('REST _events asks the route middleware about each model get', async () => {
          const { rest } = await streams({ 'x-deny': 'orders' }, 3);
          expect(framedTables(rest)).toEqual([
            T.listedLinks,
            T.settings,
            T.vehicles,
          ]);
        });

        it('keeps the captured tenant filter', async () => {
          await appendChange(db, {
            table: T.orders,
            rowId: 'tenant-b',
            tenantId: TENANT_B,
          });
          await appendChange(db, {
            table: T.orders,
            rowId: 'tenant-a',
            tenantId: TENANT_A,
          });
          const stream = buildChangeEventStream(db, {
            cursor: 0,
            tenantScope: { enforced: true, tenantId: TENANT_A },
            heartbeatMs: 60_000,
            locals,
            request,
          });
          const text = await readStreamText(stream, 5_000, (t) =>
            t.includes('"rowId":"tenant-a"'),
          );
          expect(text).toContain('"rowId":"tenant-a"');
          expect(text).not.toContain('"rowId":"tenant-b"');
        });

        it('a registered authorizer replaces the default', async () => {
          setChangeFeedAuthorizer(() => [T.hidden]);
          const { sveltekit, rest } = await streams({}, 1);
          expect(framedTables(sveltekit)).toEqual([T.hidden]);
          expect(framedTables(rest)).toEqual([T.hidden]);
        });

        it('allowAllChangeFeedTables frames every table', async () => {
          setChangeFeedAuthorizer(allowAllChangeFeedTables);
          const { sveltekit, rest } = await streams({}, SEEDED.length);
          expect(framedTables(sveltekit)).toEqual(SEEDED);
          expect(framedTables(rest)).toEqual(SEEDED);
        });
      });

      describe('the tenant the runtime exposure gate receives', () => {
        /** Tenants the gate was asked about for the orders model. */
        let seen: Array<string | undefined>;

        beforeEach(() => {
          seen = [];
          // A gate that fails closed without a tenant and admits only tenant A.
          setRuntimeExposureGate({
            isEnabled: (model, context) => {
              if (isModel(model.qualifiedName ?? '', 'Issue5446Order')) {
                seen.push(context.tenantId ?? undefined);
              }
              return context.tenantId === TENANT_A;
            },
          });
        });

        function restApi(
          config: Partial<ConstructorParameters<typeof APIGenerator>[0]>,
          context: Partial<ConstructorParameters<typeof APIGenerator>[1]> = {},
        ) {
          return new APIGenerator(
            { basePath: '/api', authMiddleware: restAuth, ...config },
            { db, ...context },
          ).generateHandler();
        }

        it('REST _changes uses the tenant resolveTenant gives the list routes', async () => {
          const handler = restApi({
            resolveTenant: () => ({ tenantId: TENANT_A }),
          });
          const body = await readChangesBody(
            await handler(new Request(`http://localhost/api/_changes?since=0`)),
          );
          expect(tablesOf(body.changes)).toContain(T.orders);
          expect(seen).toEqual([TENANT_A]);
        });

        it('REST _changes uses a fixed APIContext.tenantId', async () => {
          const handler = restApi({}, { tenantId: TENANT_A });
          const body = await readChangesBody(
            await handler(new Request(`http://localhost/api/_changes?since=0`)),
          );
          expect(tablesOf(body.changes)).toContain(T.orders);
          expect(seen).toEqual([TENANT_A]);
        });

        it('REST _events uses the tenant resolveTenant gives the list routes', async () => {
          const handler = restApi({
            resolveTenant: () => ({ tenantId: TENANT_A }),
          });
          const response = await handler(
            new Request(`http://localhost/api/_events?since=0`),
          );
          const text = await readStreamText(response.body, 5_000, (t) =>
            framedTables(t).includes(T.orders),
          );
          expect(framedTables(text)).toContain(T.orders);
          expect(seen).toEqual([TENANT_A]);
        });

        it('SvelteKit _changes reads the tenant from locals first', async () => {
          const page = await getAuthorizedTenantScopedChangesSince(db, {
            since: 0,
            tables: [T.orders],
            locals: { user: { id: 'member-1', tenantId: TENANT_A } },
            request,
          });
          expect(tablesOf(page.changes)).toEqual([T.orders]);
          expect(seen).toEqual([TENANT_A]);
        });

        it('captured _events scope is used when locals name no tenant', async () => {
          const stream = buildChangeEventStream(db, {
            cursor: 0,
            tenantScope: { enforced: true, tenantId: TENANT_A },
            heartbeatMs: 60_000,
            locals,
            request,
          });
          const text = await readStreamText(stream, 5_000, (t) =>
            framedTables(t).includes(T.orders),
          );
          expect(framedTables(text)).toContain(T.orders);
          expect(seen).toEqual([TENANT_A]);
        });

        it('with no tenant resolved, a gate that needs one refuses', async () => {
          const handler = restApi({});
          const body = await readChangesBody(
            await handler(new Request(`http://localhost/api/_changes?since=0`)),
          );
          expect(body.changes).toEqual([]);
          expect(body.cursor).toBe(SEEDED.length);
          expect(seen).toEqual([undefined]);
        });

        it('a model another tenant owns is refused for the resolved tenant', async () => {
          setRuntimeExposureGate(undefined);
          const orderKey =
            ObjectRegistry.getClass('Issue5446Order')?.qualifiedName ??
            'Issue5446Order';
          setRuntimeModelOwner([orderKey], TENANT_B);
          try {
            const handler = restApi({
              resolveTenant: () => ({ tenantId: TENANT_A }),
            });
            const body = await readChangesBody(
              await handler(
                new Request(`http://localhost/api/_changes?since=0`),
              ),
            );
            expect(tablesOf(body.changes)).not.toContain(T.orders);
            expect(tablesOf(body.changes)).toContain(T.listedLinks);
          } finally {
            setRuntimeModelOwner([orderKey], undefined);
          }
        });
      });

      describe('a REST server serves only its own models', () => {
        it('createRestServer(objects) serves only the tables of its models', async () => {
          const { server } = createRestServer(
            [Issue5446Order],
            { db },
            { authMiddleware: restAuth, port: 0 },
          );
          try {
            await new Promise<void>((resolve) => {
              if (server.listening) resolve();
              else server.once('listening', () => resolve());
            });
            const { port } = server.address() as { port: number };
            const response = await fetch(
              `http://127.0.0.1:${port}/api/v1/_changes?since=0`,
            );
            const body = await readChangesBody(response);
            expect(tablesOf(body.changes)).toEqual([T.orders]);
            expect(body.cursor).toBe(SEEDED.length);
          } finally {
            await new Promise((resolve) => server.close(resolve));
          }
        });

        it('asks the middleware once per model per request, under the route object name', async () => {
          const asked: string[] = [];
          const counting: ChangesAuthMiddleware =
            (objectName, action) => async (req) => {
              if (action === 'get') asked.push(objectName);
              return req;
            };
          const api = new APIGenerator(
            { basePath: '/api', authMiddleware: counting },
            { db },
          );
          const orders = await Issue5446OrderCollection.create({ db });
          api.registerCollection('issue5446-orders', orders);
          await api.generateHandler()(
            new Request('http://localhost/api/_changes?since=0'),
          );
          const orderKey =
            ObjectRegistry.getClass('Issue5446Order')?.qualifiedName ??
            'Issue5446Order';
          expect(asked.filter((name) => name === orderKey)).toHaveLength(1);
          expect(new Set(asked).size).toBe(asked.length);

          // A second resolve for the same request reuses the decisions.
          const req = new Request('http://localhost/api/_changes');
          const before = asked.length;
          const ctx = {
            locals: undefined,
            request: req,
            authMiddleware: counting,
          };
          await resolveAuthorizedChangeFeedTables(ctx, undefined);
          const once = asked.length - before;
          await resolveAuthorizedChangeFeedTables(ctx, undefined);
          expect(asked.length - before).toBe(once);
        });
      });
    },
  );
}
