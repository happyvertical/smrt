/**
 * executeAsPrincipal — logic tests on real in-memory SQLite.
 *
 * These prove the door-agnostic pieces that do not need Postgres: the principal
 * context is published, the persona tool ceiling is enforced, the RLS-off
 * catalog seam denies un-permitted operations, and actions audit as
 * on-behalf-of the originating user. Postgres RLS enforcement of the same
 * permission set is proven by
 * `@happyvertical/smrt-users`'s `principal-permission-context-postgres.test.ts`.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@happyvertical/logger';
import {
  MembershipCollection,
  OperationPermissionError,
  PermissionCollection,
  RoleCollection,
  RolePermissionCollection,
  registerPermissionDefinitions,
  TenantCollection,
  UserCollection,
} from '@happyvertical/smrt-users';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  executeAsPrincipal,
  type PrincipalAuditEntry,
  PrincipalToolNotAllowedError,
} from './execute-as-principal.js';

describe('executeAsPrincipal', () => {
  let dbPath: string;
  let db: { type: 'sqlite'; url: string };
  let unregister: (() => void) | undefined;
  let userId: string;
  let tenantId: string;
  let roleId: string;
  let rolePermissions: RolePermissionCollection;
  let permissions: PermissionCollection;

  beforeEach(async () => {
    dbPath = join(
      tmpdir(),
      `smrt-exec-principal-${Date.now()}-${Math.random()}.db`,
    );
    db = { type: 'sqlite', url: dbPath };
    const options = { db };

    // Catalog slugs the tool/exec seam asserts against.
    unregister = registerPermissionDefinitions([
      { slug: 'widgets.read' },
      { slug: 'widgets.create' },
    ]);

    const users = await UserCollection.create(options);
    const tenants = await TenantCollection.create(options);
    const roles = await RoleCollection.create(options);
    permissions = await PermissionCollection.create(options);
    rolePermissions = await RolePermissionCollection.create(options);
    const memberships = await MembershipCollection.create(options);

    const user = await users.create({ email: 'principal@example.com' });
    await user.save();
    const tenant = await tenants.create({ name: 'Principal Org' });
    await tenant.save();
    const role = await roles.create({ name: 'Widget Reader' });
    await role.save();
    await (
      await memberships.create({
        userId: user.id,
        tenantId: tenant.id,
        roleId: role.id,
      })
    ).save();

    userId = user.id as string;
    tenantId = tenant.id as string;
    roleId = role.id as string;

    await grant('widgets.read');
  });

  afterEach(() => {
    unregister?.();
    unregister = undefined;
    vi.restoreAllMocks();
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  async function grant(slug: string): Promise<void> {
    const permission = await permissions.create({ slug, name: slug });
    await permission.save();
    await rolePermissions.addPermission(roleId, permission.id as string);
  }

  it('runs the body inside a context built from the bound principal', async () => {
    const seen = await executeAsPrincipal(
      {
        db,
        principal: { runAsUserId: userId, tenantId },
        audit: () => {},
      },
      async (run) => {
        expect(run.context.userId).toBe(userId);
        expect(run.context.tenantId).toBe(tenantId);
        expect(run.context.session).toBeNull();
        expect(run.context.superAdminBypass).toBe(false);
        expect(run.context.systemContext).toBe(false);
        expect(run.permissions).toContain('widgets.read');
        return run.permissions;
      },
    );
    expect(seen).toContain('widgets.read');
  });

  it('enforces the persona tool ceiling (allowedTools)', async () => {
    await executeAsPrincipal(
      {
        db,
        principal: { runAsUserId: userId, tenantId, allowedTools: ['publish'] },
        audit: () => {},
      },
      async (run) => {
        expect(run.isToolAllowed('publish')).toBe(true);
        expect(run.isToolAllowed('delete')).toBe(false);
        expect(() => run.assertToolAllowed('publish')).not.toThrow();
        expect(() => run.assertToolAllowed('delete')).toThrow(
          PrincipalToolNotAllowedError,
        );
      },
    );
  });

  it('fails closed when no tool allow-list is provided (permits NOTHING)', async () => {
    await executeAsPrincipal(
      { db, principal: { runAsUserId: userId, tenantId }, audit: () => {} },
      async (run) => {
        expect(run.allowedTools).toEqual([]);
        expect(run.isToolAllowed('anything')).toBe(false);
        expect(() => run.assertToolAllowed('anything')).toThrow(
          PrincipalToolNotAllowedError,
        );
      },
    );
  });

  it('fails closed for an empty allow-list and for empty/blank tool names', async () => {
    await executeAsPrincipal(
      {
        db,
        principal: { runAsUserId: userId, tenantId, allowedTools: [] },
        audit: () => {},
      },
      async (run) => {
        expect(run.isToolAllowed('publish')).toBe(false);
        expect(run.isToolAllowed('')).toBe(false);
        expect(() => run.assertToolAllowed('publish')).toThrow(
          PrincipalToolNotAllowedError,
        );
      },
    );
  });

  it('asserts the catalog permission for a (collection, action) at the RLS-off seam', async () => {
    await executeAsPrincipal(
      { db, principal: { runAsUserId: userId, tenantId }, audit: () => {} },
      async (run) => {
        const permitted = await run.assertOperation('widgets', 'read');
        expect(permitted.allowed).toBe(true);

        await expect(run.assertOperation('widgets', 'create')).rejects.toThrow(
          OperationPermissionError,
        );
      },
    );
  });

  it('reflects live role changes on the next execution', async () => {
    await executeAsPrincipal(
      { db, principal: { runAsUserId: userId, tenantId }, audit: () => {} },
      async (run) => {
        await expect(run.assertOperation('widgets', 'create')).rejects.toThrow(
          OperationPermissionError,
        );
      },
    );

    await grant('widgets.create');

    await executeAsPrincipal(
      { db, principal: { runAsUserId: userId, tenantId }, audit: () => {} },
      async (run) => {
        const permitted = await run.assertOperation('widgets', 'create');
        expect(permitted.allowed).toBe(true);
      },
    );
  });

  it('enforces the published snapshot within a run — a mid-run grant is not honored', async () => {
    await executeAsPrincipal(
      { db, principal: { runAsUserId: userId, tenantId }, audit: () => {} },
      async (run) => {
        // Snapshot holds widgets.read but not widgets.create.
        expect((await run.assertOperation('widgets', 'read')).allowed).toBe(
          true,
        );
        await expect(run.assertOperation('widgets', 'create')).rejects.toThrow(
          OperationPermissionError,
        );

        // Granting widgets.create DURING the run must NOT change the authority
        // bound — the seam authorizes against the published snapshot, matching
        // what Postgres RLS enforces for the same context (adapter-independent).
        await grant('widgets.create');
        await expect(run.assertOperation('widgets', 'create')).rejects.toThrow(
          OperationPermissionError,
        );
      },
    );
  });

  it('honors a reduced pre-resolved permission set consistently at the seam', async () => {
    await grant('widgets.create');
    // Live RBAC now grants both read and create, but the caller narrows the
    // published set to read-only; the RLS-off seam must enforce that narrower
    // snapshot, not the broader live set.
    await executeAsPrincipal(
      {
        db,
        principal: { runAsUserId: userId, tenantId },
        permissions: ['widgets.read'],
        audit: () => {},
      },
      async (run) => {
        expect(run.permissions).toEqual(['widgets.read']);
        expect((await run.assertOperation('widgets', 'read')).allowed).toBe(
          true,
        );
        await expect(run.assertOperation('widgets', 'create')).rejects.toThrow(
          OperationPermissionError,
        );
      },
    );
  });

  it('audits the action as on-behalf-of the originating user', async () => {
    const entries: PrincipalAuditEntry[] = [];
    await executeAsPrincipal(
      {
        db,
        principal: { runAsUserId: userId, tenantId, actsAsProfileId: 'bot-1' },
        onBehalfOfUserId: 'originator-9',
        agentClass: '@happyvertical/smrt-agents:Widgeteer',
        action: 'agent.run',
        audit: (entry) => {
          entries.push(entry);
        },
      },
      async () => {},
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'agent.run',
      actorUserId: userId,
      onBehalfOfUserId: 'originator-9',
      tenantId,
      agentClass: '@happyvertical/smrt-agents:Widgeteer',
      actsAsProfileId: 'bot-1',
    });
  });

  it('falls back to the injected logger when no audit sink is provided', async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    await executeAsPrincipal(
      {
        db,
        principal: { runAsUserId: userId, tenantId },
        onBehalfOfUserId: 'originator-9',
        logger: logger as unknown as Logger,
      },
      async () => {},
    );

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      'agent action executed on behalf of originating user',
      expect.objectContaining({
        actorUserId: userId,
        onBehalfOfUserId: 'originator-9',
      }),
    );
  });
});
