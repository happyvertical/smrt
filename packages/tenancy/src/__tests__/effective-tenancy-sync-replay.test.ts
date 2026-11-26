/**
 * Runtime REST sync: a replayed create answers about an existing row only
 * when the caller may read that row's own type, and a create that names its
 * target's own type in `createType` is applied like one that names none.
 * The real tenant interceptor on a SQLite file.
 *
 * Rows R3.7 and R3.8 of the #5375 round-3 matrix.
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
  keyOf,
  restCall,
  segmentOf,
  TENANT_A,
} from './helpers/effective-tenancy-harness.js';

// An unscoped STI base and a member of the same tenancy, open for every
// operation; the host lets only some callers read the member.
@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
})
class EffReplayCrate extends SmrtObject {
  @field({ type: 'text' }) title = '';
}
class EffReplayCrateCollection extends SmrtCollection<EffReplayCrate> {
  static readonly _itemClass = EffReplayCrate;
}
@smrt({ api: { include: ['list', 'get', 'create', 'update', 'delete'] } })
class EffReplaySealedCrate extends EffReplayCrate {}

const ROW = {
  sealed: 'cccccccc-0000-4000-8000-0000000000c1',
  fresh: 'dddddddd-0000-4000-8000-0000000000d1',
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

describe('runtime REST sync creates', () => {
  let dir: string;
  let db: DatabaseInterface;
  let handler: (req: Request) => Promise<Response>;
  let crates: SmrtCollection<SmrtObject>;

  const sync = async (token: string, items: unknown[]) => {
    const answer = await restCall(handler, 'POST', 'sync/apply', {
      headers: { authorization: `Bearer ${token}` },
      body: { items },
    });
    return ((answer.body as { results?: Result[] })?.results ?? []) as Result[];
  };

  beforeAll(async () => {
    ObjectRegistry.registerCollection(
      'EffReplayCrate',
      EffReplayCrateCollection as never,
    );
    dir = mkdtempSync(join(tmpdir(), 'smrt-effective-sync-replay-'));
    db = await getTestDatabase({
      type: 'sqlite',
      url: join(dir, 'app.db'),
      classes: [EffReplayCrate, EffReplaySealedCrate].map((model) =>
        keyOf(model),
      ),
    });
    crates = (await EffReplayCrateCollection.create({
      db,
    })) as unknown as SmrtCollection<SmrtObject>;
    enableTenancy();
    const sealed = keyOf(EffReplaySealedCrate);
    handler = new APIGenerator(
      {
        basePath: '/api',
        // `writer` may write through the base but may not read the sealed
        // member; `reader` may read it.
        authMiddleware:
          (objectName: string, method: string) => async (req: Request) =>
            tokenOf(req) === 'writer' &&
            objectName === sealed &&
            method === 'get'
              ? new Response('forbidden', { status: 403 })
              : req,
        resolveTenant: () => ({ tenantId: TENANT_A, authenticated: true }),
      },
      { db },
    ).generateHandler();
  }, 60_000);

  afterAll(async () => {
    disableTenancy();
    await db?.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await withSystemContext(async () => {
      await db.query(`DELETE FROM ${crates.tableName}`);
      await crates.create({
        id: ROW.sealed,
        title: 'sealed crate',
        _meta_type: keyOf(EffReplaySealedCrate),
      } as never);
    });
  });

  describe('replay (R3.7)', () => {
    it('a replayed create naming a row of a type the caller may not read answers the same conflict for any payload', async () => {
      const replay = (token: string, payload: Record<string, unknown>) =>
        sync(token, [
          {
            itemId: 'replay-sealed',
            object: segmentOf(EffReplayCrate),
            op: 'create',
            id: ROW.sealed,
            payload,
          },
        ]);
      const same = await replay('writer', { title: 'sealed crate' });
      const different = await replay('writer', { title: 'something else' });
      expect(same[0]).toEqual(different[0]);
      expect(same[0]).toMatchObject({
        status: 'rejected',
        reason: 'id_conflict',
      });
      expect(same[0]?.updatedAt).toBeUndefined();
      // A caller that may read the member gets the replay (control).
      const reader = await replay('reader', { title: 'sealed crate' });
      expect(reader[0]?.status).toBe('applied');
    });
  });

  describe('type selector (R3.8)', () => {
    it("a create naming its target's own type in createType is applied", async () => {
      const results = await sync('reader', [
        {
          itemId: 'own-type',
          object: segmentOf(EffReplayCrate),
          op: 'create',
          id: ROW.fresh,
          payload: { title: 'new crate', createType: keyOf(EffReplayCrate) },
        },
      ]);
      expect(results[0]?.status).toBe('applied');
      const stored = (
        await db.query(
          `SELECT title, _meta_type FROM ${crates.tableName} WHERE id = '${ROW.fresh}'`,
        )
      ).rows.map((row) => [row.title, row._meta_type]);
      expect(stored).toEqual([['new crate', keyOf(EffReplayCrate)]]);
      // A replay of the same create is idempotent.
      const again = await sync('reader', [
        {
          itemId: 'own-type',
          object: segmentOf(EffReplayCrate),
          op: 'create',
          id: ROW.fresh,
          payload: { title: 'new crate', createType: keyOf(EffReplayCrate) },
        },
      ]);
      expect(again[0]?.status).toBe('applied');
    });
  });
});
