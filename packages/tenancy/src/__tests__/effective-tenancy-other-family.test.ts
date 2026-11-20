/**
 * A request that reads an STI family other than its route's is held to that
 * family's tenancy too: rows of a member whose tenancy differs from the base
 * it reads through are not served, as on the family's own routes. Runtime
 * REST with the real tenant interceptor on a SQLite file.
 *
 * Row R3.6 of the #5375 round-3 matrix.
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
import { TenantScoped, tenantId } from '../decorators.js';
import { disableTenancy, enableTenancy } from '../interceptor.js';
import {
  keyOf,
  restCall,
  segmentOf,
  TENANT_A,
  TENANT_B,
} from './helpers/effective-tenancy-harness.js';

/** The crate collection the desk's actions read (set in `beforeAll`). */
const reached: { crates?: SmrtCollection<SmrtObject> } = {};

const ROW = {
  crate: 'cccccccc-0000-4000-8000-0000000000c1',
  lockedOfA: 'aaaaaaaa-0000-4000-8000-0000000000a1',
  lockedOfB: 'bbbbbbbb-0000-4000-8000-0000000000b1',
};

// An unscoped model whose read actions read another STI family.
@smrt({
  api: {
    include: ['list', 'crateTitles', 'crateById'],
    routes: {
      crateTitles: { method: 'GET', path: 'crate-titles' },
      crateById: { method: 'GET', path: 'crate-by-id' },
    },
  },
})
class EffOtherDesk extends SmrtObject {
  @field({ type: 'text' }) title = '';
}
class EffOtherDeskCollection extends SmrtCollection<EffOtherDesk> {
  static readonly _itemClass = EffOtherDesk;
  /** Titles of every crate the request may read, through the base. */
  async crateTitles(_options?: unknown) {
    const rows = await (reached.crates as SmrtCollection<SmrtObject>).list({});
    return rows
      .map((row) => (row as unknown as { title: string }).title)
      .sort();
  }
  /** Each crate's title by id, or null where it is not served. */
  async crateById(_options?: unknown) {
    const crates = reached.crates as SmrtCollection<SmrtObject>;
    const titles: Record<string, string | null> = {};
    for (const [name, id] of Object.entries(ROW)) {
      const row = await crates.get(id);
      titles[name] = row ? (row as unknown as { title: string }).title : null;
    }
    return titles;
  }
}

// An unscoped STI base with a tenant-scoped subtype.
@smrt({ tableStrategy: 'sti' })
class EffOtherCrate extends SmrtObject {
  @field({ type: 'text' }) title = '';
}
class EffOtherCrateCollection extends SmrtCollection<EffOtherCrate> {
  static readonly _itemClass = EffOtherCrate;
}
@smrt({})
@TenantScoped({ mode: 'optional' })
class EffOtherLockedCrate extends EffOtherCrate {
  @tenantId({ nullable: true }) tenantId: string | null = null;
}

const SESSIONS: Record<string, Record<string, unknown>> = {
  'user-of-a': { tenantId: TENANT_A },
};
const tokenOf = (req: Request) =>
  (req.headers.get('authorization') ?? '').replace('Bearer ', '');

describe('a read of another STI family is held to that family', () => {
  let dir: string;
  let db: DatabaseInterface;
  let handler: (req: Request) => Promise<Response>;
  let desks: SmrtCollection<SmrtObject>;
  const action = (path: string, token?: string) =>
    restCall(
      handler,
      'GET',
      `${segmentOf(EffOtherDesk)}/${path}`,
      token ? { headers: { authorization: `Bearer ${token}` } } : {},
    );

  beforeAll(async () => {
    ObjectRegistry.registerCollection(
      'EffOtherDesk',
      EffOtherDeskCollection as never,
    );
    ObjectRegistry.register(EffOtherDeskCollection as never, {});
    ObjectRegistry.getMethods('EffOtherDeskCollection').clear();
    for (const name of ['crateTitles', 'crateById']) {
      ObjectRegistry.getMethods('EffOtherDeskCollection').set(name, {
        name,
        parameters: [{ name: 'options', type: 'any', optional: true }],
        returnType: 'Promise<any>',
        isPublic: true,
      } as never);
    }
    dir = mkdtempSync(join(tmpdir(), 'smrt-effective-other-family-'));
    db = await getTestDatabase({
      type: 'sqlite',
      url: join(dir, 'app.db'),
      classes: [EffOtherDesk, EffOtherCrate, EffOtherLockedCrate].map((model) =>
        keyOf(model),
      ),
    });
    desks = (await EffOtherDeskCollection.create({
      db,
    })) as unknown as SmrtCollection<SmrtObject>;
    reached.crates = (await EffOtherCrateCollection.create({
      db,
    })) as unknown as SmrtCollection<SmrtObject>;
    enableTenancy();
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
  }, 60_000);

  afterAll(async () => {
    disableTenancy();
    await db?.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await withSystemContext(async () => {
      const crates = reached.crates as SmrtCollection<SmrtObject>;
      await db.query(`DELETE FROM ${desks.tableName}`);
      await db.query(`DELETE FROM ${crates.tableName}`);
      await desks.create({ title: 'desk' } as never);
      await crates.create({ id: ROW.crate, title: 'crate' } as never);
      for (const [id, title, owner] of [
        [ROW.lockedOfA, 'locked crate of a', TENANT_A],
        [ROW.lockedOfB, 'locked crate of b', TENANT_B],
      ] as const) {
        await crates.create({
          id,
          title,
          tenantId: owner,
          _meta_type: keyOf(EffOtherLockedCrate),
        } as never);
      }
    });
  });

  it('a read with no tenant through an unscoped base serves no row of a tenant-scoped subtype', async () => {
    const listed = await action('crate-titles');
    expect(listed.status).toBe(200);
    expect((listed.body as { result: unknown }).result).toEqual(['crate']);

    const byId = await action('crate-by-id');
    expect(byId.status).toBe(200);
    expect((byId.body as { result: unknown }).result).toEqual({
      crate: 'crate',
      lockedOfA: null,
      lockedOfB: null,
    });
  });

  it("a tenant's read through the base serves no row of the subtype either", async () => {
    const listed = await action('crate-titles', 'user-of-a');
    expect((listed.body as { result: unknown }).result).toEqual(['crate']);
  });
});
