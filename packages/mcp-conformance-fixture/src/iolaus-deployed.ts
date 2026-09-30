import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getFilesystem } from '@happyvertical/files';
import { initializeDeployedApplicationRuntime } from '@happyvertical/smrt-app-runtime';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';

/** Synthetic local provider bindings exercise the deployed composition, not deployment. */
export async function initializeIolausSelfHosted(options: {
  root: string;
  authenticate: () => Promise<boolean>;
  prepareDatabase: (db: DatabaseInterface) => Promise<void>;
}) {
  const assetsPath = join(options.root, 'provider-assets');
  await mkdir(assetsPath);
  const assets = await getFilesystem({ type: 'local', basePath: assetsPath });
  const secretPath = join(options.root, 'provider-secret.json');
  await writeFile(secretPath, JSON.stringify({ synthetic: true }), {
    mode: 0o600,
  });
  const runtime = await initializeDeployedApplicationRuntime({
    profile: 'self-hosted',
    providers: {
      tenancy: { mode: 'multi-tenant', context: 'required' },
      assets: { provider: 'local-files' },
      secrets: { provider: 'local-file' },
    },
    database: {
      engine: 'postgres',
      connect: () =>
        getDatabase({
          type: 'postgres',
          url: process.env.SMRT_TEST_POSTGRES_URL,
          dbid: randomUUID(),
        }),
      close: async (db) => {
        await db.close?.();
      },
    },
    authentication: {
      provider: 'oidc',
      readiness: async () => {
        if (!(await options.authenticate()))
          throw new Error('Authentication unavailable');
      },
    },
    assets: {
      provider: 'local-files',
      readiness: async () => {
        const path = `probe-${randomUUID()}`;
        await assets.write(path, 'synthetic');
        try {
          if (String(await assets.read(path)) !== 'synthetic')
            throw new Error('Asset unavailable');
        } finally {
          await assets.delete(path);
        }
      },
    },
    secrets: {
      provider: 'local-file',
      readiness: async () => {
        if (((await stat(secretPath)).mode & 0o777) !== 0o600)
          throw new Error('Unsafe secret permissions');
        if (JSON.parse(await readFile(secretPath, 'utf8')).synthetic !== true)
          throw new Error('Secret unavailable');
      },
    },
    prepareDatabase: options.prepareDatabase,
  });
  return { runtime, secretPath };
}
