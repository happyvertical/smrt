import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Person } from '@happyvertical/smrt-profiles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { snapshotObjectRegistryState } from '../../../core/src/test-utils.js';
import { initializeLocalApplicationRuntime } from '../index.js';

describe.each([
  false,
  true,
])('#4931 owner provisioning app replacement=%s', (replace) => {
  let restore: () => void;
  beforeEach(() => {
    restore = snapshotObjectRegistryState();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    restore();
  });

  it('constructs the effective Person inside the owner claim transaction', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'issue-4931-owner-')),
    );
    const sourceRoot = join(root, 'source');
    await mkdir(sourceRoot);
    const initialized = await initializeLocalApplicationRuntime({
      appId: 'issue-4931-owner',
      sourceRoot,
      dataDirectory: join(root, 'data'),
    });
    try {
      const expected = replace
        ? (await import('./issue-4931-app.fixture.js')).registerAppModels()
            .Person
        : Person;
      // Inspect at the first lifecycle boundary; rejecting here also verifies rollback.
      const stop = new Error('issue-4931-initialize-probe');
      const initialize = vi
        .spyOn(Person.prototype, 'initialize')
        .mockRejectedValue(stop);
      await expect(
        initialized.runtime.claimOwner({
          token: initialized.bootstrap?.token as string,
          name: 'Owner',
          email: 'owner@example.com',
        }),
      ).rejects.toBe(stop);
      expect(initialize).toHaveBeenCalledOnce();
      const person = initialize.mock.contexts[0];
      expect(person.constructor).toBe(expected);
      expect(person.options.db).not.toBe(initialized.runtime.db);
      expect(person.options.db).toHaveProperty('query');
      expect(person.options._skipLoad).toBe(true);
      expect(
        (await initialized.runtime.db.query('SELECT id FROM profiles')).rows,
      ).toHaveLength(0);
      expect((await initialized.runtime.diagnostics()).bootstrap.status).toBe(
        'available',
      );
    } finally {
      await initialized.runtime.db.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });
});
