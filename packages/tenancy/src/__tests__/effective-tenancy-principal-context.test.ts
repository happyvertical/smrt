/**
 * A route that carries a complete principal (`api.principalContext`) runs
 * the request in the principal's tenant context on a model with no tenancy,
 * with smrt-tenancy loaded and tenancy not enabled: code the request runs (a
 * custom collection action, a save during a sync item) reads the caller's
 * tenant, user and permissions there, and an active context of another
 * tenant refuses the request. Emitted SvelteKit routes on a SQLite file.
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
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getCurrentTenant, withSystemContext, withTenant } from '../context.js';
import { disableTenancy, isTenancyEnabled } from '../interceptor.js';
import {
  collectionEntryFor,
  type EmittedApp,
  emitApp,
  keyOf,
  segmentOf,
  TENANT_A,
  TENANT_B,
} from './helpers/effective-tenancy-harness.js';

/** The tenant context code of the request sees. */
function seenContext() {
  const context = getCurrentTenant();
  return {
    tenantId: context?.tenantId ?? null,
    userId: context?.userId ?? null,
    permissions: [...(context?.permissions ?? [])].sort(),
  };
}

@smrt({
  api: {
    include: ['list', 'get', 'create', 'update', 'submit'],
    principalContext: true,
  },
})
class EffPermit extends SmrtObject {
  @field({ type: 'text' }) title = '';
  @field({ type: 'text', nullable: true }) savedIn: string | null = null;

  override async save() {
    this.savedIn = getCurrentTenant()?.tenantId ?? null;
    return super.save();
  }
}
class EffPermitCollection extends SmrtCollection<EffPermit> {
  static readonly _itemClass = EffPermit;
  async submit(_options?: unknown) {
    return seenContext();
  }
}

const ROW = {
  existing: 'aaaaaaaa-0000-4000-8000-0000000000e1',
  fresh: 'aaaaaaaa-0000-4000-8000-0000000000e2',
};

type Result = { itemId: string; status: string; reason?: string };

describe('a complete principal runs the request in its tenant context with tenancy not enabled', () => {
  let dir: string;
  let db: DatabaseInterface;
  let app: EmittedApp;
  let permits: SmrtCollection<SmrtObject>;
  const collections = new Map<string, unknown>();

  const permissions = () =>
    ['submit', 'create', 'update'].flatMap((action) => [
      `${segmentOf(EffPermit)}.${action}`,
      `effpermit.${action}`,
    ]);
  const principal = () => ({
    user: { id: 'writer-a' },
    tenantId: TENANT_A,
    permissions: permissions(),
  });
  const savedIn = async (id: string) =>
    (
      await db.query(
        `SELECT saved_in FROM ${permits.tableName} WHERE id = '${id}'`,
      )
    ).rows[0]?.saved_in ?? null;

  beforeAll(async () => {
    disableTenancy();
    ObjectRegistry.registerCollection(
      'EffPermit',
      EffPermitCollection as never,
    );
    dir = mkdtempSync(join(tmpdir(), 'smrt-effective-principal-'));
    db = await getTestDatabase({
      type: 'sqlite',
      url: join(dir, 'app.db'),
      classes: [keyOf(EffPermit)],
    });
    permits = (await EffPermitCollection.create({
      db,
    })) as unknown as SmrtCollection<SmrtObject>;
    for (const key of [keyOf(EffPermit), 'EffPermit']) {
      collections.set(key, permits);
      collections.set(`${key}Collection`, permits);
    }
    app = await emitApp(
      'effective-tenancy-principal-context',
      [EffPermit],
      collections,
      Object.fromEntries([
        collectionEntryFor(EffPermit, { submit: ['options'] }),
      ]),
    );
  }, 120_000);

  afterAll(async () => {
    app?.dispose();
    await db?.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    expect(isTenancyEnabled()).toBe(false);
    await withSystemContext(async () => {
      await db.query(`DELETE FROM ${permits.tableName}`);
      await permits.create({ id: ROW.existing, title: 'existing' } as never);
    });
  });

  it("a custom collection action runs in the signed-in caller's tenant context", async () => {
    const answer = await app.call('POST', `${segmentOf(EffPermit)}/submit`, {
      locals: principal(),
      body: {},
    });
    expect(answer.status).toBe(200);
    expect((answer.body as { result: unknown }).result).toEqual({
      tenantId: TENANT_A,
      userId: 'writer-a',
      permissions: permissions().sort(),
    });
  });

  it('a custom collection action is refused when the active tenant context is another tenant', async () => {
    const answer = await withTenant({ tenantId: TENANT_B }, () =>
      app.call('POST', `${segmentOf(EffPermit)}/submit`, {
        locals: principal(),
        body: {},
      }),
    );
    expect(answer.status).toBe(403);
  });

  it("a sync item runs in the signed-in caller's tenant context", async () => {
    const answer = await app.call('POST', 'sync/apply', {
      locals: principal(),
      body: {
        items: [
          {
            itemId: 'create-1',
            object: segmentOf(EffPermit),
            op: 'create',
            id: ROW.fresh,
            payload: { title: 'fresh' },
          },
          {
            itemId: 'update-1',
            object: segmentOf(EffPermit),
            op: 'update',
            id: ROW.existing,
            payload: { title: 'changed' },
          },
        ],
      },
    });
    const results = (answer.body as { results: Result[] }).results;
    expect(results.map((result) => result.status)).toEqual([
      'applied',
      'applied',
    ]);
    expect(await savedIn(ROW.fresh)).toBe(TENANT_A);
    expect(await savedIn(ROW.existing)).toBe(TENANT_A);
  });

  it('a sync item is refused when the active tenant context is another tenant', async () => {
    const answer = await withTenant({ tenantId: TENANT_B }, () =>
      app.call('POST', 'sync/apply', {
        locals: principal(),
        body: {
          items: [
            {
              itemId: 'update-2',
              object: segmentOf(EffPermit),
              op: 'update',
              id: ROW.existing,
              payload: { title: 'changed' },
            },
          ],
        },
      }),
    );
    expect((answer.body as { results: Result[] }).results[0]).toMatchObject({
      status: 'rejected',
      reason: 'forbidden',
    });
    expect(await savedIn(ROW.existing)).toBeNull();
  });
});
