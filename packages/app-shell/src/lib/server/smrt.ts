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
import { installChangeFeedPolicy } from './change-feed.ts';
import { configureShell, type ShellProfile } from './host.ts';
import { installShellInference } from './inference.ts';
import { prepareShellSchema } from './schema.ts';

export const runtime = createSmrtSvelteKitRuntime({
  providerReadiness: createProviderReadinessProbe,
  backgroundJobs: true,
  // Idempotent; creates the shell's tables (and the users/tenancy/profiles
  // tables) on an empty data directory. See schema.ts for the pending hook.
  prepareDatabase: async (db, context) => {
    // Only the local runtime creates schema. A deployed database is migrated
    // by `smrt db:migrate` and a missing table fails the startup check.
    if (!context || context.profile === 'local') await prepareShellSchema(db);
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
});

// Keys saved in Settings and stored tier bindings apply to every inference
// call in this process, the assistant's included (lazy: nothing opens the
// database until the first request).
installShellInference();

installChangeFeedPolicy();
