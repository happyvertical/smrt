/**
 * The local profile's secrets master key, end to end below the route: the real
 * local runtime creates and keeps the key, a real `SecretService` seals and
 * reads a secret through `masterKeyProvider: () => runtime.secretMasterKey()`,
 * the key survives a reopen, and it never lands in the data root. (The
 * inference settings flow over the same provider is covered in
 * smrt-inference with a stand-in runtime.)
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
} from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeLocalApplicationRuntime } from '@happyvertical/smrt-app-runtime';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import {
  Secret,
  SecretAuditLog,
  SecretService,
  TenantKey,
} from '@happyvertical/smrt-secrets';
import { enableTenancy, withTenant } from '@happyvertical/smrt-tenancy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '33333333-3333-4333-8333-333333333333';
const here = dirname(fileURLToPath(import.meta.url));
const secretsManifest = JSON.parse(
  readFileSync(resolve(here, '../../../../secrets/dist/manifest.json'), 'utf8'),
);
const registrationManifest = {
  ...secretsManifest,
  objects: {
    Secret: secretsManifest.objects['@happyvertical/smrt-secrets:Secret'],
    SecretAuditLog:
      secretsManifest.objects['@happyvertical/smrt-secrets:SecretAuditLog'],
    TenantKey: secretsManifest.objects['@happyvertical/smrt-secrets:TenantKey'],
  },
};

describe('local-profile secrets master key', () => {
  let root: string;
  let legacyLease: string;
  const previous = process.env.SMRT_SECRET_MASTER_KEY;
  const previousKeychain = process.env.SMRT_DESKTOP_KEYCHAIN;

  beforeEach(async () => {
    // Never the real keychain, and no ambient master key.
    delete process.env.SMRT_SECRET_MASTER_KEY;
    delete process.env.SMRT_DESKTOP_KEYCHAIN;
    enableTenancy();
    for (const [name, ctor] of [
      ['Secret', Secret],
      ['SecretAuditLog', SecretAuditLog],
      ['TenantKey', TenantKey],
    ] as const) {
      ObjectRegistry.register(ctor, {
        name,
        packageName: '@happyvertical/smrt-secrets',
        _manifest: registrationManifest,
      });
    }
    root = await realpath(await mkdtemp(join(tmpdir(), 'smrt-shell-amk-')));
    const identity = join(root, 'data');
    const key = createHash('sha256')
      .update(
        platform() === 'darwin' || platform() === 'win32'
          ? identity.toLowerCase()
          : identity,
      )
      .digest('hex')
      .slice(0, 32);
    legacyLease = join(
      await realpath('/tmp'),
      `.smrt-${process.getuid?.()}`,
      key,
    );
    await mkdir(join(root, 'source'));
  });

  afterEach(async () => {
    if (previous !== undefined) process.env.SMRT_SECRET_MASTER_KEY = previous;
    if (previousKeychain !== undefined) {
      process.env.SMRT_DESKTOP_KEYCHAIN = previousKeychain;
    }
    await rm(legacyLease, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  const open = () =>
    initializeLocalApplicationRuntime({
      appId: 'shell-amk',
      sourceRoot: join(root, 'source'),
      dataDirectory: join(root, 'data'),
    });

  it('seals a secret under a key the runtime keeps outside the data root, across a reopen', async () => {
    const { runtime } = await open();
    const db = await getTestDatabase();
    const secrets = await SecretService.create({
      db,
      masterKeyProvider: () =>
        runtime.secretMasterKey?.() ?? Promise.resolve(null),
    });
    const value = `sk-test-${randomBytes(8).toString('hex')}`;
    await withTenant({ tenantId: TENANT, userId: USER }, async () => {
      await secrets.store('provider-key', value, {
        category: 'inference.test',
      });
      expect((await secrets.retrieve('provider-key')).value).toBe(value);
    });

    const key = (await runtime.secretMasterKey?.()) as string;
    expect(key).toMatch(/^[0-9a-f]{64}$/);

    // The key is in a sibling of the data root, never inside it.
    const inRoot = async (directory: string): Promise<string[]> => {
      const found: string[] = [];
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) found.push(...(await inRoot(path)));
        else found.push(path);
      }
      return found;
    };
    for (const file of await inRoot(join(root, 'data'))) {
      expect((await readFile(file)).toString('hex')).not.toContain(key);
      expect((await readFile(file)).toString('utf8')).not.toContain(key);
    }
    expect(await readdir(root)).toContain('.smrt-keys-data');

    // A reopened runtime loads the same key and reads the same secret.
    const reopened = (await open()).runtime;
    expect(await reopened.secretMasterKey?.()).toBe(key);
    const again = await SecretService.create({
      db,
      masterKeyProvider: () =>
        reopened.secretMasterKey?.() ?? Promise.resolve(null),
    });
    await withTenant({ tenantId: TENANT, userId: USER }, async () => {
      expect((await again.retrieve('provider-key')).value).toBe(value);
    });
  });
});
