/**
 * Composition of restore-latest (#4805) and the cloud migration (#4806) over
 * installation custody (#4704), with real installations, state roots and
 * encrypted snapshots:
 *
 * - a restore leaves custody pending, and a migration refuses to start until
 *   the operator declares the move;
 * - a location the migration retired cannot be restored over, silently or
 *   with --origin-retired, until the retirement is reversed explicitly;
 * - reversing an abandoned migration and restoring composes: custody is
 *   re-declared, and a new migration start retires the location again.
 */

import { join } from 'node:path';
import {
  inspectInstallationCustody,
  restoreInstallation,
} from '@happyvertical/smrt-app-runtime';
import { describe, expect, it } from 'vitest';
import {
  beginCloudMigration,
  CloudMigrationError,
  readCloudMigrationRecord,
} from '../cloud-migration.js';
import {
  APP_ID,
  harness,
  installRestoreHooks,
  marker,
  setMarker,
} from './restore-test-support.js';

installRestoreHooks();

async function custodyRefusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(CloudMigrationError);
  expect((error as CloudMigrationError).code).toBe('custody_refused');
  return (error as CloudMigrationError).message;
}

async function publishedLaptop() {
  const h = await harness();
  const laptop = join(h.root, 'laptop');
  await h.boot(laptop, 'v1');
  await h.relay.publish(laptop, 'device-laptop', h.keys);
  const options = (data: string) => {
    h.use(data);
    return { appId: APP_ID, dataDirectory: data, sourceRoot: h.app };
  };
  return { h, laptop, options };
}

describe('restore-latest composed with cloud migration custody', () => {
  it('a restored location is not in custody: migration waits for the operator to declare the move', async () => {
    const { h, options } = await publishedLaptop();
    const desktop = join(h.root, 'desktop');
    const restored = await h.run(desktop, 'device-desktop');
    expect(restored.code).toBe(0);
    expect(JSON.parse(restored.stdout).custody).toBe('pending');

    const where = options(desktop);
    expect((await inspectInstallationCustody(where)).status).not.toBe(
      'in-custody',
    );
    // Starting a migration here would retire a location that is not ours.
    expect(
      await custodyRefusal(
        beginCloudMigration({ ...where, target: 'per-user' }),
      ),
    ).toMatch(/not in this location's custody/);
    expect(readCloudMigrationRecord(where)).toBeNull();
    expect((await inspectInstallationCustody(where)).status).not.toBe(
      'retired',
    );

    // The operator declares the move (the origin is retired); then it starts.
    await restoreInstallation({ ...where, originRetired: true });
    const record = await beginCloudMigration({ ...where, target: 'per-user' });
    expect(record.status).toBe('in-progress');
    expect((await inspectInstallationCustody(where)).status).toBe('retired');
  });

  it('threat: a location retired by a migration is not restored over, even with --origin-retired', async () => {
    const { h, laptop, options } = await publishedLaptop();
    const desktop = join(h.root, 'desktop');
    expect(
      (await h.run(desktop, 'device-desktop', ['--origin-retired'])).code,
    ).toBe(0);
    const where = options(desktop);
    const started = await beginCloudMigration({ ...where, target: 'per-user' });
    expect((await inspectInstallationCustody(where)).status).toBe('retired');

    setMarker(laptop, 'v2');
    await h.relay.publish(laptop, 'device-laptop', h.keys);
    const callsBefore = h.relay.state.calls.length;
    for (const argv of [[], ['--origin-retired'], ['--discard-local']]) {
      const refused = await h.run(desktop, 'device-desktop', argv);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain('retired');
    }

    // Nothing moved: no relay contact, data root, record or custody change.
    expect(h.relay.state.calls.length).toBe(callsBefore);
    expect(marker(desktop)).toBe('v1');
    expect(readCloudMigrationRecord(where)).toEqual(started);
    expect((await inspectInstallationCustody(where)).status).toBe('retired');
  });

  it('an abandoned migration is reversed explicitly, then restore and a new start compose', async () => {
    const { h, laptop, options } = await publishedLaptop();
    const desktop = join(h.root, 'desktop');
    expect(
      (await h.run(desktop, 'device-desktop', ['--origin-retired'])).code,
    ).toBe(0);
    const where = options(desktop);
    const first = await beginCloudMigration({ ...where, target: 'per-user' });

    // Abandon: resume local use, then catch up with the vault.
    await restoreInstallation({ ...where, originRetired: true });
    setMarker(laptop, 'v2');
    await h.relay.publish(laptop, 'device-laptop', h.keys);
    const caughtUp = await h.run(desktop, 'device-desktop', [
      '--origin-retired',
    ]);
    expect(caughtUp.code).toBe(0);
    expect(JSON.parse(caughtUp.stdout).custody).toBe('moved');
    expect(marker(desktop)).toBe('v2');
    expect((await inspectInstallationCustody(where)).status).toBe('in-custody');

    // Starting again retires the location again and restarts the clock, so
    // only a bundle exported after this point can complete the migration.
    const second = await beginCloudMigration({ ...where, target: 'per-user' });
    expect(second.status).toBe('in-progress');
    expect(second.installationId).toBe(first.installationId);
    expect(Date.parse(second.startedAt)).toBeGreaterThanOrEqual(
      Date.parse(first.startedAt),
    );
    expect((await inspectInstallationCustody(where)).status).toBe('retired');
    const refused = await h.run(desktop, 'device-desktop');
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('retired');
  });
});
