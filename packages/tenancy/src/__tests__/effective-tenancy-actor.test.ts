/**
 * The actor a request acts as is settled once and is the same actor the
 * operation runs as, on runtime REST, its sync route and the emitted sync
 * route, with the real tenant interceptor on a SQLite file.
 *
 * Rows R2.1 to R2.3 of the #5375 round-2 matrix.
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
import { withSystemContext } from '../context.js';
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
class EffActorMemo extends SmrtObject {
  @field({ type: 'text' }) title = '';
  @field({ type: 'text', nullable: true }) tenantId: string | null = null;
}
class EffActorMemoCollection extends SmrtCollection<EffActorMemo> {
  static readonly _itemClass = EffActorMemo;
}

// Writes need a complete principal.
@smrt({
  api: {
    include: ['list', 'get', 'create', 'update', 'delete'],
    principalContext: true,
  },
})
class EffActorLedger extends SmrtObject {
  @field({ type: 'text' }) title = '';
  @field({ type: 'text', nullable: true }) tenantId: string | null = null;
}
class EffActorLedgerCollection extends SmrtCollection<EffActorLedger> {
  static readonly _itemClass = EffActorLedger;
}

const ROW = {
  memoOfA: 'aaaaaaaa-0000-4000-8000-0000000000a1',
  memoOfB: 'bbbbbbbb-0000-4000-8000-0000000000b1',
  memoOfNone: 'cccccccc-0000-4000-8000-0000000000c1',
  ledgerOfA: 'aaaaaaaa-0000-4000-8000-0000000000a2',
};

type Result = { itemId: string; status: string; reason?: string };

describe('the request actor is settled once and runs the operation', () => {
  let dir: string;
  let db: DatabaseInterface;
  let memos: SmrtCollection<SmrtObject>;
  let ledgers: SmrtCollection<SmrtObject>;
  let app: EmittedApp;
  const collections = new Map<string, unknown>();
  const registered: string[] = [];

  const titleOf = async (table: string, id: string) =>
    (await db.query(`SELECT title FROM ${table} WHERE id = '${id}'`)).rows[0]
      ?.title;

  beforeAll(async () => {
    ObjectRegistry.registerCollection(
      'EffActorMemo',
      EffActorMemoCollection as never,
    );
    ObjectRegistry.registerCollection(
      'EffActorLedger',
      EffActorLedgerCollection as never,
    );
    dir = mkdtempSync(join(tmpdir(), 'smrt-effective-actor-'));
    db = await getTestDatabase({
      type: 'sqlite',
      url: join(dir, 'app.db'),
      classes: [EffActorMemo, EffActorLedger].map((model) => keyOf(model)),
    });
    memos = (await EffActorMemoCollection.create({
      db,
    })) as unknown as SmrtCollection<SmrtObject>;
    ledgers = (await EffActorLedgerCollection.create({
      db,
    })) as unknown as SmrtCollection<SmrtObject>;
    for (const [model, store] of [
      [EffActorMemo, memos],
      [EffActorLedger, ledgers],
    ] as const) {
      collections.set(keyOf(model), store);
      collections.set(model.name, store);
    }
    enableTenancy();
    app = await emitApp(
      'effective-tenancy-actor',
      [EffActorMemo, EffActorLedger],
      collections,
    );
    for (const model of [EffActorMemo, EffActorLedger]) {
      registerTenantScopedClass(keyOf(model), { mode: 'optional' });
      registered.push(keyOf(model));
    }
  }, 120_000);

  afterAll(async () => {
    for (const key of registered) unregisterTenantScopedClass(key);
    disableTenancy();
    app?.dispose();
    await db?.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await withSystemContext(async () => {
      await db.query(`DELETE FROM ${memos.tableName}`);
      await db.query(`DELETE FROM ${ledgers.tableName}`);
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
      await memos.create({
        id: ROW.memoOfNone,
        title: 'memo of none',
      } as never);
      await ledgers.create({
        id: ROW.ledgerOfA,
        title: 'ledger of a',
        tenantId: TENANT_A,
      } as never);
    });
  });

  describe('runtime REST sync (R2.1)', () => {
    it('a sync item runs as the principal the host settled for the request its middleware returned', async () => {
      // The host attaches its principal to the request object its
      // middleware returns; only that object carries it.
      const principals = new WeakMap<Request, { tenantId: string }>();
      const asked: Request[] = [];
      const returned: Request[] = [];
      const handler = new APIGenerator(
        {
          basePath: '/api',
          authMiddleware: () => async (req: Request) => {
            if (req.headers.get('authorization') !== 'Bearer user-of-a') {
              return new Response('unauthorized', { status: 401 });
            }
            const admitted = new Request(req);
            principals.set(admitted, { tenantId: TENANT_A });
            returned.push(admitted);
            return admitted;
          },
          resolveTenant: (req: Request) => {
            asked.push(req);
            const principal = principals.get(req);
            return principal
              ? { ...principal, authenticated: true }
              : { authenticated: true };
          },
        },
        { db },
      ).generateHandler();
      const answer = await restCall(handler, 'POST', 'sync/apply', {
        headers: { authorization: 'Bearer user-of-a' },
        body: {
          items: [
            {
              itemId: 'ours-1',
              object: segmentOf(EffActorMemo),
              op: 'update',
              id: ROW.memoOfA,
              payload: { title: 'changed by a' },
            },
            {
              itemId: 'theirs-1',
              object: segmentOf(EffActorMemo),
              op: 'update',
              id: ROW.memoOfB,
              payload: { title: 'changed by a' },
            },
          ],
        },
      });
      const results = (answer.body as { results: Result[] }).results;
      expect(results[0]?.status).toBe('applied');
      expect(results[1]?.status).toBe('rejected');
      expect(await titleOf(memos.tableName, ROW.memoOfA)).toBe('changed by a');
      expect(await titleOf(memos.tableName, ROW.memoOfB)).toBe('memo of b');
      // The host was asked about the requests its middleware returned, and
      // about each of them once.
      expect(asked.length).toBeGreaterThan(0);
      for (const req of asked) expect(returned).toContain(req);
      expect(new Set(asked).size).toBe(asked.length);
    });
  });
});
