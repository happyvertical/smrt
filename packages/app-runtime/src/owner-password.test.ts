/** Fresh Vitest fork: no password service is created before the first claim. */
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PasswordCredentialService,
  PermissionCatalogService,
} from '@happyvertical/smrt-users';
import { expect, it } from 'vitest';
import { initializeLocalApplicationRuntime } from './index.js';

it('first password bootstrap grants management and shares the configured pepper and policy', async () => {
  expect(
    new PermissionCatalogService()
      .getRuntimePermissionDefinitions()
      .map((p) => p.slug),
  ).not.toContain('users.password.manage');
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'owner-password-first-')),
  );
  const sourceRoot = join(root, 'source');
  await mkdir(sourceRoot);
  const passwordPolicy = { pepper: 'test-only-owner-pepper', minLength: 24 };
  const initialized = await initializeLocalApplicationRuntime({
    appId: 'password-first',
    sourceRoot,
    dataDirectory: join(root, 'data'),
    passwordPolicy,
  });
  const { runtime } = initialized;
  try {
    // First successful claim: a failed retry must not warm the permission catalog.
    const claim = await runtime.claimOwner({
      token: initialized.bootstrap?.token as string,
      name: 'Owner',
      email: 'owner@example.com',
      password: 'a sufficiently long owner password',
    });
    const restored = await runtime.restoreSession(claim.sessionId);
    expect.soft(restored?.permissions).toContain('users.password.manage');
    const passwords = await PasswordCredentialService.create({
      db: runtime.db,
      password: passwordPolicy,
    });
    await expect(
      passwords.signIn({
        identifier: 'owner@example.com',
        password: 'a sufficiently long owner password',
        tenantId: 'unique-active-membership',
      }),
    ).resolves.toMatchObject({
      userId: claim.userId,
      tenantId: claim.tenantId,
    });
    expect(JSON.stringify(await runtime.diagnostics())).not.toContain(
      passwordPolicy.pepper,
    );
  } finally {
    await runtime.db.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

it('rolls back all owner records and token consumption when configured policy rejects', async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'owner-password-policy-')),
  );
  const sourceRoot = join(root, 'source');
  await mkdir(sourceRoot);
  const initialized = await initializeLocalApplicationRuntime({
    appId: 'password-policy',
    sourceRoot,
    dataDirectory: join(root, 'data'),
    passwordPolicy: { reject: () => 'Rejected by server policy' },
  });
  try {
    await expect(
      initialized.runtime.claimOwner({
        token: initialized.bootstrap?.token as string,
        name: 'Owner',
        email: 'owner@example.com',
        password: 'a sufficiently long owner password',
      }),
    ).rejects.toThrow('Rejected by server policy');
    for (const table of [
      'users',
      'profiles',
      'tenants',
      'memberships',
      'sessions',
      'users_password_credentials',
    ]) {
      const result = await initialized.runtime.db.query(
        `SELECT COUNT(*) AS count FROM ${table}`,
      );
      expect(Number(result.rows[0]?.count)).toBe(0);
    }
    expect((await initialized.runtime.diagnostics()).bootstrap.status).toBe(
      'available',
    );
  } finally {
    await initialized.runtime.db.close?.();
    await rm(root, { recursive: true, force: true });
  }
});
