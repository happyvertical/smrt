/**
 * A route to an STI model serves rows of a family member only when the
 * member's tenancy equals the route model's, on runtime REST and emitted
 * routes, with the real tenant interceptor on a SQLite file.
 *
 * Rows 17-26 of the #5375 test-design contract.
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
import { APIGenerator } from '@happyvertical/smrt-core/generators/rest';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  withSuperAdminBypass,
  withSystemContext,
  withTenant,
} from '../context.js';
import { TenantScoped, tenantId } from '../decorators.js';
import { disableTenancy, enableTenancy } from '../interceptor.js';
import {
  registerTenantScopedClass,
  unregisterTenantScopedClass,
} from '../registry.js';
import {
  collectionEntryFor,
  type EmittedApp,
  emitApp,
  keyOf,
  restCall,
  segmentOf,
  TENANT_A,
  TENANT_B,
  titlesOf,
} from './helpers/effective-tenancy-harness.js';

// ── An unscoped base with members of several policies ────────────────────
@smrt({
  tableStrategy: 'sti',
  api: {
    include: ['list', 'get', 'create', 'update', 'delete', 'countEvery'],
    routes: { countEvery: { method: 'GET', path: 'count-every' } },
  },
})
class EffNote extends SmrtObject {
  @field({ type: 'text' }) title = '';
}
class EffNoteCollection extends SmrtCollection<EffNote> {
  static readonly _itemClass = EffNote;
  async countEvery() {
    return (await this.list({})).length;
  }
}

/** Declared optional tenancy, with a route of its own. */
@smrt({
  collection: 'effownednotes',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
} as never)
@TenantScoped({ mode: 'optional' })
class EffOwnedNote extends EffNote {
  @tenantId({ nullable: true }) tenantId: string | null = null;
}

/** Tenancy registered at run time. */
@smrt({ api: { include: ['list', 'get', 'create', 'update', 'delete'] } })
class EffLateNote extends EffNote {
  @field({ type: 'text', nullable: true }) tenantId: string | null = null;
}

/** No tenancy of its own: equal to the base. */
@smrt({ api: { include: ['list', 'get', 'create', 'update', 'delete'] } })
class EffMidNote extends EffNote {}

/** Scoped below an unscoped parent. */
@smrt({ api: { include: ['list', 'get', 'create', 'update', 'delete'] } })
@TenantScoped({ mode: 'optional' })
class EffDeepNote extends EffMidNote {
  @tenantId({ nullable: true }) tenantId: string | null = null;
}

// ── A scoped base: inherited, re-declared and differently owned members ──
@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
})
@TenantScoped({ mode: 'optional' })
class EffMemo extends SmrtObject {
  @field({ type: 'text' }) title = '';
  @tenantId({ nullable: true }) tenantId: string | null = null;
  @field({ type: 'text', nullable: true }) organizationId: string | null = null;
}
class EffMemoCollection extends SmrtCollection<EffMemo> {
  static readonly _itemClass = EffMemo;
}
/** Inherits the base's tenancy. */
@smrt({ api: { include: ['list', 'get', 'create', 'update', 'delete'] } })
class EffInheritedMemo extends EffMemo {}
/** Required mode on the same field. */
@smrt({ api: { include: ['list', 'get', 'create', 'update', 'delete'] } })
@TenantScoped({ mode: 'required' })
class EffStrictMemo extends EffMemo {}
/** Owned through another field. */
@smrt({ api: { include: ['list', 'get', 'create', 'update', 'delete'] } })
@TenantScoped({ mode: 'optional', field: 'organizationId' })
class EffOrgMemo extends EffMemo {}

// ── A required base with an optional member ──────────────────────────────
@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
})
@TenantScoped({ mode: 'required' })
class EffDossier extends SmrtObject {
  @field({ type: 'text' }) title = '';
  @tenantId({ nullable: true }) tenantId: string | null = null;
}
class EffDossierCollection extends SmrtCollection<EffDossier> {
  static readonly _itemClass = EffDossier;
}
@smrt({ api: { include: ['list', 'get', 'create', 'update', 'delete'] } })
@TenantScoped({ mode: 'optional' })
class EffLooseDossier extends EffDossier {}

