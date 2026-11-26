import { describe, expect, it } from 'vitest';
import type { APIRequestPrincipal } from './request-principal';
import {
  apiPrincipalFromLocals,
  authorize,
  stripTenantFilters,
} from './route-authz';

const anon: APIRequestPrincipal = {
  tenantId: null,
  allowCrossTenant: false,
  authenticated: false,
};
const user = (
  extra: Partial<APIRequestPrincipal> = {},
): APIRequestPrincipal => ({
  tenantId: 't1',
  allowCrossTenant: false,
  authenticated: true,
  permissions: ['posts.create', 'posts.update', 'posts.publish'],
  ...extra,
});
const base = { permissionCollection: 'posts', publicAccess: false as const };

describe('authorize sign-in', () => {
  it('refuses an unsigned caller on a non-public model', () => {
    for (const op of ['list', 'get', 'create']) {
      expect(authorize({ ...base, principal: anon, op })).toMatchObject({
        allow: false,
        status: 401,
      });
    }
  });
  it('public: true admits an unsigned caller to reads and writes', () => {
    for (const op of ['list', 'create', 'delete']) {
      expect(
        authorize({ ...base, publicAccess: true, principal: anon, op }).allow,
      ).toBe(true);
    }
  });
  it("public: 'read' admits reads only", () => {
    const p = { ...base, publicAccess: 'read' as const, principal: anon };
    expect(authorize({ ...p, op: 'list' }).allow).toBe(true);
    expect(authorize({ ...p, op: 'get' }).allow).toBe(true);
    expect(authorize({ ...p, op: 'create' })).toMatchObject({ status: 401 });
    expect(authorize({ ...p, op: 'publish', mutating: true })).toMatchObject({
      status: 401,
    });
    expect(authorize({ ...p, op: 'search', mutating: false }).allow).toBe(true);
  });
});

describe('authorize permission', () => {
  it('requires <collection>.<action> on writes', () => {
    expect(authorize({ ...base, principal: user(), op: 'create' }).allow).toBe(
      true,
    );
    expect(authorize({ ...base, principal: user(), op: 'delete' })).toEqual({
      allow: false,
      status: 403,
      code: 'PERMISSION_DENIED',
      message: 'Permission denied.',
    });
  });
  it('does not require a permission to read', () => {
    expect(
      authorize({ ...base, principal: user({ permissions: [] }), op: 'list' })
        .allow,
    ).toBe(true);
  });
  it('treats an absent permission list as none', () => {
    const { permissions: _p, ...rest } = user();
    expect(authorize({ ...base, principal: rest, op: 'create' })).toMatchObject(
      { status: 403 },
    );
  });
  it('uses permissionAction for a custom action alias', () => {
    const p = user({ permissions: ['posts.update'] });
    expect(
      authorize({
        ...base,
        principal: p,
        op: 'restore',
        permissionAction: 'update',
      }).allow,
    ).toBe(true);
    expect(authorize({ ...base, principal: p, op: 'restore' })).toMatchObject({
      status: 403,
    });
  });
  it('accepts a one-shot iterable of slugs', () => {
    const p = user({ permissions: new Set(['posts.create']) });
    expect(authorize({ ...base, principal: p, op: 'create' }).allow).toBe(true);
  });
  it('public: true skips the permission, public read still needs it for writes', () => {
    const p = user({ permissions: [] });
    expect(
      authorize({ ...base, publicAccess: true, principal: p, op: 'create' })
        .allow,
    ).toBe(true);
    expect(
      authorize({ ...base, publicAccess: 'read', principal: p, op: 'create' }),
    ).toMatchObject({ status: 403 });
  });
  it('super-admin bypass counts only on a model that opts in', () => {
    const p = user({ permissions: [], superAdminBypass: true });
    expect(authorize({ ...base, principal: p, op: 'create' })).toMatchObject({
      status: 403,
    });
    expect(
      authorize({
        ...base,
        principal: p,
        op: 'create',
        allowSuperAdminBypass: true,
      }).allow,
    ).toBe(true);
    // The opt-in alone, with no verified bypass, grants nothing.
    expect(
      authorize({
        ...base,
        principal: user({ permissions: [] }),
        op: 'create',
        allowSuperAdminBypass: true,
      }),
    ).toMatchObject({ status: 403 });
  });
  it('checks sign-in before permission', () => {
    expect(authorize({ ...base, principal: anon, op: 'create' })).toMatchObject(
      {
        status: 401,
      },
    );
  });
});

