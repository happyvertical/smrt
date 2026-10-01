import { expect, test as base, type Page } from '@playwright/test';
import { ProfileCollection, ProfileTypeCollection } from '@happyvertical/smrt-profiles';
import { getDatabase } from '@happyvertical/sql';
import {
  MembershipCollection,
  PermissionCollection,
  RoleCollection,
  RolePermissionCollection,
  SessionService,
  TenantCollection,
  UserCollection,
} from '@happyvertical/smrt-users';

const databaseUrl = '.smrt/e2e-playwright.db';
const baseURL = 'http://127.0.0.1:4173';
const testIdentity = {
  email: 'content-browser@example.test',
  name: 'Content browser test user',
} as const;

const operationPermissions = [
  'contents.create',
  'contents.update',
  'contentgovernancepolicies.create',
  'contentgovernanceprofiles.create',
  'contentgovernanceassignments.create',
  'contentcontributiontypes.create',
  'contentcontributors.create',
  'contentcontributions.submitWebContribution',
  'contentcontributions.requestChangesAction',
  'contentcontributions.approveAction',
] as const;

async function createAuthenticatedSession() {
  const db = await getDatabase({ type: 'sqlite', url: databaseUrl });
  const profileTypes = await ProfileTypeCollection.create({ db });
  const personType = await profileTypes.getOrCreateBySlug('person', {
    name: 'Person',
  });
  const profiles = await ProfileCollection.create({ db });
  const profile =
    (await profiles.findByEmail(testIdentity.email)) ??
    (await profiles.create({
      email: testIdentity.email,
      name: testIdentity.name,
      typeId: personType.id as string,
    }));

  const users = await UserCollection.create({ db });
  const user =
    (await users.findByEmail(testIdentity.email)) ??
    (await users.create({
      email: testIdentity.email,
      profileId: profile.id as string,
    }));

  const tenants = await TenantCollection.create({ db });
  const tenant = await tenants.create({
    slug: 'content-browser',
    name: 'Content browser QA',
  });
  const roles = await RoleCollection.create({ db });
  const role = await roles.create({
    tenantId: tenant.id,
    slug: 'content-browser-editor',
    name: 'Content browser editor',
  });
  const permissions = await PermissionCollection.create({ db });
  const rolePermissions = await RolePermissionCollection.create({ db });
  for (const slug of operationPermissions) {
    const permission = await permissions.findOrCreate(slug);
    await rolePermissions.addPermission(
      role.id as string,
      permission.id as string,
    );
  }
  const memberships = await MembershipCollection.create({ db });
  await memberships.create({
    userId: user.id,
    tenantId: tenant.id,
    roleId: role.id,
  });
  const sessions = await SessionService.create({ db });
  const sessionId = await sessions.createSession(
    user.id as string,
    tenant.id as string,
  );
  const context = await sessions.loadSessionContext(sessionId);
  expect(context?.tenantId).toBe(tenant.id);
  expect(context?.permissions.sort()).toEqual([...operationPermissions].sort());

  return {
    sessionId,
    cleanup: async () => {
      await sessions.destroySession(sessionId);
    },
  };
}

type ContentFixtures = {
  page: Page;
};

type ContentWorkerFixtures = {
  sessionId: string;
  unprivilegedSessionId: string;
};

/**
 * Each browser test receives a real SMRT session for a least-privilege test
 * user in a dedicated tenant with an active membership and custom role. Only
 * the exact mutation operations exercised below are granted; no admin bypass.
 * A tenant-less session preserves authenticated-without-permission coverage.
 */
export const test = base.extend<ContentFixtures, ContentWorkerFixtures>({
  sessionId: [
    async ({}, use) => {
      // The content hook owns schema bootstrap. An anonymous request makes
      // that normal application path establish every table before the fixture
      // persists its Profile, User, and Session through public SMRT APIs.
      const bootstrap = await fetch(`${baseURL}/api/v1/contents`);
      expect(bootstrap.status).toBe(401);

      const session = await createAuthenticatedSession();
      try {
        await use(session.sessionId);
      } finally {
        await session.cleanup();
      }
    },
    { scope: 'worker' },
  ],

  unprivilegedSessionId: [
    async ({ sessionId }, use) => {
      const db = await getDatabase({ type: 'sqlite', url: databaseUrl });
      const sessions = await SessionService.create({ db });
      const context = await sessions.loadSessionContext(sessionId);
      const unprivileged = await sessions.createSession(
        context!.user.id as string,
      );
      expect(
        (await sessions.loadSessionContext(unprivileged))?.permissions,
      ).toEqual([]);
      try {
        await use(unprivileged);
      } finally {
        await sessions.destroySession(unprivileged);
      }
    },
    { scope: 'worker' },
  ],

  page: async ({ baseURL, browser, sessionId }, use) => {
    if (!baseURL) {
      throw new Error('Content Playwright base URL is required.');
    }

    const context = await browser.newContext({ baseURL });
    await context.addCookies([
      {
        name: 'sid',
        value: sessionId,
        url: baseURL,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    const page = await context.newPage();

    await use(page);
    await context.close();
  },
});

export { expect };
