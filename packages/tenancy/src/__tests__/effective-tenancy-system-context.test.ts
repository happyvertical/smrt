/**
 * Code that enters a system context inside a request acts as the system, and
 * code that enters a tenant context in a request with no tenant acts in that
 * tenant, as each does outside a request; a request admitted under a
 * cross-tenant read grant writes no tenant-scoped row, whatever context its
 * code enters. Runtime REST with the real tenant interceptor on a SQLite
 * file.
 *
 * Rows R3.1 and R3.2 of the #5375 round-3 matrix.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  field,
  ObjectRegistry,
  runInRequestTenancy,
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
  keyOf,
  restCall,
  segmentOf,
  TENANT_A,
  TENANT_B,
} from './helpers/effective-tenancy-harness.js';

/** Collections the desk's actions reach (set in `beforeAll`). */
const reached: {
  logs?: SmrtCollection<SmrtObject>;
  vaults?: SmrtCollection<SmrtObject>;
} = {};

const stampAll = async () => {
  const rows = await (reached.logs as SmrtCollection<SmrtObject>).list({});
  for (const row of rows) {
    (row as unknown as { title: string }).title = 'stamped';
    await row.save();
  }
  return rows.length;
};

// An unscoped model whose actions reach tenant-scoped models.
@smrt({
  api: {
    include: [
      'list',
      'stampAsSystem',
      'recordAsSystem',
      'countVaultsAsSystem',
      'stampThroughRequest',
      'stampInTenantB',
    ],
    routes: {
      stampAsSystem: { method: 'GET', path: 'stamp-as-system' },
      recordAsSystem: { method: 'POST', path: 'record-as-system' },
      countVaultsAsSystem: { method: 'GET', path: 'count-vaults-as-system' },
      stampThroughRequest: { method: 'GET', path: 'stamp-through-request' },
      stampInTenantB: { method: 'GET', path: 'stamp-in-tenant-b' },
    },
  },
})
class EffSysDesk extends SmrtObject {
  @field({ type: 'text' }) title = '';
}
class EffSysDeskCollection extends SmrtCollection<EffSysDesk> {
  static readonly _itemClass = EffSysDesk;
  /** A read action whose code writes another model as the system. */
  async stampAsSystem(_options?: unknown) {
    return withSystemContext(stampAll);
  }
  /** A mutating action whose code records a row as the system. */
  async recordAsSystem(_options?: unknown) {
    await withSystemContext(async () => {
      await (reached.logs as SmrtCollection<SmrtObject>).create({
        title: 'recorded',
        tenantId: TENANT_B,
      } as never);
    });
    return 'recorded';
  }
  /** A read action whose code reads a required-mode model as the system. */
  async countVaultsAsSystem(_options?: unknown) {
    return withSystemContext(
      async () =>
        (await (reached.vaults as SmrtCollection<SmrtObject>).list({})).length,
    );
  }
  /** A read action that hands its writes to a nested request scope. */
  async stampThroughRequest(_options?: unknown) {
    return runInRequestTenancy(
      {
        model: keyOf(EffSysLog),
        operation: 'update',
        principal: { authenticated: true },
      },
      stampAll,
    );
  }
  /** A read action whose code writes another model inside a tenant. */
  async stampInTenantB(_options?: unknown) {
    return withTenant({ tenantId: TENANT_B }, stampAll);
  }
}

@smrt({})
@TenantScoped({ mode: 'optional' })
class EffSysLog extends SmrtObject {
  @field({ type: 'text' }) title = '';
  @tenantId({ nullable: true }) tenantId: string | null = null;
}
class EffSysLogCollection extends SmrtCollection<EffSysLog> {
  static readonly _itemClass = EffSysLog;
}

@smrt({})
@TenantScoped({ mode: 'required' })
class EffSysVault extends SmrtObject {
  @field({ type: 'text' }) title = '';
  @tenantId() tenantId = '';
}
class EffSysVaultCollection extends SmrtCollection<EffSysVault> {
  static readonly _itemClass = EffSysVault;
}

const SESSIONS: Record<string, Record<string, unknown>> = {
  reader: {},
  'user-of-a': { tenantId: TENANT_A },
  operator: { allowCrossTenant: true },
};
const tokenOf = (req: Request) =>
  (req.headers.get('authorization') ?? '').replace('Bearer ', '');
const as = (token: string) => ({
  headers: { authorization: `Bearer ${token}` },
});

