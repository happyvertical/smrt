/**
 * A custom GET action on a model the runtime REST transport finds by registry
 * auto-discovery (no collection registered with the generator) receives the
 * request's tenant scope, resolved for the qualified model the route found.
 *
 * Tenancy here is reported for the qualified class name only, as a runtime
 * registration under a scoped identity is: a lookup by the simple name does not
 * see it, so the route must hand the qualified name on.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  installTestTenancySource,
  removeTestTenancySource,
  setTestRuntimeTenancy,
} from '../__tests__/fixtures/test-tenancy-source';
import { SmrtCollection } from '../collection';
import { field } from '../decorators';
import { setDispatchTenantResolver } from '../dispatch';
import { SmrtObject } from '../object';
import { ObjectRegistry } from '../registry';
import { getTestDatabase } from '../testing/database';
import { APIGenerator } from './rest';

class DiscoveredScopeDoc extends SmrtObject {
  @field({ type: 'text' })
  name = '';

  @field({ type: 'text', nullable: true })
  tenantId: string | null = null;

  /** Echoes the options it is given, as a read action forwarding them would. */
  static peek(options?: Record<string, unknown>) {
    return { received: options ?? null };
  }
}
// Registered under a package, so its identity is the qualified name only.
ObjectRegistry.register(DiscoveredScopeDoc, {
  packageName: '@fixture/discovered-scope',
  api: {
    public: 'read',
    include: ['peek'],
    routes: { peek: { method: 'GET', path: 'peek' } },
  },
});
class DiscoveredScopeDocCollection extends SmrtCollection<DiscoveredScopeDoc> {
  static readonly _itemClass = DiscoveredScopeDoc;
}

describe('auto-discovered REST read actions receive the tenant scope', () => {
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  let handler: (req: Request) => Promise<Response>;
  let qualified: string;

  beforeAll(async () => {
    installTestTenancySource();
    ObjectRegistry.registerCollection(
      'DiscoveredScopeDoc',
      DiscoveredScopeDocCollection,
    );
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['DiscoveredScopeDoc'],
    });
    const info = ObjectRegistry.getClass('DiscoveredScopeDoc');
    qualified = info?.qualifiedName ?? 'DiscoveredScopeDoc';
    expect(qualified).toBe('@fixture/discovered-scope:DiscoveredScopeDoc');
    // The scanned manifest says `peek` takes an options bag, which a caller
    // with a tenant receives scoped to that tenant.
    ObjectRegistry.getMethods(qualified).set('peek', {
      name: 'peek',
      parameters: [{ name: 'options', type: 'any', optional: true }],
      returnType: 'any',
      isPublic: true,
      isStatic: true,
    } as never);
    // No `registerCollection` on the generator: the route is auto-discovered.
    handler = new APIGenerator(
      { basePath: '/api/v1' },
      { db },
    ).generateHandler();
  });

  afterAll(async () => {
    removeTestTenancySource();
    await db?.close?.();
  });

  afterEach(() => {
    setDispatchTenantResolver(undefined);
    setTestRuntimeTenancy(undefined);
  });

  const peek = async (query: string) => {
    const res = await handler(
      new Request(`http://local/api/v1/discoveredscopedocs/peek${query}`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { received: Record<string, unknown> | null };
    };
    return body.result;
  };

  it('is registered under a qualified name the simple name does not scope', () => {
    expect(qualified).not.toBe('DiscoveredScopeDoc');
    setTestRuntimeTenancy((name) => name === qualified);
    expect(ObjectRegistry.isTenantScoped('DiscoveredScopeDoc')).toBe(false);
  });

  it('refuses a caller with no tenant whatever tenant it sends', async () => {
    // Runtime REST refuses a caller with no tenant every custom collection
    // action of a tenant-scoped model, GET actions included (#5164).
    setDispatchTenantResolver(() => undefined);
    setTestRuntimeTenancy((name) => name === qualified);
    const res = await handler(
      new Request(
        'http://local/api/v1/discoveredscopedocs/peek?tenantId=tenant-a&tenant_id=tenant-b',
      ),
    );
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('received');
  });

  it('sets the active tenant over a caller-sent one', async () => {
    setDispatchTenantResolver(() => 'tenant-a');
    setTestRuntimeTenancy((name) => name === qualified);
    const { received } = await peek('?tenantId=tenant-b');
    expect(received).toEqual({ tenantId: 'tenant-a' });
  });

  it('leaves options as sent when the model is not tenant-scoped', async () => {
    setDispatchTenantResolver(() => undefined);
    const { received } = await peek('?tenantId=tenant-a');
    expect(received).toEqual({ tenantId: 'tenant-a' });
  });
});
