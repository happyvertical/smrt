/**
 * Both sync apply paths (runtime REST and the emitted route) run every item
 * under the tenancy its target has when the batch is served, with the real
 * tenant interceptor on a SQLite file.
 *
 * Rows 14, 27, 28 and 33 of the #5375 test-design contract, and rows R2.10
 * and R2.11 of the round-2 matrix.
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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withSystemContext, withTenant } from '../context.js';
import { TenantScoped, tenantId } from '../decorators.js';
import { disableTenancy, enableTenancy } from '../interceptor.js';
import {
  registerTenantScopedClass,
  unregisterTenantScopedClass,
} from '../registry.js';
import {
  type EmittedApp,
  emitApp,
  keyOf,
  restCall,
  segmentOf,
  TENANT_A,
  TENANT_B,
} from './helpers/effective-tenancy-harness.js';

// Tenancy registered at run time.
@smrt({ api: { include: ['list', 'get', 'create', 'update', 'delete'] } })
class EffSyncMemo extends SmrtObject {
  @field({ type: 'text' }) title = '';
  @field({ type: 'text', nullable: true }) tenantId: string | null = null;
}
class EffSyncMemoCollection extends SmrtCollection<EffSyncMemo> {
  static readonly _itemClass = EffSyncMemo;
}

// An unscoped STI base and a scoped member sharing its sync segment.
@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
})
class EffSyncNote extends SmrtObject {
  @field({ type: 'text' }) title = '';
}
class EffSyncNoteCollection extends SmrtCollection<EffSyncNote> {
  static readonly _itemClass = EffSyncNote;
}
@smrt({ api: { include: ['list', 'get', 'create', 'update', 'delete'] } })
@TenantScoped({ mode: 'optional' })
class EffSyncOwnedNote extends EffSyncNote {
  @tenantId({ nullable: true }) tenantId: string | null = null;
}

// An unscoped STI base and a member of the same tenancy whose surface opens
// create only: it is a create target of the base, and its rows are never
// read through it.
@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
})
class EffSyncCrate extends SmrtObject {
  @field({ type: 'text' }) title = '';
}
class EffSyncCrateCollection extends SmrtCollection<EffSyncCrate> {
  static readonly _itemClass = EffSyncCrate;
}
@smrt({ api: { include: ['create'] } })
class EffSyncSealedCrate extends EffSyncCrate {}
// Listed and created, never read by id: a point read through the base
// (a sync lookup) does not serve it.
@smrt({ api: { include: ['list', 'create'] } })
class EffSyncListedCrate extends EffSyncCrate {}

const ROW = {
  listed: 'cccccccc-0000-4000-8000-0000000000c3',
  fresh: 'dddddddd-0000-4000-8000-0000000000d4',
  memoOfA: 'aaaaaaaa-0000-4000-8000-0000000000a1',
  memoOfB: 'bbbbbbbb-0000-4000-8000-0000000000b1',
  noteOfA: 'aaaaaaaa-0000-4000-8000-0000000000a2',
  noteOfB: 'bbbbbbbb-0000-4000-8000-0000000000b2',
};

const SESSIONS: Record<string, { tenantId?: string }> = {
  'user-of-a': { tenantId: TENANT_A },
  'user-of-b': { tenantId: TENANT_B },
  'reader-none': {},
};
const tokenOf = (req: Request) =>
  (req.headers.get('authorization') ?? '').replace('Bearer ', '');

type Result = {
  itemId: string;
  id: string;
  status: string;
  reason?: string;
  updatedAt?: string;
};

describe('sync apply runs every item under its target tenancy', () => {
  let dir: string;
  let db: DatabaseInterface;
  let handler: (req: Request) => Promise<Response>;
  let app: EmittedApp;
  let memos: SmrtCollection<SmrtObject>;
  let notes: SmrtCollection<SmrtObject>;
  let crates: SmrtCollection<SmrtObject>;
  const collections = new Map<string, unknown>();

  const restSync = async (token: string, items: unknown[]) => {
    const answer = await restCall(handler, 'POST', 'sync/apply', {
      headers: { authorization: `Bearer ${token}` },
      body: { items },
    });
    return {
      status: answer.status,
      results: ((answer.body as { results?: Result[] })?.results ??
        []) as Result[],
    };
  };
  const titleOf = async (table: string, id: string) =>
    (await db.query(`SELECT title FROM ${table} WHERE id = '${id}'`)).rows[0]
      ?.title;

  beforeAll(async () => {
    ObjectRegistry.registerCollection(
      'EffSyncMemo',
      EffSyncMemoCollection as never,
    );
    ObjectRegistry.registerCollection(
      'EffSyncNote',
      EffSyncNoteCollection as never,
    );
    ObjectRegistry.registerCollection(
      'EffSyncCrate',
      EffSyncCrateCollection as never,
    );
    dir = mkdtempSync(join(tmpdir(), 'smrt-effective-sync-'));
    db = await getTestDatabase({
      type: 'sqlite',
      url: join(dir, 'app.db'),
      classes: [
        EffSyncMemo,
        EffSyncNote,
        EffSyncOwnedNote,
        EffSyncCrate,
        EffSyncSealedCrate,
        EffSyncListedCrate,
      ].map((model) => keyOf(model)),
    });
    memos = (await EffSyncMemoCollection.create({
      db,
    })) as unknown as SmrtCollection<SmrtObject>;
    notes = (await EffSyncNoteCollection.create({
      db,
    })) as unknown as SmrtCollection<SmrtObject>;
    crates = (await EffSyncCrateCollection.create({
      db,
    })) as unknown as SmrtCollection<SmrtObject>;
    for (const [model, store] of [
      [EffSyncMemo, memos],
      [EffSyncNote, notes],
    ] as const) {
      collections.set(keyOf(model), store);
      collections.set(model.name, store);
    }
    collections.set(
      keyOf(EffSyncOwnedNote),
      await ObjectRegistry.getCollection(keyOf(EffSyncOwnedNote), {
        db,
      } as never),
    );
    enableTenancy();
    handler = new APIGenerator(
      {
        basePath: '/api',
        authMiddleware: () => async (req: Request) =>
          SESSIONS[tokenOf(req)]
            ? req
            : new Response('unauthorized', { status: 401 }),
        resolveTenant: (req: Request) => ({
          ...SESSIONS[tokenOf(req)],
          authenticated: true,
        }),
      },
      { db },
    ).generateHandler();
    app = await emitApp(
      'effective-tenancy-sync',
      [EffSyncMemo, EffSyncNote, EffSyncOwnedNote],
      collections,
    );
    registerTenantScopedClass(keyOf(EffSyncMemo), { mode: 'optional' });
  }, 120_000);

  afterAll(async () => {
    unregisterTenantScopedClass(keyOf(EffSyncMemo));
    disableTenancy();
    app?.dispose();
    await db?.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await withSystemContext(async () => {
      await db.query(`DELETE FROM ${memos.tableName}`);
      await db.query(`DELETE FROM ${notes.tableName}`);
      await db.query(`DELETE FROM ${crates.tableName}`);
      await crates.create({
        id: ROW.listed,
        title: 'listed crate',
        _meta_type: keyOf(EffSyncListedCrate),
      } as never);
      await memos.create({
        id: ROW.memoOfA,
        title: 'memo of a',
        tenantId: TENANT_A,
      } as never);
      await memos.create({
        id: ROW.memoOfB,
        title: 'memo of b',
        tenantId: TENANT_B,
      } as never);
      await notes.create({
        id: ROW.noteOfA,
        title: 'note of a',
        tenantId: TENANT_A,
        _meta_type: keyOf(EffSyncOwnedNote),
      } as never);
      await notes.create({
        id: ROW.noteOfB,
        title: 'note of b',
        tenantId: TENANT_B,
        _meta_type: keyOf(EffSyncOwnedNote),
      } as never);
    });
  });

  it('a principal that disagrees with the active tenant is refused', async () => {
    const item = {
      itemId: 'disagree-1',
      object: segmentOf(EffSyncMemo),
      op: 'update',
      id: ROW.memoOfA,
      payload: { title: 'changed by b' },
    };
    const rest = await withTenant({ tenantId: TENANT_A }, () =>
      restSync('user-of-b', [item]),
    );
    expect(rest.results[0]?.status ?? 'refused').not.toBe('applied');
    const emitted = await withTenant({ tenantId: TENANT_A }, () =>
      app.call('POST', 'sync/apply', {
        locals: {
          user: { id: 'writer' },
          tenantId: TENANT_B,
          permissions: [`${segmentOf(EffSyncMemo)}.update`],
        },
        body: { items: [item] },
      }),
    );
    // The emitted route decides per item: the item is refused.
    expect((emitted.body as { results: Result[] }).results[0]).toMatchObject({
      status: 'rejected',
      reason: 'forbidden',
    });
    expect(await titleOf(memos.tableName, ROW.memoOfA)).toBe('memo of a');
  });

  it('a host-entered tenant is the request tenant', async () => {
    const answer = await withTenant({ tenantId: TENANT_A }, () =>
      app.call('POST', 'sync/apply', {
        locals: {
          user: { id: 'writer' },
          permissions: [`${segmentOf(EffSyncMemo)}.update`],
        },
        body: {
          items: [
            {
              itemId: 'ours-1',
              object: segmentOf(EffSyncMemo),
              op: 'update',
              id: ROW.memoOfA,
              payload: { title: 'changed by a' },
            },
            {
              itemId: 'theirs-1',
              object: segmentOf(EffSyncMemo),
              op: 'update',
              id: ROW.memoOfB,
              payload: { title: 'changed by a' },
            },
          ],
        },
      }),
    );
    const results = (answer.body as { results: Result[] }).results;
    expect(results[0]?.status).toBe('applied');
    expect(results[1]?.status).toBe('rejected');
    expect(await titleOf(memos.tableName, ROW.memoOfA)).toBe('changed by a');
    expect(await titleOf(memos.tableName, ROW.memoOfB)).toBe('memo of b');
  });

  it('a replayed create naming a hidden row answers the same conflict for any payload', async () => {
    const replay = (payload: Record<string, unknown>) =>
      restSync('user-of-a', [
        {
          itemId: 'replay-1',
          object: segmentOf(EffSyncNote),
          op: 'create',
          id: ROW.noteOfA,
          payload,
        },
      ]);
    const same = await replay({ title: 'note of a' });
    const different = await replay({ title: 'something else' });
    expect(same.results[0]).toEqual(different.results[0]);
    expect(same.results[0]).toMatchObject({
      status: 'rejected',
      reason: 'id_conflict',
    });
    expect(same.results[0]?.updatedAt).toBeUndefined();
  });

  it('queued items for a subtype the shared segment no longer serves get the documented rejection', async () => {
    const queued = await restSync('user-of-a', [
      {
        itemId: 'queued-update',
        object: segmentOf(EffSyncNote),
        op: 'update',
        id: ROW.noteOfA,
        payload: { title: 'changed through the base' },
      },
      {
        itemId: 'queued-delete',
        object: segmentOf(EffSyncNote),
        op: 'delete',
        id: ROW.noteOfA,
      },
    ]);
    expect(queued.results[0]).toMatchObject({
      status: 'rejected',
      reason: 'not_found',
    });
    expect(await titleOf(notes.tableName, ROW.noteOfA)).toBe('note of a');
  });

  describe('create targets and read membership are separate (R2.10, R2.11)', () => {
    it('a base create selects a member whose surface opens create only', async () => {
      const answer = await restCall(handler, 'POST', segmentOf(EffSyncCrate), {
        headers: { authorization: 'Bearer user-of-a' },
        body: {
          title: 'new sealed crate',
          _meta_type: keyOf(EffSyncSealedCrate),
        },
      });
      expect(answer.status).toBe(201);
      const stored = (
        await db.query(
          `SELECT _meta_type FROM ${crates.tableName} WHERE title = 'new sealed crate'`,
        )
      ).rows.map((row) => row._meta_type);
      expect(stored).toEqual([keyOf(EffSyncSealedCrate)]);
    });

    it('a replayed create naming a row the route does not read answers the same conflict for any payload', async () => {
      const replay = (payload: Record<string, unknown>) =>
        restSync('user-of-a', [
          {
            itemId: 'replay-listed',
            object: segmentOf(EffSyncCrate),
            op: 'create',
            id: ROW.listed,
            payload,
          },
        ]);
      const same = await replay({ title: 'listed crate' });
      const different = await replay({ title: 'something else' });
      expect(same.results[0]).toEqual(different.results[0]);
      expect(same.results[0]).toMatchObject({
        status: 'rejected',
        reason: 'id_conflict',
      });
      expect(same.results[0]?.updatedAt).toBeUndefined();
    });

    it('a sync create naming another type is rejected and writes no row', async () => {
      const item = {
        itemId: 'typed-create',
        object: segmentOf(EffSyncNote),
        op: 'create',
        id: ROW.fresh,
        payload: { title: 'typed note', _meta_type: keyOf(EffSyncOwnedNote) },
      };
      const rest = await restSync('user-of-a', [item]);
      expect(rest.results[0]).toMatchObject({
        status: 'rejected',
        reason: 'invalid_payload',
      });
      const emitted = await app.call('POST', 'sync/apply', {
        locals: {
          user: { id: 'writer' },
          tenantId: TENANT_A,
          permissions: [`${segmentOf(EffSyncNote)}.create`],
        },
        body: { items: [item] },
      });
      expect((emitted.body as { results: Result[] }).results[0]).toMatchObject({
        status: 'rejected',
        reason: 'invalid_payload',
      });
      expect(await titleOf(notes.tableName, ROW.fresh)).toBeUndefined();
      // The route's own type in the selector is accepted (control).
      const own = await restSync('user-of-a', [
        {
          ...item,
          itemId: 'own-type',
          payload: { title: 'plain note', _meta_type: keyOf(EffSyncNote) },
        },
      ]);
      expect(own.results[0]?.status).toBe('applied');
    });
  });
});