describe('a system context entered inside a request', () => {
  let dir: string;
  let db: DatabaseInterface;
  let handler: (req: Request) => Promise<Response>;
  let desks: SmrtCollection<SmrtObject>;

  const logTitles = async () =>
    (
      await db.query(
        `SELECT title FROM ${(reached.logs as SmrtCollection<SmrtObject>).tableName} ORDER BY title`,
      )
    ).rows.map((row) => String(row.title));
  const action = (path: string) => `${segmentOf(EffSysDesk)}/${path}`;

  beforeAll(async () => {
    ObjectRegistry.registerCollection(
      'EffSysDesk',
      EffSysDeskCollection as never,
    );
    // A loaded manifest records a collection-hosted action's parameters under
    // the collection class; these actions take an options bag.
    ObjectRegistry.register(EffSysDeskCollection as never, {});
    ObjectRegistry.getMethods('EffSysDeskCollection').clear();
    for (const name of [
      'stampAsSystem',
      'recordAsSystem',
      'countVaultsAsSystem',
      'stampThroughRequest',
      'stampInTenantB',
    ]) {
      ObjectRegistry.getMethods('EffSysDeskCollection').set(name, {
        name,
        parameters: [{ name: 'options', type: 'any', optional: true }],
        returnType: 'Promise<any>',
        isPublic: true,
      } as never);
    }
    dir = mkdtempSync(join(tmpdir(), 'smrt-effective-system-'));
    db = await getTestDatabase({
      type: 'sqlite',
      url: join(dir, 'app.db'),
      classes: [EffSysDesk, EffSysLog, EffSysVault].map((model) =>
        keyOf(model),
      ),
    });
    desks = (await EffSysDeskCollection.create({
      db,
    })) as unknown as SmrtCollection<SmrtObject>;
    reached.logs = (await EffSysLogCollection.create({
      db,
    })) as unknown as SmrtCollection<SmrtObject>;
    reached.vaults = (await EffSysVaultCollection.create({
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
      const logs = reached.logs as SmrtCollection<SmrtObject>;
      const vaults = reached.vaults as SmrtCollection<SmrtObject>;
      await db.query(`DELETE FROM ${desks.tableName}`);
      await db.query(`DELETE FROM ${logs.tableName}`);
      await db.query(`DELETE FROM ${vaults.tableName}`);
      await desks.create({ title: 'desk' } as never);
      await logs.create({ title: 'log of a', tenantId: TENANT_A } as never);
      await logs.create({ title: 'log of b', tenantId: TENANT_B } as never);
      await vaults.create({ title: 'vault of a', tenantId: TENANT_A } as never);
      await vaults.create({ title: 'vault of b', tenantId: TENANT_B } as never);
    });
  });

  describe('acts as the system (R3.1)', () => {
    it('a request with no tenant writes and reads tenant-scoped models from code that entered a system context', async () => {
      const stamped = await restCall(
        handler,
        'GET',
        action('stamp-as-system'),
        as('reader'),
      );
      expect(stamped.status).toBe(200);
      expect(await logTitles()).toEqual(['stamped', 'stamped']);

      const recorded = await restCall(
        handler,
        'POST',
        action('record-as-system'),
      );
      expect(recorded.status).toBeLessThan(300);
      expect(await logTitles()).toEqual(['recorded', 'stamped', 'stamped']);

      const vaults = await restCall(
        handler,
        'GET',
        action('count-vaults-as-system'),
      );
      expect(vaults.status).toBe(200);
      expect((vaults.body as { result: unknown }).result).toBe(2);
    });

    it('a request with no tenant acts in a tenant context its code entered', async () => {
      const stamped = await restCall(
        handler,
        'GET',
        action('stamp-in-tenant-b'),
        as('reader'),
      );
      expect(stamped.status).toBe(200);
      expect(await logTitles()).toEqual(['log of a', 'stamped']);
    });

    it("a tenant's request acts as the system from code that entered one (control)", async () => {
      const stamped = await restCall(
        handler,
        'GET',
        action('stamp-as-system'),
        as('user-of-a'),
      );
      expect(stamped.status).toBe(200);
      expect(await logTitles()).toEqual(['stamped', 'stamped']);
    });
  });

  describe('a read grant stays read-only (R3.2)', () => {
    it('a request admitted under a read grant writes no tenant-scoped row from a system context its code enters', async () => {
      const answer = await restCall(
        handler,
        'GET',
        action('stamp-as-system'),
        as('operator'),
      );
      expect(answer.status).toBe(403);
      expect(await logTitles()).toEqual(['log of a', 'log of b']);
    });

    it('a nested request scope inside a read grant writes no tenant-scoped row', async () => {
      const answer = await restCall(
        handler,
        'GET',
        action('stamp-through-request'),
        as('operator'),
      );
      expect(answer.status).toBe(403);
      expect(await logTitles()).toEqual(['log of a', 'log of b']);
    });

    it('a read grant inside a host-entered tenant writes no tenant-scoped row', async () => {
      const answer = await withTenant({ tenantId: TENANT_A }, () =>
        restCall(handler, 'GET', action('stamp-as-system'), as('operator')),
      );
      expect(answer.status).toBe(403);
      expect(await logTitles()).toEqual(['log of a', 'log of b']);
    });
  });
});
