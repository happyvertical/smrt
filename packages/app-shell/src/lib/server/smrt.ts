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
import './inference-registry.ts';
import '../objects/index.ts';
import { installChangeFeedPolicy } from './change-feed.ts';
import { configureShell } from './host.ts';
import { installShellInference } from './inference.ts';
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
  secretMasterKey: () => runtime.secretMasterKey(),
});

// Keys saved in Settings and stored tier bindings apply to every inference
// call in this process, the assistant's included (lazy: nothing opens the
// database until the first request).
installShellInference();

installChangeFeedPolicy();
