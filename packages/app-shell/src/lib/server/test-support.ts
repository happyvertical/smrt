// Test harness: a real SQLite shell.db in a temp directory with the shell's
// schema, an owner and a non-owner membership, and the shell holders pointed
// at it. No SvelteKit, no containers.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_ROLE_SLUGS,
  MembershipCollection,
  MembershipStatus,
  RoleCollection,
  TenantCollection,
  UserCollection,
} from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import { vi } from 'vitest';
import '../objects/index.ts';
import { configureShell, resetShell } from './host.ts';
import { resetShellInference } from './inference.ts';
import { type Principal, runAs, setOwnerCheck } from './owner.ts';
import { prepareShellSchema } from './schema.ts';

/** The secrets master key tests seal under (never a real key). */
export const TEST_MASTER_KEY = 'cd'.repeat(32);

export interface ShellHarness {
  dir: string;
  db: DatabaseInterface;
  owner: Principal;
  member: Principal;
  stranger: Principal;
  close(): Promise<void>;
}

export async function openShell(): Promise<ShellHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'shell-test-'));
  // The real driver: the vitest setup would pre-create registered tables.
  const actual =
    await vi.importActual<typeof import('@happyvertical/sql')>(
      '@happyvertical/sql',
    );
  const db = await actual.getDatabase({
    type: 'sqlite',
    url: join(dir, 'shell.db'),
  } as never);
  await prepareShellSchema(db);
  const roles = await RoleCollection.create({ db });
  await roles.seedSystemRoles({ seedPermissions: false });
  const ownerRole = await roles.findSystemRoleBySlug(DEFAULT_ROLE_SLUGS.OWNER);
  const memberRole = await roles.findSystemRoleBySlug(
    DEFAULT_ROLE_SLUGS.MEMBER,
  );
  const tenants = await TenantCollection.create({ db });
  const tenant = await tenants.create({ name: 'Test', slug: 'test' });
  await tenant.save();
  const users = await UserCollection.create({ db });
  const memberships = await MembershipCollection.create({ db });
  const ids: Record<string, string> = {};
  for (const [key, role] of [
    ['owner', ownerRole],
    ['member', memberRole],
  ] as const) {
    const user = await users.create({
      email: `${key}@example.test`,
      username: key,
    });
    await user.save();
    ids[key] = user.id as string;
    const m = await memberships.create({
      userId: user.id as string,
      tenantId: tenant.id as string,
      roleId: role?.id as string,
      status: MembershipStatus.ACTIVE,
    });
    await m.save();
  }
  setOwnerCheck(null);
  configureShell({
    db: async () => db,
    dataRoot: async () => dir,
    // A fixed test key stands in for the runtime's vault-held master key.
    secretMasterKey: async () => TEST_MASTER_KEY,
  });
  return {
    dir,
    db,
    owner: { id: ids.owner, tenantId: tenant.id as string },
    member: { id: ids.member, tenantId: tenant.id as string },
    stranger: { id: 'u-stranger', tenantId: tenant.id as string },
    async close() {
      resetShellInference();
      await resetShell();
      setOwnerCheck(null);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export { runAs };
