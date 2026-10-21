/**
 * Generated CLI lockdown for identity/RBAC models (#3742).
 *
 * #1400 closed the generated REST/MCP write surface on every authority model
 * but left `cli: { skipApiCheck: true }` / `cli: true` in place. A `cli` config
 * without an `include` list is FULL CRUD, so the generated CLI (and every agent
 * that shells out to it) could mint, rewrite or delete magic-link tokens,
 * sessions, memberships, roles, grants and tenants without going through the
 * permission-gated users services. Every locked model must now spell its CLI
 * surface out explicitly, and the generated CLI must not emit create/update/
 * delete for any of them.
 *
 * The permission catalog historically derived these models' operation slugs
 * from that same (accidental) CLI exposure; hand-written, permission-checked
 * services and consumer handlers still assert them, so the catalog must keep
 * cataloguing them after the transport is closed.
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ObjectRegistry,
  type SmartObjectManifest,
} from '@happyvertical/smrt-core';
import { buildDomainKnowledgeManifest } from '@happyvertical/smrt-core/knowledge';
import { describe, expect, it } from 'vitest';
import '../index.js';
import { PermissionCatalogService } from '../services/PermissionCatalogService.js';

const PACKAGE = '@happyvertical/smrt-users';
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CRUD = ['list', 'get', 'create', 'update', 'delete'] as const;
const MUTATING = ['create', 'update', 'delete'] as const;

/**
 * Expected generated CLI CRUD commands per locked model. Read-only models
 * mirror their REST/MCP list/get surface; credential- and grant-bearing models
 * expose no generated CLI at all (their REST/MCP surface is already empty, and
 * listing them would print live bearer secrets or bypass the grant service).
 */
const EXPECTED_CLI_CRUD: Record<string, readonly string[]> = {
  UsersMagicLinkToken: [],
  Session: [],
  ResourceGrant: [],
  AccessRequest: [],
  UsersCliAuthRequest: [],
  UsersOAuthClient: [],
  UsersOAuthAuthorizationCode: [],
  UsersOAuthAuthorization: [],
  UsersOAuthRefreshGrant: [],
  UsersOAuthRefreshFamily: [],
  UsersOAuthAccessTokenRevocation: [],
  UsersPasskeyCredential: [],
  UsersPasskeyChallenge: [],
  Membership: ['list', 'get'],
  MembershipOverride: ['list', 'get'],
  User: ['list', 'get'],
  Tenant: ['list', 'get'],
  TenantIntegration: ['list', 'get'],
  Role: ['list', 'get'],
  Permission: ['list', 'get'],
  TenantPermissionOverride: ['list', 'get'],
  RolePermission: ['list', 'get'],
  Group: ['list', 'get'],
  GroupRole: ['list', 'get'],
  GroupMember: ['list', 'get'],
};

type CliConfig =
  | boolean
  | { include?: string[]; exclude?: string[]; skipApiCheck?: unknown }
  | undefined;

/**
 * The CRUD commands `packages/cli/src/cli-generator.ts` emits for a `cli`
 * config: `false` closes the surface, an `include` list filters it, and any
 * other value (`true`, omitted, `{ skipApiCheck: true }`) is full CRUD.
 */
function shippedCliCrud(config: CliConfig): string[] {
  if (config === false) return [];
  const include =
    typeof config === 'object' && Array.isArray(config.include)
      ? config.include
      : null;
  const exclude =
    typeof config === 'object' && Array.isArray(config.exclude)
      ? config.exclude
      : [];
  return CRUD.filter(
    (op) => (!include || include.includes(op)) && !exclude.includes(op),
  );
}

describe('generated CLI lockdown for identity/RBAC models (#3742)', () => {
  for (const [modelName, expected] of Object.entries(EXPECTED_CLI_CRUD)) {
    it(`${modelName} generates exactly ${JSON.stringify(expected)} CLI CRUD commands`, () => {
      const registered = ObjectRegistry.getClassInPackage(PACKAGE, modelName);
      expect(registered, `${modelName} must be registered`).toBeTruthy();
      const cli = (registered as { config: { cli?: CliConfig } }).config.cli;

      expect(
        cli,
        `${modelName}.cli must be explicit (false or an include list)`,
      ).not.toBeUndefined();
      expect(shippedCliCrud(cli)).toEqual(expected);
      if (expected.length === 0) {
        // Close the surface outright: an `include: []` still lets the shipped
        // CLI expose every public custom method (#2692).
        expect(cli).toBe(false);
      }
    });
  }

  it('emits no mutating CLI surface for locked models in smrt-knowledge', async () => {
    const manifest = JSON.parse(
      await readFile(resolve(PACKAGE_ROOT, '.smrt/manifest.json'), 'utf8'),
    ) as SmartObjectManifest;
    const knowledge = buildDomainKnowledgeManifest({
      manifest,
      rootDir: PACKAGE_ROOT,
    });

    const lockedQualifiedNames = new Set(
      Object.keys(EXPECTED_CLI_CRUD).map((name) => `${PACKAGE}:${name}`),
    );
    const cliCrud = new Map<string, string[]>();
    for (const surface of knowledge.surfaces ?? []) {
      if (surface.kind !== 'cli' || !surface.objectName) continue;
      if (!lockedQualifiedNames.has(surface.objectName)) continue;
      const modelName = surface.objectName.slice(PACKAGE.length + 1);
      expect(
        EXPECTED_CLI_CRUD[modelName]?.length,
        `${modelName} must not emit custom CLI methods or CRUD commands`,
      ).not.toBe(0);
      if (!(CRUD as readonly string[]).includes(surface.operation)) continue;
      const ops = cliCrud.get(surface.objectName) ?? [];
      ops.push(surface.operation);
      cliCrud.set(surface.objectName, ops);
    }

    for (const [modelName, expected] of Object.entries(EXPECTED_CLI_CRUD)) {
      const emitted = cliCrud.get(`${PACKAGE}:${modelName}`) ?? [];
      for (const op of MUTATING) {
        expect(
          emitted,
          `${modelName} must not emit a "${op}" CLI surface`,
        ).not.toContain(op);
      }
      expect([...emitted].sort()).toEqual([...expected].sort());
    }
  });

  it('keeps cataloguing the authority operation slugs the services assert', () => {
    const slugs = new Set(
      new PermissionCatalogService()
        .getCatalog()
        .permissions.map((permission) => permission.slug),
    );
    for (const collection of [
      'groupmembers',
      'grouproles',
      'groups',
      'membershipoverrides',
      'memberships',
      'permissions',
      'resourcegrants',
      'rolepermissions',
      'roles',
      'sessions',
      'tenantintegrations',
      'tenantpermissionoverrides',
      'tenants',
      'users',
      'usersmagiclinktokens',
    ]) {
      for (const action of ['read', ...MUTATING]) {
        expect(slugs, `${collection}.${action}`).toContain(
          `${collection}.${action}`,
        );
      }
    }
    // Custom operation slugs stay catalogued too (consumer handlers assert
    // them through assertOperationPermission, which requires catalog presence).
    for (const slug of [
      'tenants.moveToParent',
      'tenants.createChild',
      'sessions.revokeUserSessions',
      'memberships.findByUserAndTenant',
      'rolepermissions.addPermission',
      'usersmagiclinktokens.markUsed',
    ]) {
      expect(slugs).toContain(slug);
    }
  });
});
