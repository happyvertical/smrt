import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectRegistry, SmrtObject, smrt } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  getCurrentTenant,
  withSystemContext,
} from '@happyvertical/smrt-tenancy';
import { afterEach, describe, expect, it } from 'vitest';
import { GroupCollection } from '../collections/GroupCollection.js';
import { GroupMemberCollection } from '../collections/GroupMemberCollection.js';
import { GroupRoleCollection } from '../collections/GroupRoleCollection.js';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { MembershipOverrideCollection } from '../collections/MembershipOverrideCollection.js';
import { PermissionCollection } from '../collections/PermissionCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { RolePermissionCollection } from '../collections/RolePermissionCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { TenantPermissionOverrideCollection } from '../collections/TenantPermissionOverrideCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import { getRequestScopedDatabase } from '../services/SessionPermissionContext.js';
import { SessionService } from '../services/SessionService.js';
import { createSessionHandler } from '../sveltekit/index.js';

@smrt({
  api: false,
  cli: false,
  collection: 'request_scoped_documents',
  mcp: false,
  tenantScoped: { mode: 'required' },
})
class RequestScopedDocument extends SmrtObject {
  tenantId: string = '';
  title: string = '';
}

function createCookieJar(initialValues: Record<string, string> = {}) {
  const values = new Map(Object.entries(initialValues));

  return {
    delete(name: string) {
      values.delete(name);
    },
    get(name: string) {
      return values.get(name);
    },
    set(name: string, value: string) {
      values.set(name, value);
    },
  };
}

describe('createSessionHandler integration', () => {
  let dbPath = '';

  afterEach(() => {
    disableTenancy();
    if (dbPath && existsSync(dbPath)) {
      rmSync(dbPath, { force: true });
    }
    dbPath = '';
  });

  it('loads a real session, enters tenant context, and scopes collection access inside resolve', async () => {
    dbPath = join(
      tmpdir(),
      `smrt-session-handler-integration-${randomUUID()}.db`,
    );
    const options = {
      db: {
        type: 'sqlite' as const,
        url: dbPath,
      },
    };
    enableTenancy();

    const users = await UserCollection.create(options);
    const tenants = await TenantCollection.create(options);
    const roles = await RoleCollection.create(options);
    const permissions = await PermissionCollection.create(options);
    const rolePermissions = await RolePermissionCollection.create(options);
    const memberships = await MembershipCollection.create(options);
    await GroupCollection.create(options);
    await GroupMemberCollection.create(options);
    await GroupRoleCollection.create(options);
    await MembershipOverrideCollection.create(options);
    await TenantPermissionOverrideCollection.create(options);
    const sessionService = await SessionService.create(options);
    const documents = await ObjectRegistry.getCollection<RequestScopedDocument>(
      'RequestScopedDocument',
      options,
    );

    const user = await users.create({
      email: 'handler.integration@example.com',
    });
    await user.save();

    const tenant = await tenants.create({ name: 'Tenant A' });
    await tenant.save();

    const otherTenant = await tenants.create({ name: 'Tenant B' });
    await otherTenant.save();

    const role = await roles.create({ name: 'Reader' });
    await role.save();

    const permission = await permissions.create({
      name: 'Read Request Scoped Documents',
      slug: 'request_scoped_documents.read',
    });
    await permission.save();

    await rolePermissions.addPermission(role.id!, permission.id!);

    const membership = await memberships.create({
      roleId: role.id,
      tenantId: tenant.id,
      userId: user.id,
    });
    await membership.save();

    await withSystemContext(async () => {
      const tenantDocument = await documents.create({
        tenantId: tenant.id!,
        title: 'Tenant A Document',
      });
      await tenantDocument.save();

      const otherTenantDocument = await documents.create({
        tenantId: otherTenant.id!,
        title: 'Tenant B Document',
      });
      await otherTenantDocument.save();
    });

    const sessionId = await sessionService.createSession(user.id!, tenant.id!);
    const cookies = createCookieJar({ sid: sessionId });
    const handler = createSessionHandler({
      ...options,
      enterTenantContext: true,
    });

    const event = {
      cookies,
      locals: {} as Record<string, unknown>,
      request: { headers: new Headers() },
      url: { pathname: '/dashboard' },
    };

    const response = await handler({
      event,
      resolve: async (requestEvent) => {
        expect(requestEvent.locals.user).toMatchObject({
          email: 'handler.integration@example.com',
          id: user.id,
        });
        expect(requestEvent.locals.permissions).toEqual(
          expect.arrayContaining(['request_scoped_documents.read']),
        );
        expect(requestEvent.locals.sessionId).toBe(sessionId);
        expect(requestEvent.locals.tenantId).toBe(tenant.id);

        const tenantContext = getCurrentTenant();
        expect(tenantContext?.tenantId).toBe(tenant.id);
        expect(tenantContext?.userId).toBe(user.id);
        expect(Array.from(tenantContext?.permissions ?? [])).toContain(
          'request_scoped_documents.read',
        );
        expect(getRequestScopedDatabase()).toBeDefined();

        const visibleDocuments = await documents.list({
          orderBy: 'title',
        });
        expect(visibleDocuments.map((document) => document.title)).toEqual([
          'Tenant A Document',
        ]);

        return new Response('ok');
      },
    });

    expect(response.status).toBe(200);
    expect(event.locals.user).toMatchObject({
      email: 'handler.integration@example.com',
      id: user.id,
    });
    expect(event.locals.permissions).toEqual(
      expect.arrayContaining(['request_scoped_documents.read']),
    );
    expect(event.locals.sessionId).toBe(sessionId);
    expect(event.locals.tenantId).toBe(tenant.id);
  });
});
