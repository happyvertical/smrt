/**
 * The shell's SMRT runtime: app-runtime local profile, smrt-users owner
 * sign-in (the owner is created on the loopback `/setup` page), and the
 * shell's own first-run schema through the `prepareDatabase` hook.
 *
 * `PORT` and `SMRT_DATA_DIR` are honored (the desktop sidecar contract):
 * adapter-node reads `PORT`; the runtime reads `SMRT_DATA_DIR` for the data
 * root. The user app's files live under `<data root>/user-app`.
 */
import { createProviderReadinessProbe } from '@happyvertical/smrt-app-runtime';
import { createSmrtSvelteKitRuntime } from '@happyvertical/smrt-app-runtime/sveltekit';
import '../models/index.ts';
import { installChangeFeedPolicy } from './change-feed.ts';
import { configureShell } from './host.ts';
import { prepareShellSchema } from './schema.ts';

export const runtime = createSmrtSvelteKitRuntime({
  providerReadiness: createProviderReadinessProbe,
  // Idempotent; creates the shell's tables (and the users/tenancy/profiles
  // tables) on an empty data directory. See schema.ts for the pending hook.
  prepareDatabase: async (db) => {
    await prepareShellSchema(db);
  },
  classOverrides: {},
});

configureShell({
  db: async () => (await runtime.localRuntime()).db,
  dataRoot: async () => (await runtime.localRuntime()).paths.root,
});

installChangeFeedPolicy();
