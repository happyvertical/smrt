import { describe, expect, it } from 'vitest';
import { apiPrincipalFromLocals, authorize } from '../generators/route-authz';
import { createGuestRequestPrincipal } from '../guest-request';

const guestLocals = (permissions: string[]) => ({
  tenantId: 'tenant-a',
  permissions,
  guestPrincipal: createGuestRequestPrincipal({
    tenantId: 'tenant-a',
    permissions,
  }),
});

describe('a guest is the shared principal contract (#5196, #5195)', () => {
  it('apiPrincipalFromLocals gives a guest callerKind guest, unauthenticated', () => {
    const principal = apiPrincipalFromLocals(guestLocals(['widgets.read']));
    expect(principal.callerKind).toBe('guest');
    expect(principal.authenticated).toBe(false);
    expect(principal.userId).toBeUndefined();
    expect(principal.tenantId).toBe('tenant-a');
    expect(apiPrincipalFromLocals({ tenantId: 'tenant-a' }).callerKind).toBe(
      undefined,
    );
  });

  const base = {
    op: 'list',
    permissionCollection: 'widgets',
    publicAccess: false as const,
  };

  it('guestReadAllowed stands in for sign-in on a guest read only', () => {
    const principal = apiPrincipalFromLocals(guestLocals(['widgets.read']));
    expect(
      authorize({ ...base, principal, guestReadAllowed: true }).allow,
    ).toBe(true);
    expect(authorize({ ...base, principal }).allow).toBe(false);
    // Never for a write, even with the flag.
    const write = authorize({
      ...base,
      op: 'create',
      principal,
      guestReadAllowed: true,
    });
    expect(write.allow).toBe(false);
    // Never for a caller that is not a guest.
    const anon = apiPrincipalFromLocals({ tenantId: 'tenant-a' });
    expect(
      authorize({ ...base, principal: anon, guestReadAllowed: true }).allow,
    ).toBe(false);
  });

  it('a public route stays public for a guest', () => {
    const principal = apiPrincipalFromLocals(guestLocals([]));
    expect(authorize({ ...base, principal, publicAccess: 'read' }).allow).toBe(
      true,
    );
  });

  it('guestCreateAllowed stands in for sign-in on the generated create only, and the grant still counts', () => {
    const guest = apiPrincipalFromLocals(guestLocals(['widgets.create']));
    const create = { ...base, op: 'create', guestCreateAllowed: true };
    expect(authorize({ ...create, principal: guest }).allow).toBe(true);
    // Without the flag a guest create is an unauthenticated write.
    expect(
      authorize({ ...base, op: 'create', principal: guest }),
    ).toMatchObject({
      allow: false,
      status: 401,
    });
    // The flag never stands in for the permission itself.
    const noGrant = apiPrincipalFromLocals(guestLocals(['widgets.read']));
    expect(authorize({ ...create, principal: noGrant })).toMatchObject({
      allow: false,
      status: 403,
    });
    // Never for update, delete, sync or a custom action.
    for (const op of ['update', 'delete', 'sync', 'archive']) {
      const decision = authorize({
        ...base,
        op,
        principal: guest,
        guestCreateAllowed: true,
        mutating: true,
      });
      expect(decision).toMatchObject({ allow: false, status: 401 });
    }
    // Never for a caller that is not a guest.
    const anon = apiPrincipalFromLocals({ tenantId: 'tenant-a' });
    expect(authorize({ ...create, principal: anon })).toMatchObject({
      allow: false,
      status: 401,
    });
  });
});
