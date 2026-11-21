/**
 * Every operation of the runtime REST server on a tenant-scoped model runs
 * inside the tenant gate.
 *
 * A request reaches a tenant-scoped model with the tenant its host supplies
 * (`APIConfig.resolveTenant`). With a tenant, every read and write runs
 * inside that tenant. Without one, reads of an optional-mode model serve
 * global rows only, and writes — updates, deletes, creates, custom actions
 * and sync items — are refused: 403 for a signed-in caller, 401 for an
 * anonymous one. Only an explicitly cross-tenant principal writes without a
 * tenant.
 *
 * These tests live here because core cannot depend on tenancy. Real SQLite
 * file, the real tenant interceptor and entry-point gate; nothing is mocked.
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
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withSystemContext, withTenant } from '../context.js';
import { TenantScoped, tenantId } from '../decorators.js';
import { disableTenancy, enableTenancy } from '../interceptor.js';

const TENANT_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaa1';
const TENANT_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbb2';
const ROW_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const ROW_GLOBAL = '99999999-0000-4000-8000-000000000009';

@smrt({
  api: {
    include: ['list', 'get', 'create', 'update', 'delete', 'archiveAll'],
    routes: { archiveAll: { method: 'POST', scope: 'collection' } },
  },
})
@TenantScoped({ mode: 'optional' })
class GateNote extends SmrtObject {
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
class GateNoteCollection extends SmrtCollection<GateNote> {
  static readonly _itemClass = GateNote;

  /** A collection-scoped custom action that writes every row it can see. */
  async archiveAll(): Promise<{ archived: number }> {
    const rows = await this.list({});
    for (const row of rows) {
      row.title = `[archived] ${row.title}`;
      await row.save();
    }
    return { archived: rows.length };
  }
}