// ── A base that opts into the bypass, with a member that does not ────────
@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
})
@TenantScoped({ mode: 'optional', allowSuperAdminBypass: true })
class EffLog extends SmrtObject {
  @field({ type: 'text' }) title = '';
  @tenantId({ nullable: true }) tenantId: string | null = null;
}
class EffLogCollection extends SmrtCollection<EffLog> {
  static readonly _itemClass = EffLog;
}
@smrt({ api: { include: ['list', 'get', 'create', 'update', 'delete'] } })
@TenantScoped({ mode: 'optional' })
class EffPlainLog extends EffLog {}

const SESSIONS: Record<string, { tenantId?: string }> = {
  'reader-none': {},
  'user-of-a': { tenantId: TENANT_A },
  'user-of-b': { tenantId: TENANT_B },
};
const tokenOf = (req: Request) =>
  (req.headers.get('authorization') ?? '').replace('Bearer ', '');
const as = (token?: string) =>
  token ? { headers: { authorization: `Bearer ${token}` } } : {};

let next = 0;
const idOf = () =>
  `dddddddd-0000-4000-8000-${String(++next).padStart(12, '0')}`;

describe('an STI route serves a member only under an equal tenancy', () => {
  let dir: string;
  let db: DatabaseInterface;
  let handler: (req: Request) => Promise<Response>;
  let app: EmittedApp;
  const stores: Record<string, SmrtCollection<SmrtObject>> = {};
  const ids: Record<string, string> = {};
  const collections = new Map<string, unknown>();

  /** Insert one row of `model` into its family table. */
  const put = async (
    store: string,
    model: Function,
    title: string,
    owner: Record<string, string | null> = {},
  ) => {
    const id = idOf();
    ids[title] = id;
    await stores[store].create({
      id,
      title,
      _meta_type: keyOf(model),
      ...owner,
    } as never);
  };

  // Runtime warnings about mixed families, by message.
  const familyWarnings: string[] = [];

  beforeAll(async () => {
    vi.spyOn(process, 'emitWarning').mockImplementation(((
      warning: string | Error,
      options?: { code?: string },
    ) => {
      if (options?.code === 'SMRT_MIXED_TENANCY_FAMILY') {
        familyWarnings.push(String(warning));
      }
    }) as never);
    const bases = [
      [EffNote, EffNoteCollection],
      [EffMemo, EffMemoCollection],
      [EffDossier, EffDossierCollection],
      [EffLog, EffLogCollection],
    ] as const;
    for (const [model, collection] of bases) {
      ObjectRegistry.registerCollection(model.name, collection as never);
    }
    dir = mkdtempSync(join(tmpdir(), 'smrt-effective-sti-'));
    const members = [
      EffNote,
      EffOwnedNote,
      EffLateNote,
      EffMidNote,
      EffDeepNote,
      EffMemo,
      EffInheritedMemo,
      EffStrictMemo,
      EffOrgMemo,
      EffDossier,
      EffLooseDossier,
      EffLog,
      EffPlainLog,
    ];
    db = await getTestDatabase({
      type: 'sqlite',
      url: join(dir, 'app.db'),
      classes: members.map((model) => keyOf(model)),
    });
    for (const [model, collection] of bases) {
      const store = (await (
        collection as unknown as {
          create(options: unknown): Promise<SmrtCollection<SmrtObject>>;
        }
      ).create({ db })) as SmrtCollection<SmrtObject>;
      stores[model.name] = store;
    }
    for (const model of members) {
      const info = ObjectRegistry.getClass(keyOf(model));
      const base = ObjectRegistry.getSTIBase(keyOf(model));
      const store = bases.find(([b]) => keyOf(b) === base)?.[0].name;
      if (!info || !store) continue;
      // Each model's own collection, for its own route.
      const own =
        model === bases.find(([b]) => b === model)?.[0]
          ? stores[store]
          : await ObjectRegistry.getCollection(keyOf(model), { db } as never);
      collections.set(keyOf(model), own);
      collections.set(model.name, own);
    }
    collections.set(`${keyOf(EffNote)}Collection`, stores.EffNote);
    collections.set('EffNoteCollection', stores.EffNote);
    enableTenancy();
    registerTenantScopedClass(keyOf(EffLateNote), { mode: 'optional' });
    handler = new APIGenerator(
      {
        basePath: '/api',
        authMiddleware: () => async (req: Request) => req,
        resolveTenant: (req: Request) => {
          const session = SESSIONS[tokenOf(req)];
          return session
            ? { ...session, authenticated: true }
            : { authenticated: false };
        },
      },
      { db },
    ).generateHandler();
    app = await emitApp(
      'effective-tenancy-sti-family',
      [EffNote, EffOwnedNote, EffMemo, EffInheritedMemo],
      collections,
      Object.fromEntries([collectionEntryFor(EffNote, { countEvery: [] })]),
    );
  }, 120_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    unregisterTenantScopedClass(keyOf(EffLateNote));
    disableTenancy();
    app?.dispose();
    await db?.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await withSystemContext(async () => {
      for (const store of Object.values(stores)) {
        await db.query(`DELETE FROM ${store.tableName}`);
      }
      await put('EffNote', EffNote, 'base note');
      await put('EffNote', EffOwnedNote, 'owned by a', { tenantId: TENANT_A });
      await put('EffNote', EffOwnedNote, 'owned by b', { tenantId: TENANT_B });
      await put('EffNote', EffOwnedNote, 'owned by nobody');
      await put('EffNote', EffLateNote, 'late by a', { tenantId: TENANT_A });
      await put('EffNote', EffMidNote, 'mid note');
      await put('EffNote', EffDeepNote, 'deep by a', { tenantId: TENANT_A });

      await put('EffMemo', EffMemo, 'memo by a', { tenantId: TENANT_A });
      await put('EffMemo', EffMemo, 'memo by nobody');
      await put('EffMemo', EffInheritedMemo, 'inherited by a', {
        tenantId: TENANT_A,
      });
      await put('EffMemo', EffInheritedMemo, 'inherited by b', {
        tenantId: TENANT_B,
      });
      await put('EffMemo', EffStrictMemo, 'strict by nobody');
      await put('EffMemo', EffStrictMemo, 'strict by a', {
        tenantId: TENANT_A,
      });
      await put('EffMemo', EffOrgMemo, 'org by a', {
        tenantId: TENANT_A,
        organizationId: TENANT_A,
      });

      await put('EffDossier', EffDossier, 'dossier by a', {
        tenantId: TENANT_A,
      });
      await put('EffDossier', EffLooseDossier, 'loose by a', {
        tenantId: TENANT_A,
      });

      await put('EffLog', EffLog, 'log by a', { tenantId: TENANT_A });
      await put('EffLog', EffLog, 'log by b', { tenantId: TENANT_B });
      await put('EffLog', EffPlainLog, 'plain log by b', {
        tenantId: TENANT_B,
      });
    });
  });

  const notes = () => segmentOf(EffNote);
  const memos = () => segmentOf(EffMemo);

  it('a base route serves no subtype whose tenancy differs', async () => {
    for (const who of ['user-of-a', undefined]) {
      const listed = await restCall(handler, 'GET', notes(), as(who));
      expect(titlesOf(listed.body)).toEqual(['base note', 'mid note']);
      const counted = await restCall(
        handler,
        'GET',
        `${notes()}/count`,
        as(who),
      );
      expect((counted.body as { count: number }).count).toBe(2);
      for (const title of ['owned by a', 'owned by b', 'owned by nobody']) {
        const point = await restCall(
          handler,
          'GET',
          `${notes()}/${ids[title]}`,
          as(who),
        );
        expect(point.status).toBe(404);
      }
    }
    const emittedLocals = { user: { id: 'reader' }, tenantId: TENANT_A };
    const emitted = await app.call('GET', notes(), { locals: emittedLocals });
    expect(titlesOf(emitted.body)).toEqual(['base note', 'mid note']);
    expect((emitted.body as { count: number }).count).toBe(2);
    const emittedPoint = await app.call('GET', `${notes()}/[id]`, {
      params: { id: ids['owned by a'] },
      locals: emittedLocals,
    });
    expect(emittedPoint.status).toBe(404);
    // The subtype's own route serves tenant A's row.
    const own = await app.call('GET', segmentOf(EffOwnedNote), {
      locals: emittedLocals,
    });
    expect(titlesOf(own.body)).toEqual(['owned by a']);
    const ownRest = await restCall(
      handler,
      'GET',
      segmentOf(EffOwnedNote),
      as('user-of-a'),
    );
    expect(titlesOf(ownRest.body)).toEqual(['owned by a']);
  });

  it("a base route serves no subtype whose tenancy differs, when the subtype's tenancy is registered at run time", async () => {
    const listed = await restCall(handler, 'GET', notes(), as('user-of-a'));
    expect(titlesOf(listed.body)).not.toContain('late by a');
    const point = await restCall(
      handler,
      'GET',
      `${notes()}/${ids['late by a']}`,
      as('user-of-a'),
    );
    expect(point.status).toBe(404);
  });

  it('a mode difference in either direction excludes the subtype', async () => {
    // Optional base, required member: a caller with no tenant.
    const tenantless = await restCall(
      handler,
      'GET',
      memos(),
      as('reader-none'),
    );
    expect(titlesOf(tenantless.body)).toEqual(['memo by nobody']);
    // Required base, optional member: tenant A.
    const dossiers = await restCall(
      handler,
      'GET',
      segmentOf(EffDossier),
      as('user-of-a'),
    );
    expect(titlesOf(dossiers.body)).toEqual(['dossier by a']);
  });

  it('a bypass excludes a subtype that does not allow it', async () => {
    const answer = await withTenant({ tenantId: TENANT_A }, () =>
      withSuperAdminBypass(() =>
        restCall(handler, 'GET', segmentOf(EffLog), as('user-of-a')),
      ),
    );
    expect(titlesOf(answer.body)).toEqual(['log by a', 'log by b']);
  });

  it("a subtype with its base's tenancy is served through the base", async () => {
    const listed = await restCall(handler, 'GET', memos(), as('user-of-a'));
    expect(titlesOf(listed.body)).toEqual(['inherited by a', 'memo by a']);
    const emitted = await app.call('GET', memos(), {
      locals: { user: { id: 'reader' }, tenantId: TENANT_A },
    });
    expect(titlesOf(emitted.body)).toEqual(['inherited by a', 'memo by a']);
  });

  it('a nested or differently owned subtype is excluded', async () => {
    const listed = await restCall(handler, 'GET', notes(), as('user-of-a'));
    expect(titlesOf(listed.body)).not.toContain('deep by a');
    const memoList = await restCall(handler, 'GET', memos(), as('user-of-a'));
    expect(titlesOf(memoList.body)).not.toContain('org by a');
  });

  it('a type filter naming an excluded subtype selects nothing', async () => {
    const answer = await restCall(
      handler,
      'GET',
      `${notes()}?_meta_type[in]=${encodeURIComponent(keyOf(EffOwnedNote))}`,
      as('user-of-a'),
    );
    expect(titlesOf(answer.body)).toEqual([]);
  });

  // The generated schema declares the type column NOT NULL, so a root row
  // without a type cannot be stored here; a root row is the base's own key.
  it('a row of an unregistered type is never served; a root row is the base', async () => {
    const unknown = idOf();
    const legacy = ids['base note'];
    await db.query(
      `INSERT INTO ${stores.EffNote.tableName} (id, slug, context, title, _meta_type) VALUES ('${unknown}', 'gone', '', 'gone note', '@eff-fixture/gone:GoneNote')`,
    );
    for (const who of ['user-of-a', undefined]) {
      const listed = await restCall(handler, 'GET', notes(), as(who));
      expect(titlesOf(listed.body)).toEqual(['base note', 'mid note']);
      const counted = await restCall(
        handler,
        'GET',
        `${notes()}/count`,
        as(who),
      );
      expect((counted.body as { count: number }).count).toBe(2);
      expect(
        (await restCall(handler, 'GET', `${notes()}/${unknown}`, as(who)))
          .status,
      ).toBe(404);
      expect(
        (await restCall(handler, 'GET', `${notes()}/${legacy}`, as(who)))
          .status,
      ).toBe(200);
    }
    const synced = await restCall(handler, 'POST', 'sync/apply', {
      ...as('user-of-a'),
      body: {
        items: [
          {
            itemId: 'gone-1',
            object: notes(),
            op: 'update',
            id: unknown,
            payload: { title: 'changed through sync' },
          },
        ],
      },
    });
    expect(
      (synced.body as { results: Array<{ status: string }> }).results[0]
        ?.status,
    ).not.toBe('applied');
    const stored = await db.query(
      `SELECT title FROM ${stores.EffNote.tableName} WHERE id = '${unknown}'`,
    );
    expect(stored.rows[0]?.title).toBe('gone note');
  });

  it('custom actions on the base exclude the subtype; an item action by its id answers not found', async () => {
    const restCount = await restCall(
      handler,
      'GET',
      `${notes()}/count-every`,
      as('user-of-a'),
    );
    expect((restCount.body as { result: unknown }).result).toBe(2);
    const emittedCount = await app.call('GET', `${notes()}/count-every`, {
      locals: { user: { id: 'reader' }, tenantId: TENANT_A },
    });
    expect((emittedCount.body as { result: unknown }).result).toBe(2);
    // An item operation through the base by a member row's id.
    const update = await restCall(
      handler,
      'PUT',
      `${notes()}/${ids['owned by a']}`,
      { ...as('user-of-a'), body: { title: 'changed through base' } },
    );
    expect(update.status).toBe(404);
  });

  it("a base create of an excluded subtype is refused; an admitted subtype's own permission applies", async () => {
    const refused = await restCall(handler, 'POST', notes(), {
      ...as('user-of-a'),
      body: { title: 'created through base', _meta_type: keyOf(EffOwnedNote) },
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    const created = await db.query(
      `SELECT title FROM ${stores.EffNote.tableName} WHERE title = 'created through base'`,
    );
    expect(created.rows).toHaveLength(0);

    const admitted = await restCall(handler, 'POST', memos(), {
      ...as('user-of-a'),
      body: {
        title: 'inherited created',
        _meta_type: keyOf(EffInheritedMemo),
      },
    });
    expect(admitted.status).toBe(201);
    const stored = await db.query(
      `SELECT tenant_id FROM ${stores.EffMemo.tableName} WHERE title = 'inherited created'`,
    );
    expect(stored.rows[0]?.tenant_id).toBe(TENANT_A);
  });

  // Runs last: every earlier test served the families many times.
  it('a mixed family warns once', () => {
    for (const family of [EffNote, EffMemo, EffDossier, EffLog]) {
      const named = familyWarnings.filter((warning) =>
        warning.includes(`STI family ${keyOf(family)}:`),
      );
      expect(named).toHaveLength(1);
    }
    expect(
      familyWarnings.find((warning) =>
        warning.includes(`STI family ${keyOf(EffNote)}:`),
      ),
    ).toContain(keyOf(EffOwnedNote));
  });
});
