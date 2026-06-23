/**
 * S5 security-audit regression tests (#1400).
 *
 * Covers the exploitable medium+ findings remediated for @happyvertical/smrt-users:
 *  1. RBAC/identity generated CRUD lockdown — mutating an authority table over an
 *     auth-only-gated generated route is privilege escalation. The generated
 *     REST/MCP write surface must stay empty for every authority/identity model.
 *  2. switchTenant membership verification — a session's tenantId is the
 *     tenant-isolation key for every @TenantScoped query, so it must never be set
 *     to a tenant the user is not an active member of (cross-tenant access).
 *  3. deleteExpired atomicity — a session that is both expired AND revoked must
 *     not be double-deleted (which could abort the cleanup job mid-run).
 *  4. OIDC email_verified — refuse to provision a user from an email the IdP
 *     explicitly reported unverified.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import {
  createIsolatedTestDb,
  type IsolatedTestDbResult,
} from '@happyvertical/smrt-vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  generateSessionId,
  MembershipCollection,
  MembershipStatus,
  RoleCollection,
  SessionCollection,
  SessionService,
  SessionStatus,
  TenantCollection,
  UserCollection,
} from '../index.js';

// ---------------------------------------------------------------------------
// 1. RBAC / identity generated CRUD lockdown (#1400)
// ---------------------------------------------------------------------------

const MUTATING_OPS = ['create', 'update', 'delete'] as const;
const PACKAGE = '@happyvertical/smrt-users';

/**
 * Every model whose mutation is an authority change: granting a role/permission,
 * adding a group/tenant override, flipping a tenant's cascade flags, or changing
 * an auth identity. `requireRouteAuth` (the merged #1540 gate) only enforces
 * authentication, not authorization, and none of these are `@TenantScoped`, so a
 * generated create/update/delete would let any logged-in user escalate. The
 * generated REST/MCP write surface must therefore be empty for all of them.
 */
const LOCKED_MODELS = [
  'Membership',
  'MembershipOverride',
  'RolePermission',
  'GroupRole',
  'GroupMember',
  'Role',
  'Permission',
  'TenantPermissionOverride',
  'User',
  'Tenant',
  'Group',
];

type SurfaceConfig = {
  api?: boolean | { include?: string[] };
  mcp?: boolean | { include?: string[] };
};

/** Mirror how the REST/MCP generators read an `api`/`mcp` config value. */
function surfaceFromConfig(config: SurfaceConfig): {
  api: string[] | null;
  mcp: string[] | null;
} {
  const toInclude = (
    surface: boolean | { include?: string[] } | undefined,
  ): string[] | null => {
    // `false` disables the surface (closed). An OMITTED config (undefined) does
    // NOT mean closed: the REST + MCP generators emit the FULL CRUD surface by
    // default (sveltekit-generator `resolveStandardCrudActions`, mcp.ts
    // `shouldInclude`), exactly like `true`. Model both as `null` so the
    // assertion rejects them — an authority model must use an explicit list.
    if (surface === false) return [];
    if (surface === true || surface === undefined) return null;
    return surface.include ?? null;
  };
  return { api: toInclude(config.api), mcp: toInclude(config.mcp) };
}

describe('RBAC/identity generated CRUD lockdown (#1400)', () => {
  for (const modelName of LOCKED_MODELS) {
    it(`${modelName} exposes no mutating REST/MCP operation`, () => {
      const registered = ObjectRegistry.getClassInPackage(PACKAGE, modelName);
      expect(registered, `${modelName} must be registered`).toBeTruthy();

      const { api, mcp } = surfaceFromConfig(
        (registered as { config: SurfaceConfig }).config,
      );

      // A `null` surface means `api: true` / `mcp: true` (full CRUD generated) —
      // the dangerous default this finding is about. Authority tables must use an
      // explicit read-only include list. (cli is intentionally not asserted: it
      // is a local-operator surface, outside the network/agent threat model.)
      for (const [name, surface] of [
        ['api', api],
        ['mcp', mcp],
      ] as const) {
        expect(
          surface,
          `${modelName}.${name} must be an explicit include list, not full CRUD`,
        ).not.toBeNull();
        for (const op of MUTATING_OPS) {
          expect(
            surface,
            `${modelName}.${name} must not generate "${op}"`,
          ).not.toContain(op);
        }
      }
    });
  }

  it('still exposes read operations for admin UIs', () => {
    const membership = ObjectRegistry.getClassInPackage(PACKAGE, 'Membership');
    const { api } = surfaceFromConfig(
      (membership as { config: SurfaceConfig }).config,
    );
    expect(api).toEqual(['list', 'get']);
  });
});

// ---------------------------------------------------------------------------
// 2. switchTenant membership verification (#1400)
// ---------------------------------------------------------------------------

