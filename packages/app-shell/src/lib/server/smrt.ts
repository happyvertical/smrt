/**
 * The shell's SMRT runtime: app-runtime local profile, smrt-users owner
 * sign-in (the desktop owner link creates the owner and signs them in; the
 * loopback `/setup` page serves the terminal flow), and the
 * shell's own first-run schema through the `prepareDatabase` hook.
 *
 * `PORT` and `SMRT_DATA_DIR` are honored (the desktop sidecar contract):
 * adapter-node reads `PORT`; the runtime reads `SMRT_DATA_DIR` for the data
 * root. The user app's files live under `<data root>/user-app`.
 *
 * The profile comes from smrt-config's runtime resolution (the `runtime`
 * block of smrt.config, else `local`). The shell supports two:
 *
 * - `local`: the desktop. One owner, SQLite, the data-root custody and lease.
 * - `cloud`: PostgreSQL (`DATABASE_URL`), accounts from the hosted identity
 *   provider (`routes/auth`), many owners each with their own app under
 *   `SMRT_APP_SHELL_DATA_ROOT`. The schema is made by `smrt db:migrate`, never
 *   at runtime. None of the desktop's own paths exist there (owner link,
 *   `/setup`, the local agent CLI and ChatGPT engines).
 *
 * `self-hosted` is not a shell profile; asking for it fails closed.
 */

import { mkdirSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createProviderReadinessProbe } from '@happyvertical/smrt-app-runtime';
import { createSmrtSvelteKitRuntime } from '@happyvertical/smrt-app-runtime/sveltekit';
import './registry.ts';
import '../objects/index.ts';
import { cloudAppDatabase as createCloudAppDatabase } from './app-database.ts';
import { cloudLimitsFromEnv } from './app-limits-env.ts';
import { installChangeFeedPolicy } from './change-feed.ts';
import {
  configureShell,
  type ShellContext,
  type ShellProfile,
  shellProfileSync,
} from './host.ts';
import { lifecycleFromEnv } from './host-lifecycle.ts';
import { installShellInference } from './inference.ts';
import { isMethodCodeEntitled } from './method-code.ts';
import { prepareShellSchema } from './schema.ts';
import { protectShellTables } from './shell-tenancy.ts';

export const runtime = createSmrtSvelteKitRuntime({
  providerReadiness: createProviderReadinessProbe,
  backgroundJobs: true,
  // Idempotent; creates the shell's tables (and the users/tenancy/profiles
  // tables) on an empty data directory. See schema.ts for the pending hook.
  prepareDatabase: async (db, context) => {
    // Only the local runtime creates schema. A deployed database is migrated
    // by `smrt db:migrate` and a missing table fails the startup check.
    if (!context || context.profile === 'local') await prepareShellSchema(db);
    // Cloud: the tables exist (migrated); put them under row-level security.
    else if (context.profile === 'cloud') await protectShellTables(db);
  },
  classOverrides: {},
});

/** The shell profile; anything but `local` and `cloud` is refused. */
async function profileOfRuntime(): Promise<ShellProfile> {
  const { profile } = await runtime.resolvedRuntime();
  if (profile === 'local' || profile === 'cloud') return profile;
  throw new Error('the app shell runs on the local or the cloud profile');
}

/**
 * Where every tenant's app data lives in the cloud profile: a directory the
 * operator configures, absolute, outside the source tree. There is no default
 * and no fallback to the working directory.
 */
function cloudDataRoot(): string {
  const root = process.env.SMRT_APP_SHELL_DATA_ROOT;
  if (!root || !isAbsolute(root))
    throw new Error('SMRT_APP_SHELL_DATA_ROOT must be an absolute path');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

/**
 * Cloud: every tenant's app data on the deployment's PostgreSQL, one schema per
 * app (`host.ts` names it from the tenant and app ids and asks this to create
 * it). The server is `DATABASE_URL`, the one the shell's own tables use; with
 * `SMRT_APP_SHELL_RUNTIME_DATABASE_URL` user operations run as that separate,
 * unprivileged login (`app-database.ts`). Absent (no URL), the apps stay SQLite
 * files under the data root.
 */
function cloudAppDatabase(): ShellContext['appDatabase'] {
  const url = process.env.DATABASE_URL;
  if (!url) return undefined;
  return createCloudAppDatabase({
    url,
    runtimeUrl: process.env.SMRT_APP_SHELL_RUNTIME_DATABASE_URL || undefined,
    admin: async () => (await runtime.deployedRuntime()).db,
  });
}

// Cloud only, and read lazily: the desktop never parses these variables.
const cloudLimits = cloudLimitsFromEnv(() => shellProfileSync());

configureShell({
  profile: profileOfRuntime,
  db: async () =>
    (await profileOfRuntime()) === 'cloud'
      ? (await runtime.deployedRuntime()).db
      : (await runtime.localRuntime()).db,
  dataRoot: async () =>
    (await profileOfRuntime()) === 'cloud'
      ? cloudDataRoot()
      : (await runtime.localRuntime()).paths.root,
  // Local: the vault-held key. Cloud: `SMRT_SECRET_MASTER_KEY` only (null).
  secretMasterKey: () => runtime.secretMasterKey(),
  // Hosted only (the desktop ignores it): how many apps this process keeps.
  lifecycle: lifecycleFromEnv(),
  // Cloud only: the operator's per-app caps and statement timeout (none set:
  // uncapped); a getter, so the profile is known when it is read.
  get workerLimits() {
    return cloudLimits.workerLimits;
  },
  appLimits: () => cloudLimits.appLimits(),
  // Cloud only (a holder with no tenant never asks): app-authored method code
  // needs the tenant's `app.methods` entitlement (#5194).
  methodCode: (tenantId) => isMethodCodeEntitled(tenantId),
  // Cloud only (a local owner's app is a file in the data root).
  appDatabase: cloudAppDatabase(),
});

// Keys saved in Settings and stored tier bindings apply to every inference
// call in this process, the assistant's included (lazy: nothing opens the
// database until the first request).
installShellInference();

installChangeFeedPolicy();
