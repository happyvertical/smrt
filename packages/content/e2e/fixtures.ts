import { expect, test as base, type Page } from '@playwright/test';
import { ProfileCollection, ProfileTypeCollection } from '@happyvertical/smrt-profiles';
import { getDatabase } from '@happyvertical/sql';
import { SessionService, UserCollection } from '@happyvertical/smrt-users';

const databaseUrl = '.smrt/e2e-playwright.db';
const baseURL = 'http://127.0.0.1:4173';
const testIdentity = {
  email: 'content-browser@example.test',
  name: 'Content browser test user',
} as const;

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

  const sessions = await SessionService.create({ db });
  const sessionId = await sessions.createSession(user.id as string);

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
};

/**
 * Each browser test receives a real SMRT session for a least-privilege test
 * user. The fixture creates no tenant membership, role, or permission grant:
 * the exercised content endpoints require an authenticated principal only.
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
