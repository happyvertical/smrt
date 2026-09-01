import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
  prepareLocalDatabaseStorage,
  resolveLocalRuntimePaths,
} from '@happyvertical/smrt-app-runtime';
import {
  loadConfig,
  resolveConfiguredApplicationRuntime,
} from '@happyvertical/smrt-config';
import {
  prepareApplicationStateRoot,
  resolveApplicationId,
} from './smrt-runtime-identity.mjs';
import { withOperationLock } from './smrt-operation-lock.mjs';
import { readActiveWriterLease } from './smrt-writer-lease.mjs';

const sourceRoot = process.cwd();
try {
  process.loadEnvFile(join(sourceRoot, '.env'));
} catch (error) {
  if (
    !(
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    )
  ) {
    throw error;
  }
}
const packageJson = JSON.parse(
  readFileSync(join(sourceRoot, 'package.json'), 'utf8'),
);
const appId = resolveApplicationId({
  sourceRoot,
  packageName: packageJson.name,
  explicitId: process.env.SMRT_APP_ID,
});

await loadConfig({ cache: false });
const runtime = resolveConfiguredApplicationRuntime();
const stateRoot = prepareApplicationStateRoot({
  appId,
  dataDirectory: process.env.SMRT_DATA_DIR,
  sourceRoot,
});

await withOperationLock(stateRoot, 'db:migrate', async () => {
  const env = { ...process.env, SMRT_APP_ID: appId };
  if (runtime.profile === 'local') {
    if (readActiveWriterLease(stateRoot)) {
      throw new Error('Stop the local application before preparing its schema.');
    }
    const paths = resolveLocalRuntimePaths({
      appId,
      dataDirectory: process.env.SMRT_DATA_DIR,
      sourceRoot,
    });
    await prepareLocalDatabaseStorage({
      appId,
      dataDirectory: process.env.SMRT_DATA_DIR,
      sourceRoot,
    });
    env.DATABASE_TYPE = 'sqlite';
    env.DATABASE_URL = paths.database;
    env.SMRT_ASSETS_DIR = paths.assets;
  }
  const npmExecPath = process.env.npm_execpath;
  const packageManager =
    npmExecPath && basename(npmExecPath).toLowerCase().startsWith('pnpm')
      ? npmExecPath
      : null;
  const windowsFallback = !packageManager && process.platform === 'win32';
  const result = spawnSync(
    packageManager ? process.execPath : windowsFallback ? 'pnpm.cmd' : 'pnpm',
    packageManager
      ? [packageManager, 'exec', 'smrt', 'db:migrate']
      : ['exec', 'smrt', 'db:migrate'],
    {
      cwd: sourceRoot,
      env,
      shell: windowsFallback,
      stdio: 'inherit',
    },
  );
  if (result.error || result.status !== 0) {
    throw result.error || new Error('s-m-r-t database migration failed.');
  }
});
