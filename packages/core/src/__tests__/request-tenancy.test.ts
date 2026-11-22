/**
 * The request tenancy resolver (#5375): rows 6 and 31 of the test-design
 * contract, and the failure-preserving policy source.
 *
 * Core cannot import smrt-tenancy, so these tests install a policy source of
 * their own, the way `enableTenancy()` installs smrt-tenancy's.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { field } from '../decorators/index.js';
import { setDispatchTenantResolver } from '../dispatch/tenant-resolver.js';
import { APIGenerator } from '../generators/rest.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import {
  RequestTenantConflictError,
  resolveRequestActor,
} from '../request-actor.js';
import {
  etagDiscriminator,
  RequestTenancyError,
  readScope,
  resolveRequestTenancy,
  setTenantPolicySource,
  type TenantPolicyLookup,
  writeGate,
} from '../request-tenancy.js';
import { getTestDatabase } from '../testing/database.js';

@smrt({ api: { include: ['list'], public: 'read' } })
class ResolverLedger extends SmrtObject {
  @field({ type: 'text' }) title = '';
  @field({ type: 'text', nullable: true }) tenantId: string | null = null;
}
class ResolverLedgerCollection extends SmrtCollection<ResolverLedger> {
  static readonly _itemClass = ResolverLedger;
}

/** Same-named models of two packages. */
function defineTwin(packageName: string) {
  @smrt({
    packageName,
    tableName: `resolver_twins_${packageName.split('/')[1]}`,
  } as never)
  class ResolverTwin extends SmrtObject {
    @field({ type: 'text' }) title = '';
  }
  return ResolverTwin;
}
const TwinLeft = defineTwin('@resolver-fixture/left');
const TwinRight = defineTwin('@resolver-fixture/right');

// Declares its tenancy: a resolved policy may be stricter, never looser.
@smrt({
  tenantScoped: { mode: 'optional', field: 'tenantId' },
} as never)
class ResolverDeclared extends SmrtObject {
  @field({ type: 'text' }) title = '';
  @field({ type: 'text', nullable: true }) tenantId: string | null = null;
  @field({ type: 'text', nullable: true }) organizationId: string | null = null;
}

const keyOf = (ctor: Function) => {
  const info = ObjectRegistry.getClassByConstructor(ctor as never);
  if (!info) throw new Error('fixture not registered');
  return info.qualifiedName || info.name;
};

/** A policy source for the test: `policies` decides each class. */
const policies = new Map<string, TenantPolicyLookup>();
function installTenancy() {
  setDispatchTenantResolver(() => undefined);
  setTenantPolicySource({
    policyOf: (key) => policies.get(key) ?? { kind: 'absent' },
    systemContextActive: () => false,
    superAdminBypassActive: () => false,
    hierarchyReadCollections: () => undefined,
    runInContext: (_context, fn) => fn(),
  });
}
function removeTenancy() {
  setDispatchTenantResolver(undefined);
  setTenantPolicySource(undefined);
}

const anonymous = () =>
  resolveRequestActor({
    principal: { authenticated: false },
    operation: 'read',
  });

