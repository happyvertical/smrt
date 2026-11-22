/**
 * Permission contexts and the request scope of a REST request (#5195).
 *
 * - A module error thrown by the caller's own callback is the callback's
 *   error: the callback runs once and the error reaches the caller.
 * - Inside a request acting for a host-resolved principal, the operation
 *   permission gate never allows a slug the principal lacks, whatever
 *   branch would grant it.
 */

import { existsSync, rmSync } from 'node:fs';
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
import { withSystemContext, withTenant } from '@happyvertical/smrt-tenancy';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkOperationPermission,
  type OperationPermissionOptions,
} from '../services/OperationPermissionService.js';
import type { PermissionCatalog } from '../services/PermissionCatalogService.js';
import type { PermissionResolver } from '../services/PermissionResolver.js';
import { withPrincipalPermissionContext } from '../services/SessionPermissionContext.js';

const TENANT = 'a0000000-5195-4000-8000-0000000000aa';
const OTHER_TENANT = 'b0000000-5195-4000-8000-0000000000bb';

/** Work a test runs inside the `check` action. */
let checkWork: (() => Promise<unknown>) | undefined;
let checked: unknown;

@smrt({
  api: {
    include: ['list', 'check'],
    routes: { check: { method: 'POST', scope: 'collection' } },
  },
})
class GateWidget extends SmrtObject {
  @field({ type: 'text' })
  title = '';
}
class GateWidgetCollection extends SmrtCollection<GateWidget> {
  static readonly _itemClass = GateWidget;

  async check(): Promise<{ ok: true }> {
    checked = await checkWork?.();
    return { ok: true };
  }
}

const catalog = {
  customPermissions: [],
  manifestPermissions: [],
  runtimePermissions: [],
  permissions: ['read', 'delete', 'check'].map((action) => ({
    slug: `gatewidgets.${action}`,
    name: action,
  })),
} as unknown as PermissionCatalog;

describe('permission contexts', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(
      process.env.TMPDIR ?? tmpdir(),
      `smrt-request-scope-${Date.now()}-${Math.random()}.db`,
    );
  });

  afterEach(() => {
    if (existsSync(dbPath)) rmSync(dbPath, { force: true });
  });

  it('a module error from the callback runs it once', async () => {
    const db = await getDatabase({ type: 'sqlite', url: dbPath });
    await db.query('CREATE TABLE marks (n INTEGER)');
    let calls = 0;
    const moduleError = Object.assign(new Error('Cannot find module x'), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    for (const tenantId of ['tenant-a', undefined]) {
      calls = 0;
      await expect(
        withPrincipalPermissionContext(
          {
            db: { type: 'sqlite', url: dbPath },
            userId: 'user-a',
            ...(tenantId ? { tenantId } : {}),
            permissions: [],
            enterTenantContext: true,
          },
          async () => {
            calls += 1;
            await db.query('INSERT INTO marks (n) VALUES (1)');
            throw moduleError;
          },
        ),
      ).rejects.toBe(moduleError);
      expect(calls).toBe(1);
    }
    const marks = await db.query('SELECT COUNT(*) AS n FROM marks');
    expect(Number(marks.rows[0]?.n)).toBe(2);
    await db.close?.();
  });
});

describe('the operation permission gate inside a principal request', () => {
  let resolverCalls: Array<[string, string, string]>;
  /** A live role resolver that grants everything. */
  const grantsAll = () =>
    ({
      hasPermission: async (userId: string, tenantId: string, slug: string) => {
        resolverCalls.push([userId, tenantId, slug]);
        return true;
      },
    }) as unknown as PermissionResolver;
  const decide = async (
    action: string,
    extra: Partial<OperationPermissionOptions> = {},
  ) => {
    const decision = await checkOperationPermission({
      collection: 'gatewidgets',
      action,
      catalog,
      resolver: grantsAll(),
      ...extra,
    });
    return `${decision.allowed ? 'allowed' : 'denied'}:${decision.reason}`;
  };

  it('the existing permission gate is capped by the request', async () => {
    ObjectRegistry.registerCollection(
      'GateWidget',
      GateWidgetCollection as never,
    );
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['GateWidget'],
    });
    const api = new APIGenerator(
      {
        basePath: '/api',
        resolvePrincipal: () => ({
          tenantId: TENANT,
          userId: 'user-1',
          allowCrossTenant: false,
          authenticated: true,
          permissions: ['gatewidgets.read', 'gatewidgets.check'],
        }),
      },
      { db },
    ).generateHandler();
    resolverCalls = [];
    checkWork = async () => ({
      ownRead: await decide('read', { userId: 'user-1', tenantId: TENANT }),
      ownReadCalls: resolverCalls.length,
      ownDelete: await decide('delete', {
        userId: 'user-1',
        tenantId: TENANT,
      }),
      systemDelete: await withSystemContext(() =>
        decide('delete', { userId: 'user-1', tenantId: TENANT }),
      ),
      bypassDelete: await withTenant(
        { tenantId: TENANT, userId: 'user-1', superAdminBypass: true },
        () => decide('delete', { userId: 'user-1', tenantId: TENANT }),
      ),
      otherUserRead: await decide('read', {
        userId: 'user-2',
        tenantId: TENANT,
      }),
      otherUserDelete: await decide('delete', {
        userId: 'user-2',
        tenantId: TENANT,
      }),
      otherTenantDelete: await decide('delete', {
        userId: 'user-1',
        tenantId: OTHER_TENANT,
      }),
      explicitWiderDelete: await decide('delete', {
        userId: 'user-1',
        tenantId: TENANT,
        permissionSet: ['gatewidgets.read', 'gatewidgets.delete'],
      }),
      explicitWiderRead: await decide('read', {
        userId: 'user-1',
        tenantId: TENANT,
        permissionSet: ['gatewidgets.read', 'gatewidgets.delete'],
      }),
    });
    const segment = ObjectRegistry.getClass('GateWidget')?.collection;
    const response = await api(
      new Request(`http://local/api/${segment}/check`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(response.status).toBe(200);
    expect(checked).toEqual({
      ownRead: 'allowed:permission_granted',
      ownReadCalls: 0,
      ownDelete: 'denied:permission_denied',
      systemDelete: 'denied:permission_denied',
      bypassDelete: 'denied:permission_denied',
      otherUserRead: 'allowed:permission_granted',
      otherUserDelete: 'denied:permission_denied',
      otherTenantDelete: 'denied:permission_denied',
      explicitWiderDelete: 'denied:permission_denied',
      explicitWiderRead: 'allowed:permission_granted',
    });
    // The other user's read was resolved live.
    expect(resolverCalls).toContainEqual([
      'user-2',
      TENANT,
      'gatewidgets.read',
    ]);

    // Outside a request the gate is unchanged.
    expect(await decide('delete', { userId: 'user-1', tenantId: TENANT })).toBe(
      'allowed:permission_granted',
    );
    await db.close?.();
  });
});
