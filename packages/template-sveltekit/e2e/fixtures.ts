/**
 * Worker-scoped fixtures for the M5 fresh-browser gate.
 *
 * `referenceApp` provisions and starts one real application per worker and
 * completes owner onboarding through the app's own `/setup` form. `ownerState`
 * is the resulting authenticated session, captured as storage state so each
 * test opens a *fresh browser context* that is nonetheless a real page user.
 */

import { join } from 'node:path';

import {
  test as base,
  expect,
  type BrowserContext,
  type Page,
  type Response,
} from '@playwright/test';

import { installModelContext } from './support/modelContext.js';
import {
  startReferenceApp,
  redactHarnessPaths,
  type StartedReferenceApp,
} from './support/referenceApp.js';

/** Owner identity used for onboarding. Synthetic; never a real person. */
export const REFERENCE_OWNER = {
  name: 'Reference Owner',
  email: 'reference-owner@example.test',
} as const;

export interface M5Fixtures {
  /** A fresh browser context with only the WebMCP test boundary installed. */
  anonymousContext: BrowserContext;
  /** A fresh browser context carrying the onboarded owner's real session. */
  ownerPage: Page;
}

export interface M5WorkerFixtures {
  referenceApp: StartedReferenceApp;
  /** Path to the owner's captured session state, inside the temporary root. */
  ownerStatePath: string;
}

export const test = base.extend<M5Fixtures, M5WorkerFixtures>({
  referenceApp: [
    async ({}, use) => {
      const app = await startReferenceApp();
      try {
        await use(app);
      } finally {
        await app.stop();
      }
    },
    { scope: 'worker', timeout: 15 * 60_000 },
  ],

  ownerStatePath: [
    async ({ browser, referenceApp }, use) => {
      const context = await browser.newContext({
        baseURL: referenceApp.baseURL,
      });
      await context.addInitScript(installModelContext);
      const page = await context.newPage();
      const statePath = join(referenceApp.temporaryRoot, 'owner-state.json');
      let onResponse: ((response: Response) => void) | undefined;
      const serverFailure = new Promise<never>((_resolve, reject) => {
        onResponse = (response) => {
          const path = new URL(response.url()).pathname;
          if (response.status() < 500 || !['/', '/setup'].includes(path))
            return;
          const requestId = response.headers()['x-request-id'];
          const safeId =
            requestId && /^[A-Za-z0-9_-]{1,128}$/.test(requestId)
              ? requestId
              : 'absent';
          reject(
            new Error(
              `Owner onboarding failed: ${response.request().method()} ${path} status=${response.status()} requestId=${safeId}`,
            ),
          );
        };
        page.on('response', onResponse);
      });
      // The bootstrap token travels only in this navigation. Traces, videos
      // and screenshots are off for the whole gate, so it is never captured.
      try {
        await Promise.race([
          serverFailure,
          (async () => {
            await page.goto(referenceApp.onboardingUrl, {
              waitUntil: 'networkidle',
            });
            await page.locator('input[name="name"]').fill(REFERENCE_OWNER.name);
            await page
              .locator('input[name="email"]')
              .fill(REFERENCE_OWNER.email);
            await Promise.all([
              page.waitForURL((url) => new URL(url).pathname === '/'),
              page.getByRole('button', { name: 'Create owner' }).click(),
            ]);
          })(),
        ]);
        await context.storageState({ path: statePath });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Owner onboarding failed';
        throw new Error(
          redactHarnessPaths(
            message
              .replaceAll(referenceApp.bootstrapToken, '[redacted]')
              .replaceAll(/https?:\/\/[^\s"'<>]+/g, '[url]'),
            referenceApp.temporaryRoot,
          ) +
            '\n' +
            referenceApp.failureOutput(),
        );
      } finally {
        if (onResponse) page.off('response', onResponse);
        await context.close();
      }
      await use(statePath);
    },
    { scope: 'worker', timeout: 5 * 60_000 },
  ],

  anonymousContext: async ({ browser, referenceApp }, use) => {
    const context = await browser.newContext({ baseURL: referenceApp.baseURL });
    await context.addInitScript(installModelContext);
    await use(context);
    await context.close();
  },

  ownerPage: async ({ browser, referenceApp, ownerStatePath }, use) => {
    const context = await browser.newContext({
      baseURL: referenceApp.baseURL,
      storageState: ownerStatePath,
    });
    await context.addInitScript(installModelContext);
    const page = await context.newPage();
    await use(page);
    await context.close();
  },
});

export { expect };