describe('request tenancy resolution', () => {
  let db: DatabaseInterface;

  beforeAll(async () => {
    ObjectRegistry.registerCollection(
      'ResolverLedger',
      ResolverLedgerCollection as never,
    );
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: [keyOf(ResolverLedger), keyOf(ResolverDeclared)],
    });
    const ledgers = await ResolverLedgerCollection.create({ db });
    await ledgers.create({ title: 'ours', tenantId: 'tenant-a' } as never);
    await ledgers.create({ title: 'everyone' } as never);
  });

  afterEach(() => {
    policies.clear();
    removeTenancy();
  });

  afterAll(async () => {
    await db?.close?.();
  });

  it('hooks installed after route import are read per request', async () => {
    // The handler exists before any tenancy is installed.
    const handler = new APIGenerator(
      { basePath: '/api' },
      { db },
    ).generateHandler();
    const list = async () => {
      const response = await handler(
        new Request(
          `http://local/api/${ObjectRegistry.getClass(keyOf(ResolverLedger))?.collection}`,
        ),
      );
      return ((await response.json()) as Array<{ title: string }>)
        .map((row) => row.title)
        .sort();
    };
    expect(await list()).toEqual(['everyone', 'ours']);

    installTenancy();
    policies.set(keyOf(ResolverLedger), {
      kind: 'resolved',
      policy: {
        mode: 'optional',
        field: 'tenantId',
        allowSuperAdminBypass: false,
      },
    });
    expect(await list()).toEqual(['everyone']);

    policies.clear();
    expect(await list()).toEqual(['everyone', 'ours']);
  });

  it('an ambiguous simple-name registration refuses; an unambiguous one resolves', () => {
    installTenancy();
    const ambiguous = resolveRequestTenancy({
      model: 'ResolverTwin',
      actor: anonymous(),
    });
    expect(ambiguous.failed).toBeTruthy();
    expect(readScope(ambiguous)).toMatchObject({ kind: 'refuse', status: 403 });
    expect(writeGate(ambiguous)).toMatchObject({ kind: 'refuse', status: 403 });

    for (const twin of [TwinLeft, TwinRight]) {
      const exact = resolveRequestTenancy({
        model: keyOf(twin),
        actor: anonymous(),
      });
      expect(exact.failed).toBeUndefined();
      expect(exact.model).toBe(keyOf(twin));
      expect(readScope(exact)).toEqual({ kind: 'open' });
    }
    const unique = resolveRequestTenancy({
      model: 'ResolverLedger',
      actor: anonymous(),
    });
    expect(unique.model).toBe(keyOf(ResolverLedger));
  });

  it('a failing policy lookup refuses instead of reading as unscoped', () => {
    installTenancy();
    policies.set(keyOf(ResolverLedger), {
      kind: 'failed',
      reason: 'ambiguous selector',
    });
    const t = resolveRequestTenancy({
      model: keyOf(ResolverLedger),
      actor: anonymous(),
    });
    expect(readScope(t)).toMatchObject({ kind: 'refuse', status: 403 });

    // Enabled tenancy without a policy source refuses too.
    setTenantPolicySource(undefined);
    const unsourced = resolveRequestTenancy({
      model: keyOf(ResolverLedger),
      actor: anonymous(),
    });
    expect(readScope(unsourced)).toMatchObject({ kind: 'refuse' });
  });

  it('a policy lookup that fails without a reason, or answers no usable policy, refuses', () => {
    installTenancy();
    const key = keyOf(ResolverLedger);
    const refused = () => {
      const t = resolveRequestTenancy({ model: key, actor: anonymous() });
      expect(t.route.state).toBe('failed');
      expect(t.failed).toBeTruthy();
      expect(readScope(t)).toMatchObject({ kind: 'refuse', status: 403 });
      expect(writeGate(t)).toMatchObject({ kind: 'refuse', status: 403 });
    };
    policies.set(key, { kind: 'failed', reason: '' });
    refused();
    policies.set(key, {
      kind: 'resolved',
      policy: { mode: 'optional', field: '', allowSuperAdminBypass: false },
    });
    refused();
    policies.set(key, { kind: 'unknown' } as never);
    refused();
    // A provider that throws an error with no message.
    setTenantPolicySource({
      policyOf: () => {
        throw new Error('');
      },
      systemContextActive: () => false,
      superAdminBypassActive: () => false,
      hierarchyReadCollections: () => undefined,
      runInContext: (_context, fn) => fn(),
    });
    refused();
  });

  it('a resolved policy looser than or off the declared tenancy refuses; a stricter one resolves', () => {
    installTenancy();
    const key = keyOf(ResolverDeclared);
    const resolve = (policy: Record<string, unknown>) => {
      policies.set(key, {
        kind: 'resolved',
        policy: {
          mode: 'optional',
          field: 'tenantId',
          allowSuperAdminBypass: false,
          ...policy,
        } as never,
      });
      return resolveRequestTenancy({ model: key, actor: anonymous() });
    };
    for (const conflicting of [
      { field: 'organizationId' },
      { allowSuperAdminBypass: true },
    ]) {
      const t = resolve(conflicting);
      expect(t.route.state).toBe('failed');
      expect(readScope(t)).toMatchObject({ kind: 'refuse', status: 403 });
    }
    expect(resolve({}).route.state).toBe('scoped');
    const stricter = resolve({ mode: 'required' });
    expect(stricter.route).toMatchObject({ state: 'scoped', mode: 'required' });
  });

  it('the resolved tenancy of a request cannot be changed after resolution', () => {
    installTenancy();
    policies.set(keyOf(ResolverLedger), {
      kind: 'resolved',
      policy: {
        mode: 'optional',
        field: 'tenantId',
        allowSuperAdminBypass: false,
      },
    });
    const t = resolveRequestTenancy({
      model: keyOf(ResolverLedger),
      actor: anonymous(),
    });
    const members = t.members as Map<string, unknown>;
    expect(() => members.set('Other', t.route)).toThrow(TypeError);
    expect(() => members.delete(keyOf(ResolverLedger))).toThrow(TypeError);
    expect(() => members.clear()).toThrow(TypeError);
    expect(members.size).toBe(1);
    expect(Object.isFrozen(t.route)).toBe(true);
    expect(Object.isFrozen(t.actor)).toBe(true);
    expect(t.route.autoPopulate).toBe(true);
  });

  it('the validator discriminator changes with the bounded hierarchy read scope', () => {
    let hierarchy: string | undefined;
    setDispatchTenantResolver(() => undefined);
    setTenantPolicySource({
      policyOf: (key) => policies.get(key) ?? { kind: 'absent' },
      systemContextActive: () => false,
      superAdminBypassActive: () => false,
      hierarchyReadCollections: () => undefined,
      hierarchyReadScopeKey: () => hierarchy,
      runInContext: (_context, fn) => fn(),
    });
    policies.set(keyOf(ResolverLedger), {
      kind: 'resolved',
      policy: {
        mode: 'optional',
        field: 'tenantId',
        allowSuperAdminBypass: false,
      },
    });
    const discriminator = () =>
      etagDiscriminator(
        resolveRequestTenancy({
          model: keyOf(ResolverLedger),
          actor: anonymous(),
        }),
      );
    const none = discriminator();
    hierarchy = JSON.stringify([['ledger'], ['tenant-a'], false]);
    const narrow = discriminator();
    hierarchy = JSON.stringify([['ledger'], ['tenant-a', 'tenant-b'], true]);
    const wide = discriminator();
    expect(new Set([none, narrow, wide]).size).toBe(3);
    hierarchy = JSON.stringify([['ledger'], ['tenant-a'], false]);
    expect(discriminator()).toBe(narrow);
  });

  it('a route that requires a complete principal refuses one without a tenant, user or permissions', () => {
    installTenancy();
    const actorOf = (locals: unknown) =>
      resolveRequestActor({
        locals,
        operation: 'read',
        requirePrincipal: true,
      });
    const complete = {
      tenantId: 'tenant-a',
      user: { id: 'user-a' },
      permissions: ['ledger:read'],
    };
    for (const partial of [
      { ...complete, tenantId: undefined },
      { ...complete, user: undefined },
      { ...complete, permissions: undefined },
      { ...complete, permissions: ['ledger:read', 7] },
    ]) {
      let refusal: unknown;
      try {
        actorOf(partial);
      } catch (cause) {
        refusal = cause;
      }
      expect(refusal).toBeInstanceOf(RequestTenancyError);
      expect(refusal).toMatchObject({ status: 403 });
    }

    const actor = actorOf(complete);
    expect(actor).toMatchObject({
      tenantId: 'tenant-a',
      userId: 'user-a',
      system: null,
    });
    expect([...(actor.permissions ?? [])]).toEqual(['ledger:read']);

    // An active tenant context of another tenant is refused.
    setDispatchTenantResolver(() => 'tenant-b');
    expect(() => actorOf(complete)).toThrow(RequestTenantConflictError);
  });
});
