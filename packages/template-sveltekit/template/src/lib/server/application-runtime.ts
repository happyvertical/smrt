import {
  initializeDeployedApplicationRuntime,
  initializeLocalApplicationRuntime,
  projectRuntimeDiagnostics,
  resolveLocalRuntimePaths,
  type LocalApplicationRuntime,
  type RuntimeDiagnostics,
  type RuntimeDiagnosticsProjectionInput,
} from '@happyvertical/smrt-app-runtime';
import {
  loadConfig,
  resolveApplicationRuntime,
  resolveConfiguredApplicationRuntime,
} from '@happyvertical/smrt-config';
import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { getDatabase } from '@happyvertical/sql';
import {
  prepareApplicationStateRoot,
  resolveApplicationId,
  runtimeConfigurationFingerprint,
} from '../../../scripts/smrt-runtime-identity.mjs';
import { acquireWriterLease } from '../../../scripts/smrt-writer-lease.mjs';
import { createProviderReadinessProbe } from '../../../scripts/smrt-provider-readiness.mjs';

const loadedConfig = await loadConfig();

export const applicationRuntime = loadedConfig.runtime
  ? resolveConfiguredApplicationRuntime()
  : resolveApplicationRuntime({ profile: 'local' });
const appId = resolveApplicationId({
  sourceRoot: process.cwd(),
  explicitId: process.env.SMRT_APP_ID,
});

export const applicationRuntimeConfiguration = runtimeConfigurationFingerprint(
  applicationRuntime,
  process.env,
);

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
      readiness: createProviderReadinessProbe('authentication', {
        profile: applicationRuntime.profile,
        provider: authenticationProvider,
      }),
    },
    assets: {
      provider: applicationRuntime.providers.assets.provider,
      readiness: createProviderReadinessProbe('assets', {
        profile: applicationRuntime.profile,
        provider: applicationRuntime.providers.assets.provider,
      }),
    },
    secrets: {
      provider: applicationRuntime.providers.secrets.provider,
      readiness: createProviderReadinessProbe('secrets', {
        profile: applicationRuntime.profile,
        provider: applicationRuntime.providers.secrets.provider,
      }),
    },
  });
  await deployedRuntimePromise;
}

/** Local onboarding runtime. Deployed authentication belongs to its provider. */
export function getLocalApplicationRuntime(): Promise<LocalApplicationRuntime> {
  if (applicationRuntime.profile !== 'local') {
    throw new Error('Owner bootstrap is available only in the local profile.');
  }
  const bindHost =
    process.env.HOST ||
    (process.env.NODE_ENV === 'development' ? '127.0.0.1' : null);
  if (!bindHost) {
    throw new Error(
      'Local production startup requires an explicit loopback HOST; use pnpm app:start.',
    );
  }
  localWriterLease ??= acquireWriterLease(
    prepareApplicationStateRoot({
      appId,
      dataDirectory: process.env.SMRT_DATA_DIR,
      sourceRoot: process.cwd(),
    }),
    { operationInstance: process.env.SMRT_OPERATION_INSTANCE },
  );
  localRuntimePromise ??= initializeLocalApplicationRuntime({
    appId,
    dataDirectory: process.env.SMRT_DATA_DIR,
    sourceRoot: process.cwd(),
    bindHost,
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

export interface ApplicationRuntimeDiagnosticsOptions {
  readonly toolNames: readonly string[];
  readonly observedAt: Date;
  /** Application-owned schema verification seam; runtime liveness is not proof. */
  readonly schemaStatus?: 'not-ready' | 'ready' | 'unknown';
  /** Application-owned migration tracker seam; database liveness is not proof. */
  readonly migrationStatus?: 'current' | 'failed' | 'pending' | 'unknown';
  /** Bounded worker seam supplied by the deployment's lease/heartbeat adapter. */
  readonly workerHeartbeatAt?: Date | string | null;
  /** Stable code/timestamp pairs only; raw errors never cross this seam. */
  readonly recentErrors?: readonly {
    readonly code?: unknown;
    readonly at?: unknown;
  }[];
}

/**
 * Read the private runtime only after the route has authenticated and
 * authorized its caller, then immediately project onto the public allowlist.
 */
export async function readApplicationRuntimeDiagnostics(
  options: ApplicationRuntimeDiagnosticsOptions,
): Promise<RuntimeDiagnostics> {
  await ensureApplicationRuntimeReady();

  if (applicationRuntime.profile === 'local') {
    const runtime = await getLocalApplicationRuntime();
    const diagnostics = await runtime.diagnostics();
    return projectRuntimeDiagnostics({
      profile: 'local',
      health: 'healthy',
      schema: {
        status: options.schemaStatus ?? 'unknown',
        migrations: options.migrationStatus ?? 'unknown',
      },
      capabilities: {
        'asset-storage': 'available',
        authentication: 'available',
        'background-jobs': diagnostics.jobs.backgroundEnabled
          ? 'available'
          : 'disabled',
        database: 'available',
        'paid-capabilities': diagnostics.paidCapabilitiesEnabled
          ? 'available'
          : 'disabled',
        'secret-storage': 'available',
      },
      toolNames: options.toolNames,
      worker: {
        topology: diagnostics.jobs.topology,
        required: diagnostics.jobs.backgroundEnabled,
        heartbeatAt: options.workerHeartbeatAt,
      },
      recentErrors: options.recentErrors,
      observedAt: options.observedAt,
    });
  }

  const runtime = await deployedRuntimePromise;
  if (!runtime) throw new Error('deployed_runtime_unavailable');
  const readiness = await runtime.readiness();
  const componentStatus = (
    component: keyof typeof readiness.components,
  ): 'available' | 'unavailable' =>
    readiness.components[component].status === 'ready'
      ? 'available'
      : 'unavailable';
  const input: RuntimeDiagnosticsProjectionInput = {
    profile: applicationRuntime.profile,
    health:
      runtime.health().status === 'healthy'
        ? readiness.status === 'ready'
          ? 'healthy'
          : 'degraded'
        : 'stopped',
    schema: {
      status: options.schemaStatus ?? 'unknown',
      migrations: options.migrationStatus ?? 'unknown',
    },
    capabilities: {
      'asset-storage': componentStatus('assets'),
      authentication: componentStatus('authentication'),
      'background-jobs': 'available',
      database: componentStatus('database'),
      'paid-capabilities': 'unknown',
      'secret-storage': componentStatus('secrets'),
    },
    toolNames: options.toolNames,
    worker: {
      topology: runtime.resolvedRuntime.providers.jobs.topology,
      required: true,
      heartbeatAt: options.workerHeartbeatAt,
    },
    recentErrors: options.recentErrors,
    observedAt: options.observedAt,
  };
  return projectRuntimeDiagnostics(input);
}
