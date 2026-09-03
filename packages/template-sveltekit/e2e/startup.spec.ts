/**
 * Fresh-process startup and owner onboarding.
 *
 * Proves the thing every other spec depends on: this is a real application
 * that was built, migrated, and started from a clean temporary state root,
 * and that the browser is talking to *that* process and not a stale one.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { expect, test } from './fixtures.js';
import { packageRoot } from './support/referenceApp.js';

test.describe.configure({ mode: 'serial' });

test('starts from a clean temporary checkout copy and state root', async ({
  referenceApp,
}) => {
  const repositoryRoot = resolve(packageRoot, '..', '..');
  // Application data, state, and the copied source all live outside the
  // repository. A gate that wrote into the checkout would be proving
  // something about this machine, not about a generated application.
  for (const path of [
    referenceApp.appRoot,
    referenceApp.dataRoot,
    referenceApp.stateRoot,
  ]) {
    expect(path.startsWith(repositoryRoot)).toBe(false);
    expect(path.startsWith(referenceApp.temporaryRoot)).toBe(true);
  }

  // File-backed SQLite, not an in-memory database: the file exists on disk.
  const databaseFiles = readdirSync(referenceApp.dataRoot, {
    recursive: true,
    encoding: 'utf8',
  }).filter((entry) => entry.endsWith('.db') || entry.endsWith('.sqlite'));
  expect(databaseFiles.length).toBeGreaterThan(0);

  // The state root is owner-private.
  expect(statSync(referenceApp.stateRoot).mode & 0o077).toBe(0);

  // The served application saw none of the PostgreSQL wrapper's environment.
  // `test:m5` runs the whole gate under that wrapper, so without the strip the
  // browser half would serve an application configured against CI's disposable
  // PostgreSQL target while actually opening SQLite.
  for (const key of Object.keys(referenceApp.servedEnvironment)) {
    expect(key.startsWith('PG')).toBe(false);
  }
  for (const key of [
    'DATABASE_TYPE',
    'DATABASE_URL',
    'SMRT_TEST_POSTGRES_URL',
    'TEST_DB_ADAPTER',
    'TEST_DB_URL',
  ]) {
    expect(referenceApp.servedEnvironment[key]).toBeUndefined();
  }
});

test('proves process identity before the browser drives it', async ({
  referenceApp,
  request,
}) => {
  const response = await request.get(
    `${referenceApp.baseURL}/api/_runtime/health`,
  );
  expect(response.status()).toBe(200);
  const health = (await response.json()) as Record<string, unknown>;
  expect(health.status).toBe('ready');
  expect(health.profile).toBe('local');
  expect(health.application).toBe(referenceApp.identity.application);
  expect(health.instance).toBe(referenceApp.identity.instance);
  expect(health.configuration).toBe(referenceApp.identity.configuration);
});

test('completes owner onboarding without exposing the bootstrap token', async ({
  referenceApp,
  ownerPage,
}) => {
  // `ownerPage` depends on the onboarding fixture, so reaching here means the
  // real `/setup` form was submitted and a real session cookie was issued.
  await ownerPage.goto('/');
  await expect(ownerPage.getByRole('heading', { level: 1 })).toBeVisible();

  const token = new URL(referenceApp.onboardingUrl).searchParams.get('token');
  expect(token).toBeTruthy();

  // The invitation is single-use: the same token cannot onboard a second
  // owner, and the setup page no longer offers the form.
  await ownerPage.goto(referenceApp.onboardingUrl);
  await expect(ownerPage.locator('input[name="name"]')).toHaveCount(0);

  // Setup's post-claim cleanup removed the on-disk handoff, so the token is
  // no longer retrievable from the state root at all.
  expect(existsSync(join(referenceApp.stateRoot, 'onboarding.json'))).toBe(
    false,
  );

  // Nothing this gate can publish contains the token. The root comes from
  // Playwright rather than being restated here: a literal path that the config
  // no longer uses would make this loop unreachable and the case vacuous.
  const artifactRoot = test.info().project.outputDir;
  // Traces, videos and screenshots are off, so the root can legitimately be
  // empty and the loop below would never run. Plant one known-clean file so
  // the scan is exercised on every run rather than only on the runs where
  // something already went wrong.
  mkdirSync(artifactRoot, { recursive: true });
  writeFileSync(
    join(artifactRoot, 'startup-token-scan-sentinel.json'),
    `${JSON.stringify({ schemaVersion: 1, gate: 'm5', sentinel: true })}\n`,
  );
  const entries = readdirSync(artifactRoot, {
    recursive: true,
    encoding: 'utf8',
  });
  expect(entries).toContain('startup-token-scan-sentinel.json');
  for (const entry of entries) {
    const path = join(artifactRoot, entry);
    if (!statSync(path).isFile()) continue;
    expect(readFileSync(path, 'utf8')).not.toContain(token!);
  }
});
