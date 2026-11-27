import { describe, expect, it } from 'vitest';
import { normalizeRequestPrincipal } from '../generators/request-principal';
import {
  createGuestRequestPrincipal,
  GUEST_MAX_LIST_LIMIT,
  guestOperationKind,
  guestPrincipalOf,
  isGuestLocals,
  isGuestOperationAllowed,
} from '../guest-request';
import { SmrtObject } from '../object';
import { smrt } from '../registry';

@smrt({
  packageName: '@test/guest-request',
  collection: 'gr5196_items',
  tenantScoped: true,
  operationPermissions: { exportAll: { action: 'read' } },
})
class GrItem5196 extends SmrtObject {
  async exportAll() {
    return [];
  }
}

const MODEL = '@test/guest-request:GrItem5196';

function guestLocals(extra: Record<string, unknown> = {}) {
  return {
    tenantId: 'tenant-a',
    permissions: ['gr5196_items.read'],
    guestPrincipal: createGuestRequestPrincipal({
      tenantId: 'tenant-a',
      permissions: ['gr5196_items.read'],
    }),
    ...extra,
  };
}

describe('guest operations (#5196)', () => {
  void GrItem5196;

  it('only the generated CRUD operations map to a guest kind', () => {
    expect(guestOperationKind(MODEL, 'list')).toBe('read');
    expect(guestOperationKind(MODEL, 'get')).toBe('read');
    expect(guestOperationKind(MODEL, 'create')).toBe('create');
    for (const operation of ['update', 'delete', 'count', 'custom', 'sync']) {
      expect(guestOperationKind(MODEL, operation)).toBeNull();
    }
  });

  it('a custom method aliased onto read never passes', () => {
    expect(guestOperationKind(MODEL, 'exportAll')).toBeNull();
    const held = new Set(['gr5196_items.read']);
    expect(isGuestOperationAllowed(held, MODEL, 'gr5196_items', 'list')).toBe(
      true,
    );
    expect(
      isGuestOperationAllowed(held, MODEL, 'gr5196_items', 'exportAll'),
    ).toBe(false);
    expect(isGuestOperationAllowed(held, MODEL, 'gr5196_items', 'create')).toBe(
      false,
    );
    expect(isGuestOperationAllowed(held, MODEL, 'gr5196_others', 'list')).toBe(
      false,
    );
  });

  it('an unknown model fails closed on the alias lookup, not open', () => {
    const held = new Set(['x.read']);
    expect(
      isGuestOperationAllowed(held, 'Nope:Missing', 'x', 'exportAll'),
    ).toBe(false);
  });
});

describe('guestPrincipalOf (#5196)', () => {
  it('admits a well-formed guest principal bound to locals.tenantId', () => {
    const guest = guestPrincipalOf(guestLocals());
    expect(guest).toMatchObject({
      callerKind: 'guest',
      userId: null,
      tenantId: 'tenant-a',
    });
    expect(guest?.permissions.has('gr5196_items.read')).toBe(true);
    expect(isGuestLocals(guestLocals())).toBe(true);
    expect(GUEST_MAX_LIST_LIMIT).toBe(100);
  });

  it('is frozen: its permission set cannot be widened', () => {
    const guest = createGuestRequestPrincipal({
      tenantId: 't',
      permissions: ['a.read'],
    });
    expect(Object.isFrozen(guest)).toBe(true);
    expect(() => (guest.permissions as Set<string>).add('a.delete')).toThrow();
  });

  it.each([
    ['a user', { user: { id: 'u1' } }],
    ['a session', { session: { id: 's1' } }],
    ['the smrtAuth marker', { smrtAuth: true }],
    ['a different locals tenant', { tenantId: 'tenant-b' }],
    ['no locals tenant', { tenantId: undefined }],
  ])('is not a guest alongside %s', (_name, extra) => {
    expect(guestPrincipalOf(guestLocals(extra))).toBeNull();
  });

  it.each([
    ['not an object', 'guest'],
    ['null', null],
    ['an array', []],
    [
      'a non-guest kind',
      {
        callerKind: 'user',
        userId: null,
        tenantId: 'tenant-a',
        permissions: new Set(),
      },
    ],
    [
      'a user id',
      {
        callerKind: 'guest',
        userId: 'u1',
        tenantId: 'tenant-a',
        permissions: new Set(),
      },
    ],
    [
      'no tenant',
      {
        callerKind: 'guest',
        userId: null,
        tenantId: '',
        permissions: new Set(),
      },
    ],
    [
      'no permission set',
      { callerKind: 'guest', userId: null, tenantId: 'tenant-a' },
    ],
    [
      'a string permission set',
      {
        callerKind: 'guest',
        userId: null,
        tenantId: 'tenant-a',
        permissions: 'x.read',
      },
    ],
  ])('refuses a malformed marker: %s', (_name, marker) => {
    expect(
      guestPrincipalOf({ tenantId: 'tenant-a', guestPrincipal: marker }),
    ).toBeNull();
    expect(guestPrincipalOf(null)).toBeNull();
  });

  it('refuses to build a guest without a tenant', () => {
    expect(() =>
      createGuestRequestPrincipal({ tenantId: '', permissions: [] }),
    ).toThrow();
  });
});

describe('normalizeRequestPrincipal with callerKind guest (#5196)', () => {
  const guest = {
    tenantId: 'tenant-a',
    userId: null,
    authenticated: false,
    callerKind: 'guest',
    permissions: ['gr5196_items.read'],
  };

  it('accepts a consistent guest: a tenant, no user, no sign-in', () => {
    const principal = normalizeRequestPrincipal(guest);
    expect(principal).toMatchObject({
      callerKind: 'guest',
      userId: null,
      authenticated: false,
      tenantId: 'tenant-a',
      allowCrossTenant: false,
      superAdminBypass: false,
    });
  });

  it.each([
    ['a user', { userId: 'u1' }],
    ['a sign-in', { authenticated: true }],
    ['a cross-tenant grant', { allowCrossTenant: true }],
    ['a super-admin bypass', { superAdminBypass: true }],
    ['no tenant', { tenantId: null }],
  ])('rejects a guest that carries %s', (_name, override) => {
    expect(() => normalizeRequestPrincipal({ ...guest, ...override })).toThrow(
      TypeError,
    );
  });
});
