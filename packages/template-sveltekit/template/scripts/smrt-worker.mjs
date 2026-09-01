#!/usr/bin/env node

import { initializeDeployedApplicationRuntime } from '@happyvertical/smrt-app-runtime';
import {
  loadConfig,
  resolveConfiguredApplicationRuntime,
} from '@happyvertical/smrt-config';
import { getDatabase } from '@happyvertical/sql';
import { createProviderReadinessProbe } from './smrt-provider-readiness.mjs';

await loadConfig({ cache: false });
const configured = resolveConfiguredApplicationRuntime();
if (configured.profile === 'local') {
  throw new Error('Local jobs run inline or embedded; a separate worker requires self-hosted or cloud.');
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');

const runtime = await initializeDeployedApplicationRuntime({
  profile: configured.profile,
  providers: {
    database: configured.providers.database,
    authentication: configured.providers.authentication,
    tenancy: configured.providers.tenancy,
    assets: configured.providers.assets,
    secrets: configured.providers.secrets,
    jobs: configured.providers.jobs,
    network: configured.providers.network,
  },
  database: {
    engine: 'postgres',
    connect: () =>
      getDatabase({ type: 'postgres', url: process.env.DATABASE_URL }),
    close: async (db) => db.close?.(),
  },
  authentication: {
    provider: configured.providers.authentication.provider,
    readiness: createProviderReadinessProbe('authentication', {
      profile: configured.profile,
      provider: configured.providers.authentication.provider,
    }),
  },
  assets: {
    provider: configured.providers.assets.provider,
    readiness: createProviderReadinessProbe('assets', {
      profile: configured.profile,
      provider: configured.providers.assets.provider,
    }),
  },
  secrets: {
    provider: configured.providers.secrets.provider,
    readiness: createProviderReadinessProbe('secrets', {
      profile: configured.profile,
      provider: configured.providers.secrets.provider,
    }),
  },
});

const kind = process.argv[2] || 'task';
const runner =
  kind === 'schedule'
    ? await runtime.createScheduleWorker()
    : await runtime.createTaskWorker({
        concurrency: Number.parseInt(
          process.env.SMRT_WORKER_CONCURRENCY || '4',
          10,
        ),
      });

await runner.start();
console.log(
  JSON.stringify({
    schemaVersion: 1,
    status: 'ready',
    kind,
    secretValuesIncluded: false,
  }),
);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await runtime.close();
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