// The same model readable and writable without a principal.
@smrt({ api: { public: true } })
@TenantScoped({ mode: 'optional' })
class GatePublicNote extends SmrtObject {
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
class GatePublicNoteCollection extends SmrtCollection<GatePublicNote> {
  static readonly _itemClass = GatePublicNote;
}

@smrt()
@TenantScoped() // required mode
class GateStrictNote extends SmrtObject {
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
class GateStrictNoteCollection extends SmrtCollection<GateStrictNote> {
  static readonly _itemClass = GateStrictNote;
}

/** A signed-in caller: the host reads its tenant from the verified session. */
const SESSIONS: Record<string, { tenantId?: string; operator?: boolean }> = {
  'user-of-a': { tenantId: TENANT_A },
  'user-of-b': { tenantId: TENANT_B },
  'user-without-tenant': {},
  operator: { operator: true },
};
const sessionOf = (req: Request) =>
  SESSIONS[(req.headers.get('authorization') ?? '').replace('Bearer ', '')];

describe('runtime REST tenant gate', () => {
  let dir: string;
  let db: DatabaseInterface;
  let notes: GateNoteCollection;
  let publicNotes: GatePublicNoteCollection;
  let strict: GateStrictNoteCollection;
  let handler: (req: Request) => Promise<Response>;
  let publicHandler: (req: Request) => Promise<Response>;

  const serve = (config: APIConfig) => {
    const api = new APIGenerator({ basePath: '/api', ...config });
    api.registerCollection('notes', notes as never);
    api.registerCollection('publicnotes', publicNotes as never);
    api.registerCollection('strictnotes', strict as never);
    return api.generateHandler();
  };

  beforeAll(async () => {
    for (const [name, collection] of [
      ['GateNote', GateNoteCollection],
      ['GatePublicNote', GatePublicNoteCollection],
      ['GateStrictNote', GateStrictNoteCollection],
    ] as const) {
      ObjectRegistry.registerCollection(name, collection as never);
    }
    dir = mkdtempSync(join(tmpdir(), 'smrt-tenant-gate-'));
    db = await getTestDatabase({
      type: 'sqlite',
      url: join(dir, 'app.db'),
      classes: ['GateNote', 'GatePublicNote', 'GateStrictNote'],
    });
    notes = await GateNoteCollection.create({ db });
    publicNotes = await GatePublicNoteCollection.create({ db });
    strict = await GateStrictNoteCollection.create({ db });
    enableTenancy();

    // The documented host wiring: authenticate, then say which tenant the
    // authenticated request acts for.
    handler = serve({
      authMiddleware: () => async (req) =>
        sessionOf(req) ? req : new Response('unauthorized', { status: 401 }),
      resolveTenant: (req) => {
        const session = sessionOf(req);
        return {
          tenantId: session?.tenantId,
          allowCrossTenant: session?.operator === true,
        };
      },
    });
    // No auth middleware: only `api.public` models are served, anonymously.
    publicHandler = serve({});
  });

  beforeEach(async () => {
    await withSystemContext(async () => {
      for (const collection of [notes, publicNotes, strict]) {
        await db.query(`DELETE FROM ${collection.tableName}`);
      }
      for (const collection of [notes, publicNotes]) {
        await collection.create({
          id: ROW_B,
          title: 'owned by b',
          tenantId: TENANT_B,
        } as never);
        await collection.create({ id: ROW_GLOBAL, title: 'global' } as never);
      }
      await strict.create({
        id: ROW_B,
        title: 'owned by b',
        tenantId: TENANT_B,
      } as never);
    });
  });

  afterAll(async () => {
    disableTenancy();
    await db?.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  const titles = async (collection: { tableName: string }) =>
    (
      await db.query(
        `SELECT title, tenant_id FROM ${collection.tableName} ORDER BY title`,
      )
    ).rows.map((row) => `${row.title}@${row.tenant_id ?? 'global'}`);
  const UNTOUCHED = ['global@global', `owned by b@${TENANT_B}`];

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
  const syncItem = (op: string, id: string, payload?: unknown) => ({
    items: [{ itemId: 'item-1', object: 'notes', op, id, payload }],
  });
  const expectRefusal = async (response: Response, status: number) => {
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({
      error: {
        code: 'TENANT_CONTEXT_REQUIRED',
        message: 'Tenant context required.',
        ok: false,
        status,
      },
    });
  };

  describe('a signed-in caller with no tenant', () => {
    const as = 'user-without-tenant';

    it.each([
      ['update', 'PUT', `notes/${ROW_B}`, { title: 'changed' }],
      ['delete', 'DELETE', `notes/${ROW_B}`, undefined],
      ['update of a global row', 'PUT', `notes/${ROW_GLOBAL}`, { title: 'x' }],
      ['delete of a global row', 'DELETE', `notes/${ROW_GLOBAL}`, undefined],
      ['create', 'POST', 'notes', { title: 'new global row' }],
      ['a custom action', 'POST', 'notes/archiveAll', {}],
    ])('is refused a %s', async (_label, method, path, body) => {
      await expectRefusal(await call(handler, method, path, { as, body }), 403);
      expect(await titles(notes)).toEqual(UNTOUCHED);
    });

    it.each([
      ['update', syncItem('update', ROW_B, { title: 'changed' })],
      ['delete', syncItem('delete', ROW_B)],
      [
        'create',
        syncItem('create', '11111111-0000-4000-8000-000000000001', {
          title: 'new',
        }),
      ],
    ])('has a sync %s rejected as forbidden', async (_label, body) => {
      const response = await call(handler, 'POST', 'sync/apply', { as, body });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        results: [{ status: 'rejected', reason: 'forbidden' }],
      });
      expect(await titles(notes)).toEqual(UNTOUCHED);
    });

    it('reads global rows only', async () => {
      const list = await call(handler, 'GET', 'notes', { as });
      expect(list.status).toBe(200);
      expect(
        ((await list.json()) as Array<{ title: string }>).map((r) => r.title),
      ).toEqual(['global']);
      expect(
        (await call(handler, 'GET', `notes/${ROW_B}`, { as })).status,
      ).toBe(404);
      expect(
        (await call(handler, 'GET', `notes/${ROW_GLOBAL}`, { as })).status,
      ).toBe(200);
    });

    it('is refused every operation of a required-mode model with a 403', async () => {
      for (const [method, path, body] of [
        ['GET', 'strictnotes', undefined],
        ['GET', `strictnotes/${ROW_B}`, undefined],
        ['PUT', `strictnotes/${ROW_B}`, { title: 'changed' }],
        ['DELETE', `strictnotes/${ROW_B}`, undefined],
        ['POST', 'strictnotes', { title: 'new' }],
      ] as const) {
        await expectRefusal(
          await call(handler, method, path, { as, body }),
          403,
        );
      }
      expect(await titles(strict)).toEqual([`owned by b@${TENANT_B}`]);
    });
  });

  describe('a signed-in caller of another tenant', () => {
    const as = 'user-of-a';

    it('cannot reach a row of tenant b by id', async () => {
      for (const [method, body] of [
        ['GET', undefined],
        ['PUT', { title: 'changed' }],
        ['DELETE', undefined],
      ] as const) {
        const response = await call(handler, method, `notes/${ROW_B}`, {
          as,
          body,
        });
        expect(response.status).toBe(404);
      }
      const sync = await call(handler, 'POST', 'sync/apply', {
        as,
        body: syncItem('update', ROW_B, { title: 'changed' }),
      });
      expect(await sync.json()).toMatchObject({
        results: [{ status: 'rejected', reason: 'not_found' }],
      });
      expect(await titles(notes)).toEqual(UNTOUCHED);
    });

    it('creates, updates and deletes rows of its own tenant', async () => {
      const created = await call(handler, 'POST', 'notes', {
        as,
        body: { title: 'made by a' },
      });
      expect(created.status).toBe(201);
      const { id } = (await created.json()) as { id: string };
      expect(await titles(notes)).toContain(`made by a@${TENANT_A}`);

      const updated = await call(handler, 'PUT', `notes/${id}`, {
        as,
        body: { title: 'edited by a' },
      });
      expect(updated.status).toBe(200);
      expect(await titles(notes)).toContain(`edited by a@${TENANT_A}`);

      const synced = await call(handler, 'POST', 'sync/apply', {
        as,
        body: syncItem('update', id, { title: 'synced by a' }),
      });
      expect(await synced.json()).toMatchObject({
        results: [{ status: 'applied' }],
      });
      expect(await titles(notes)).toContain(`synced by a@${TENANT_A}`);

      expect(
        (await call(handler, 'DELETE', `notes/${id}`, { as })).status,
      ).toBe(204);
      expect(await titles(notes)).toEqual(UNTOUCHED);
    });

    it('runs a custom action inside its own tenant', async () => {
      await call(handler, 'POST', 'notes', { as, body: { title: 'mine' } });
      const response = await call(handler, 'POST', 'notes/archiveAll', {
        as,
        body: {},
      });
      expect(response.status).toBe(200);
      const after = await titles(notes);
      expect(after).toContain(`[archived] mine@${TENANT_A}`);
      expect(after).toContain(`owned by b@${TENANT_B}`);
    });

    it('works a required-mode model inside its own tenant', async () => {
      const created = await call(handler, 'POST', 'strictnotes', {
        as,
        body: { title: 'strict a' },
      });
      expect(created.status).toBe(201);
      const list = await call(handler, 'GET', 'strictnotes', { as });
      expect(
        ((await list.json()) as Array<{ title: string }>).map((r) => r.title),
      ).toEqual(['strict a']);
      expect(
        (await call(handler, 'GET', `strictnotes/${ROW_B}`, { as })).status,
      ).toBe(404);
    });
  });

  describe('an explicitly cross-tenant principal', () => {
    it('writes rows of any tenant and global rows', async () => {
      const as = 'operator';
      const updated = await call(handler, 'PUT', `notes/${ROW_B}`, {
        as,
        body: { title: 'fixed by operator' },
      });
      expect(updated.status).toBe(200);
      const created = await call(handler, 'POST', 'notes', {
        as,
        body: { title: 'second global' },
      });
      expect(created.status).toBe(201);
      expect(await titles(notes)).toEqual([
        `fixed by operator@${TENANT_B}`,
        'global@global',
        'second global@global',
      ]);
    });
  });

  describe('an anonymous caller of a public model', () => {
    it('is refused every write with a 401', async () => {
      for (const [method, path, body] of [
        ['PUT', `publicnotes/${ROW_B}`, { title: 'changed' }],
        ['DELETE', `publicnotes/${ROW_B}`, undefined],
        ['POST', 'publicnotes', { title: 'anonymous global row' }],
      ] as const) {
        await expectRefusal(
          await call(publicHandler, method, path, { body }),
          401,
        );
      }
      const sync = await call(publicHandler, 'POST', 'sync/apply', {
        body: {
          items: [
            {
              itemId: 'i',
              object: 'publicnotes',
              op: 'update',
              id: ROW_B,
              payload: { title: 'changed' },
            },
          ],
        },
      });
      expect(await sync.json()).toMatchObject({
        results: [{ status: 'rejected', reason: 'auth_required' }],
      });
      expect(await titles(publicNotes)).toEqual(UNTOUCHED);
    });

    it('still reads global rows', async () => {
      const list = await call(publicHandler, 'GET', 'publicnotes');
      expect(list.status).toBe(200);
      expect(
        ((await list.json()) as Array<{ title: string }>).map((r) => r.title),
      ).toEqual(['global']);
    });
  });

  describe('a host that establishes tenant context itself', () => {
    it('keeps working: the gate runs inside the active context', async () => {
      const response = await withTenant({ tenantId: TENANT_B }, () =>
        call(publicHandler, 'PUT', `publicnotes/${ROW_B}`, {
          body: { title: 'edited in context' },
        }),
      );
      expect(response.status).toBe(200);
      expect(await titles(publicNotes)).toContain(
        `edited in context@${TENANT_B}`,
      );
    });
  });

  describe('a server with a fixed tenant', () => {
    it('runs every operation inside APIContext.tenantId', async () => {
      const api = new APIGenerator(
        { basePath: '/api', authMiddleware: () => async (req) => req },
        { tenantId: TENANT_B },
      );
      api.registerCollection('notes', notes as never);
      const fixed = api.generateHandler();
      const updated = await call(fixed, 'PUT', `notes/${ROW_B}`, {
        body: { title: 'edited by fixed tenant' },
      });
      expect(updated.status).toBe(200);
      const list = await call(fixed, 'GET', 'notes');
      expect(
        ((await list.json()) as Array<{ title: string }>)
          .map((r) => r.title)
          .sort(),
      ).toContain('edited by fixed tenant');
    });
  });
});