describe('switchTenant membership verification (#1400)', () => {
  let dbPath: string;
  let users: UserCollection;
  let tenants: TenantCollection;
  let roles: RoleCollection;
  let memberships: MembershipCollection;
  let sessions: SessionCollection;
  let sessionService: SessionService;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-1400-switch-${Date.now()}.db`);
    const options = { db: { type: 'sqlite' as const, url: dbPath } };
    users = await UserCollection.create(options);
    tenants = await TenantCollection.create(options);
    roles = await RoleCollection.create(options);
    memberships = await MembershipCollection.create(options);
    sessions = await SessionCollection.create(options);
    sessionService = await SessionService.create(options);
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  });

  async function seed(membershipStatus: MembershipStatus) {
    const user = await users.create({ email: `u-${Date.now()}@example.com` });
    await user.save();
    const home = await tenants.create({ name: 'Home Org' });
    await home.save();
    const foreign = await tenants.create({ name: 'Foreign Org' });
    await foreign.save();
    const role = await roles.create({ name: 'Member' });
    await role.save();
    const membership = await memberships.create({
      userId: user.id!,
      tenantId: home.id!,
      roleId: role.id!,
      status: membershipStatus,
    });
    await membership.save();
    const sessionId = await sessionService.createSession(user.id!);
    return { user, home, foreign, sessionId };
  }

  it('switches into a tenant the user is an active member of (rotating the id)', async () => {
    const { home, sessionId } = await seed(MembershipStatus.ACTIVE);

    const result = await sessionService.switchTenant(sessionId, home.id!);

    expect(result.switched).toBe(true);
    // #1354 follow-up: a successful non-null switch rotates the session id and
    // revokes the old one.
    expect(result.rotated).toBe(true);
    expect(result.sessionId).not.toBe(sessionId);
    expect(await sessions.findValidSession(sessionId)).toBeNull();

    const session = await sessions.findValidSession(result.sessionId!);
    expect(session?.tenantId).toBe(home.id);
  });

  it('refuses to switch into a tenant the user is not a member of', async () => {
    const { foreign, sessionId } = await seed(MembershipStatus.ACTIVE);

    const result = await sessionService.switchTenant(sessionId, foreign.id!);

    expect(result.switched).toBe(false);
    expect(result.rotated).toBe(false);
    // The original session must NOT be tainted (or rotated) — it still exists
    // with a null tenant id.
    const session = await sessions.findValidSession(sessionId);
    expect(session?.tenantId).toBeNull();
  });

  it('refuses to switch when the membership is not active', async () => {
    const { home, sessionId } = await seed(MembershipStatus.INACTIVE);

    const result = await sessionService.switchTenant(sessionId, home.id!);

    expect(result.switched).toBe(false);
    expect(result.rotated).toBe(false);
    const session = await sessions.findValidSession(sessionId);
    expect(session?.tenantId).toBeNull();
  });

  it('always allows clearing the tenant context (null) without rotating', async () => {
    const { home, sessionId } = await seed(MembershipStatus.ACTIVE);
    // Switch in (rotates), then clear on the new id.
    const switchedIn = await sessionService.switchTenant(sessionId, home.id!);
    expect(switchedIn.switched).toBe(true);
    const activeId = switchedIn.sessionId!;

    const cleared = await sessionService.switchTenant(activeId, null);

    expect(cleared.switched).toBe(true);
    expect(cleared.rotated).toBe(false);
    expect(cleared.sessionId).toBe(activeId);
    const session = await sessions.findValidSession(activeId);
    expect(session?.tenantId).toBeNull();
  });

  it('fail-closes for an unknown session', async () => {
    const { home } = await seed(MembershipStatus.ACTIVE);
    const result = await sessionService.switchTenant('not-a-session', home.id!);
    expect(result.switched).toBe(false);
    expect(result.sessionId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. deleteExpired atomicity (#1400)
// ---------------------------------------------------------------------------

describe('deleteExpired atomic cleanup (#1400)', () => {
  let dbPath: string;
  let users: UserCollection;
  let sessions: SessionCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-1400-cleanup-${Date.now()}.db`);
    const options = { db: { type: 'sqlite' as const, url: dbPath } };
    users = await UserCollection.create(options);
    sessions = await SessionCollection.create(options);
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  });

  it('reaps expired and revoked sessions in one pass, even a both-expired-and-revoked row', async () => {
    const user = await users.create({ email: 'cleanup@example.com' });
    await user.save();

    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);

    // Expired (still marked active).
    const expired = await sessions.create({
      id: generateSessionId(),
      userId: user.id!,
      status: SessionStatus.ACTIVE,
      expiresAt: past,
    });
    await expired.save();

    // Revoked but not yet past its TTL.
    const revoked = await sessions.create({
      id: generateSessionId(),
      userId: user.id!,
      status: SessionStatus.REVOKED,
      expiresAt: future,
    });
    await revoked.save();

    // BOTH expired and revoked — the row the old two-pass cleanup deleted twice.
    const both = await sessions.create({
      id: generateSessionId(),
      userId: user.id!,
      status: SessionStatus.REVOKED,
      expiresAt: past,
    });
    await both.save();

    // A live session that must survive.
    const valid = await sessions.createSession({ userId: user.id! });

    const deleted = await sessions.deleteExpired();

    // Each matching row removed exactly once — no double count, no throw.
    expect(deleted).toBe(3);
    expect(await sessions.get(expired.id!)).toBeNull();
    expect(await sessions.get(revoked.id!)).toBeNull();
    expect(await sessions.get(both.id!)).toBeNull();
    expect(await sessions.findValidSession(valid.id!)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. OIDC email_verified enforcement (#1400)
// ---------------------------------------------------------------------------

const PROFILE_SCHEMA = `
CREATE TABLE IF NOT EXISTS "profile_types" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "slug" TEXT NOT NULL,
  "context" TEXT NOT NULL DEFAULT '',
  "_meta_type" TEXT NOT NULL,
  "_meta_data" JSON,
  "created_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "updated_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "tenant_id" TEXT,
  "name" TEXT DEFAULT '',
  "description" TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS "profile_types_slug_context_meta_type_idx" ON "profile_types" ("slug", "context", "_meta_type");

CREATE TABLE IF NOT EXISTS "profiles" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "slug" TEXT NOT NULL,
  "context" TEXT NOT NULL DEFAULT '',
  "_meta_type" TEXT NOT NULL,
  "_meta_data" JSON,
  "created_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "updated_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "tenant_id" TEXT,
  "type_id" TEXT,
  "email" TEXT,
  "name" TEXT DEFAULT '',
  "description" TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS "profiles_slug_context_meta_type_idx" ON "profiles" ("slug", "context", "_meta_type");

CREATE TABLE IF NOT EXISTS "oidc_identities" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "slug" TEXT NOT NULL,
  "context" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "updated_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "profile_id" TEXT,
  "provider" TEXT DEFAULT '',
  "issuer" TEXT DEFAULT '',
  "subject" TEXT DEFAULT '',
  "email" TEXT DEFAULT '',
  "last_used_at" TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "oidc_identities_slug_context_idx" ON "oidc_identities" ("slug", "context");

CREATE TABLE IF NOT EXISTS "users" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "slug" TEXT NOT NULL,
  "context" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "updated_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "profile_id" TEXT DEFAULT '',
  "email" TEXT DEFAULT '',
  "status" TEXT,
  "last_login_at" TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "users_slug_context_idx" ON "users" ("slug", "context");
`;

describe('OIDC email_verified enforcement (#1400)', () => {
  let isolated: IsolatedTestDbResult;
  let users: UserCollection;

  beforeEach(async () => {
    isolated = await createIsolatedTestDb({ schema: PROFILE_SCHEMA });
    users = await UserCollection.create({ db: isolated.db });
  });

  afterEach(async () => {
    await isolated.cleanup();
  });

  const baseClaims = {
    iss: 'https://idp.example.com',
    name: 'Test User',
  };

  it('refuses to provision a user when the IdP reports email_verified: false', async () => {
    await expect(
      users.getOrCreateFromOidc(
        {
          ...baseClaims,
          sub: 'sub-unverified',
          email: 'unverified@example.com',
          email_verified: false,
        },
        'test',
      ),
    ).rejects.toThrow(/unverified/i);
  });

  it('provisions a user when email_verified: true', async () => {
    const result = await users.getOrCreateFromOidc(
      {
        ...baseClaims,
        sub: 'sub-verified',
        email: 'verified@example.com',
        email_verified: true,
      },
      'test',
    );
    expect(result.user.email).toBe('verified@example.com');
  });

  it('provisions a user when the email_verified claim is absent (cannot enforce)', async () => {
    const result = await users.getOrCreateFromOidc(
      {
        ...baseClaims,
        sub: 'sub-absent',
        email: 'absent@example.com',
      },
      'test',
    );
    expect(result.user.email).toBe('absent@example.com');
  });

  it('provisions an unverified email only with the explicit allowUnverifiedEmail opt-out', async () => {
    const result = await users.getOrCreateFromOidc(
      {
        ...baseClaims,
        sub: 'sub-optout',
        email: 'optout@example.com',
        email_verified: false,
      },
      'test',
      { allowUnverifiedEmail: true },
    );
    expect(result.user.email).toBe('optout@example.com');
  });
});
