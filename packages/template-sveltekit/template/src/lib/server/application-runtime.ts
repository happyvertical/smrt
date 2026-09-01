import {
  initializeDeployedApplicationRuntime,
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
import { getDatabase } from '@happyvertical/sql';
import {
  resolveApplicationId,
  resolveApplicationStateRoot,
} from '../../../scripts/smrt-runtime-identity.mjs';
import { acquireWriterLease } from '../../../scripts/smrt-writer-lease.mjs';

const loadedConfig = await loadConfig();

export const applicationRuntime = loadedConfig.runtime
  ? resolveConfiguredApplicationRuntime()
  : resolveApplicationRuntime({ profile: 'local' });
const appId = resolveApplicationId({
  sourceRoot: process.cwd(),
  explicitId: process.env.SMRT_APP_ID,
});

export function getApplicationDatabaseConfig(): SmrtClassOptions['db'] {
  if (applicationRuntime.profile === 'local') {
    const paths = resolveLocalRuntimePaths({
      appId,
      dataDirectory: process.env.SMRT_DATA_DIR,
      sourceRoot: process.cwd(),
    });
    return { type: 'sqlite', url: paths.database };
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(`${applicationRuntime.profile} requires DATABASE_URL.`);
  }
  return { type: 'postgres', url: databaseUrl };
}

let localRuntimePromise: Promise<LocalApplicationRuntime> | undefined;
let localWriterLease: { release(): void } | undefined;
let deployedRuntimePromise: ReturnType<
  typeof initializeDeployedApplicationRuntime
> | undefined;

function requireProviderSetting(name: string): () => Promise<void> {
  return async () => {
    if (!process.env[name]) throw new Error(`${name} is not configured.`);
  };
}

/** Fail-closed startup gate for every deployed web process. */
export async function ensureApplicationRuntimeReady(): Promise<void> {
  if (applicationRuntime.profile === 'local') {
    await getLocalApplicationRuntime();
    return;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(`${applicationRuntime.profile} requires DATABASE_URL.`);
  }
  const authenticationProvider =
    applicationRuntime.providers.authentication.provider;
  if (authenticationProvider === 'owner-bootstrap') {
    throw new Error('Deployed profiles require public authentication.');
  }
  deployedRuntimePromise ??= initializeDeployedApplicationRuntime({
    profile: applicationRuntime.profile,
    providers: {
      database: applicationRuntime.providers.database,
      authentication: applicationRuntime.providers.authentication,
      tenancy: applicationRuntime.providers.tenancy,
      assets: applicationRuntime.providers.assets,
      secrets: applicationRuntime.providers.secrets,
      jobs: applicationRuntime.providers.jobs,
      network: applicationRuntime.providers.network,
    },
    database: {
      engine: 'postgres',
      connect: () => getDatabase({ type: 'postgres', url: databaseUrl }),
      close: async (db) => db.close?.(),
    },
    authentication: {
      provider: authenticationProvider,
      readiness: requireProviderSetting('SMRT_AUTH_READY'),
    },
    assets: {
      provider: applicationRuntime.providers.assets.provider,
      readiness: requireProviderSetting('SMRT_ASSETS_READY'),
    },
    secrets: {
      provider: applicationRuntime.providers.secrets.provider,
      readiness: requireProviderSetting('SMRT_SECRETS_READY'),
    },
  });
  await deployedRuntimePromise;
}

/** Local onboarding runtime. Deployed authentication belongs to its provider. */
export function getLocalApplicationRuntime(): Promise<LocalApplicationRuntime> {
  if (applicationRuntime.profile !== 'local') {
    throw new Error('Owner bootstrap is available only in the local profile.');
  }
  localWriterLease ??= acquireWriterLease(
    resolveApplicationStateRoot({
      appId,
      explicitStateDirectory: process.env.SMRT_STATE_DIR,
    }),
  );
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
  })
    .then(({ runtime }) => runtime)
    .catch((error) => {
      localWriterLease?.release();
      localWriterLease = undefined;
      localRuntimePromise = undefined;
      throw error;
    });
  return localRuntimePromise;
}
