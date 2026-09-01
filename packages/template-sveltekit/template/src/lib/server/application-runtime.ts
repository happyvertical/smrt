import {
  initializeLocalApplicationRuntime,
  resolveLocalRuntimePaths,
  type LocalApplicationRuntime,
} from '@happyvertical/smrt-app-runtime';
import {
  loadConfig,
  resolveApplicationRuntime,
  resolveConfiguredApplicationRuntime,
} from '@happyvertical/smrt-config';
import type { SmrtClassOptions } from '@happyvertical/smrt-core';

const loadedConfig = await loadConfig();

export const applicationRuntime = loadedConfig.runtime
  ? resolveConfiguredApplicationRuntime()
  : resolveApplicationRuntime({ profile: 'local' });
const appId = String(process.env.SMRT_APP_ID || 'smrt-sveltekit-app')
  .toLowerCase()
  .replace(/[^a-z0-9._-]+/g, '-')
  .replace(/^-+|-+$/g, '');

export function getApplicationDatabaseConfig(): SmrtClassOptions['db'] {
  if (applicationRuntime.profile === 'local') {
    const paths = resolveLocalRuntimePaths({
      appId,
      dataDirectory: process.env.SMRT_DATA_DIR,
      sourceRoot: process.cwd(),
    });
    return { type: 'sqlite', url: paths.database };
  }
  if (!process.env.DATABASE_URL) {
    throw new Error(`${applicationRuntime.profile} requires DATABASE_URL.`);
  }
  return { type: 'postgres', url: process.env.DATABASE_URL };
}

let localRuntimePromise: Promise<LocalApplicationRuntime> | undefined;

/** Local onboarding runtime. Deployed authentication belongs to its provider. */
export function getLocalApplicationRuntime(): Promise<LocalApplicationRuntime> {
  if (applicationRuntime.profile !== 'local') {
    throw new Error('Owner bootstrap is available only in the local profile.');
  }
  localRuntimePromise ??= initializeLocalApplicationRuntime({
    appId,
    dataDirectory: process.env.SMRT_DATA_DIR,
    sourceRoot: process.cwd(),
    bindHost: process.env.HOST || '127.0.0.1',
    providers: {
      database: applicationRuntime.providers.database,
      authentication: applicationRuntime.providers.authentication,
      tenancy: applicationRuntime.providers.tenancy,
      assets: applicationRuntime.providers.assets,
      secrets: applicationRuntime.providers.secrets,
      jobs: applicationRuntime.providers.jobs,
      network: applicationRuntime.providers.network,
    },
    backgroundJobs: process.env.SMRT_BACKGROUND_JOBS === 'true',
  }).then(({ runtime }) => runtime);
  return localRuntimePromise;
}