describe('authorize tenant', () => {
  const w = (body: unknown, extra = {}) =>
    authorize({ ...base, principal: user(), op: 'create', body, ...extra });
  it('refuses a body naming another tenant under any spelling', () => {
    for (const key of ['tenantId', 'tenant_id', 'TenantId']) {
      expect(w({ [key]: 't2' })).toMatchObject({
        allow: false,
        status: 403,
        code: 'TENANT_MISMATCH',
      });
    }
  });
  it('refuses null and admits an echo of the caller tenant', () => {
    expect(w({ tenantId: null })).toMatchObject({ code: 'TENANT_MISMATCH' });
    expect(w({ tenantId: 't1', title: 'x' }).allow).toBe(true);
  });
  it('checks the model ownership columns', () => {
    const tenantColumns = new Set(['org_id']);
    expect(w({ orgId: 'o2' }, { tenantColumns })).toMatchObject({
      code: 'TENANT_MISMATCH',
    });
    expect(w({ tenantId: 'x' }, { tenantColumns })).toMatchObject({
      code: 'TENANT_MISMATCH',
    });
    expect(w({ tenantId: 'x' }, { tenantColumns: new Set() })).toMatchObject({
      code: 'TENANT_MISMATCH',
    });
  });
  it('ignores a non-object body', () => {
    expect(w(undefined).allow).toBe(true);
    expect(w([{ tenantId: 'x' }]).allow).toBe(true);
  });
  it('permission is decided before tenant', () => {
    expect(
      authorize({
        ...base,
        principal: user({ permissions: [] }),
        op: 'create',
        body: { tenantId: 't2' },
      }),
    ).toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});

describe('stripTenantFilters', () => {
  const cols = new Set(['tenant_id']);
  const where = { tenantId: 't2', 'tenant_id !=': 't1', status: 'live' };
  it('removes tenant filters from a tenant-bound caller', () => {
    expect(stripTenantFilters(user(), cols, where)).toEqual({ status: 'live' });
  });
  it('leaves an explicitly cross-tenant caller alone', () => {
    expect(
      stripTenantFilters(user({ allowCrossTenant: true }), cols, where),
    ).toBe(where);
  });
  it('passes undefined through', () => {
    expect(stripTenantFilters(user(), cols, undefined)).toBeUndefined();
  });
});

describe('apiPrincipalFromLocals', () => {
  it('is anonymous for empty locals and ignores a callable auth', () => {
    expect(apiPrincipalFromLocals({ auth: () => ({}) })).toMatchObject({
      authenticated: false,
      tenantId: null,
      superAdminBypass: false,
    });
    expect(apiPrincipalFromLocals(undefined).authenticated).toBe(false);
  });
  it('is signed in by user, session or smrtAuth', () => {
    expect(apiPrincipalFromLocals({ user: { id: 'u1' } })).toMatchObject({
      authenticated: true,
      userId: 'u1',
    });
    expect(apiPrincipalFromLocals({ session: {} }).authenticated).toBe(true);
    expect(apiPrincipalFromLocals({ smrtAuth: true }).authenticated).toBe(true);
    expect(apiPrincipalFromLocals({ user: true }).authenticated).toBe(false);
  });
  it('reads the tenant in key order, then the active context', () => {
    expect(
      apiPrincipalFromLocals({ tenantId: 'a', user: { tenantId: 'b' } })
        .tenantId,
    ).toBe('a');
    expect(
      apiPrincipalFromLocals({ session: { tenantId: 's' } }).tenantId,
    ).toBe('s');
    expect(
      apiPrincipalFromLocals({ tenantContext: { tenantId: 'c' } }).tenantId,
    ).toBe('c');
    expect(apiPrincipalFromLocals({}, 'active').tenantId).toBe('active');
    expect(apiPrincipalFromLocals({ tenantId: 'a' }, 'active').tenantId).toBe(
      'a',
    );
  });
  it('takes the first defined permission source', () => {
    const grants = (locals: Record<string, unknown>) => [
      ...(apiPrincipalFromLocals(locals).permissions ?? []),
    ];
    const ctx = { permissions: ['t.all'] };
    expect(
      grants({
        permissions: [],
        permissionSet: ['x.create'],
        tenantContext: ctx,
      }),
    ).toEqual([]);
    expect(grants({ permissions: new Set(), tenantContext: ctx })).toEqual([]);
    expect(grants({ permissionSet: ['x.create'], tenantContext: ctx })).toEqual(
      ['x.create'],
    );
    expect(
      grants({ smrtPermissions: new Set(['y.update']), tenantContext: ctx }),
    ).toEqual(['y.update']);
    expect(grants({ tenantContext: ctx })).toEqual(['t.all']);
    expect(grants({ permissions: null, permissionSet: ['n.get'] })).toEqual([
      'n.get',
    ]);
    expect(grants({ permissions: ['a.b', 5, null, 'c.d'] })).toEqual([
      'a.b',
      'c.d',
    ]);
  });
  it('takes the bypass only from tenantContext.superAdminBypass === true', () => {
    expect(
      apiPrincipalFromLocals({ tenantContext: { superAdminBypass: true } })
        .superAdminBypass,
    ).toBe(true);
    expect(
      apiPrincipalFromLocals({ superAdminBypass: true }).superAdminBypass,
    ).toBe(false);
  });
  it('feeds authorize end to end', () => {
    const principal = apiPrincipalFromLocals({
      user: { id: 'u' },
      tenantId: 't1',
      permissions: ['posts.create'],
    });
    expect(authorize({ ...base, principal, op: 'create' }).allow).toBe(true);
    expect(authorize({ ...base, principal, op: 'delete' })).toMatchObject({
      status: 403,
    });
  });
});
