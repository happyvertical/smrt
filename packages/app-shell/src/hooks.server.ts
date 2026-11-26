/**
 * Request foundation from `@happyvertical/smrt-app-runtime/sveltekit`: the
 * fail-closed startup gate (`init`) and the signed session that supplies the
 * owner's identity and tenant context. Configure the runtime in
 * `$lib/server/smrt`. The builder operations' generated REST routes are served
 * by `appsRestHandle` (approval gate, logged errors) after the session is set.
 */

import { sequence } from '@sveltejs/kit/hooks';
import { building, dev } from '$app/environment';
import { appsRestHandle } from '$lib/server/apps-rest';
import { installChangeReview } from '$lib/server/change-review';
import { registerEmbeddedDrain } from '$lib/server/embed-slot';
import { closeAllStreams } from '$lib/server/events';
import { drainShell, shellProfile } from '$lib/server/host';
import { installHostedInferenceGate } from '$lib/server/hosted-inference';
import {
  installHostedProvisioning,
  stopHostedProvisioning,
} from '$lib/server/hosted-provisioning';
import { shellImports, stopShellImports } from '$lib/server/import-runtime';
import { installMethodCodeGate } from '$lib/server/method-code';
import { runOperatorCommand } from '$lib/server/operator';
import {
  ensureOwnerHandoff,
  keepOwnerHandoffFresh,
} from '$lib/server/owner-handoff';
import { createDrain } from '$lib/server/shutdown';
import { runtime } from '$lib/server/smrt';
import { storageMeteringHandle } from '$lib/server/storage-metering-handle';

export const init = async () => {
  await runtime.ready();
  // The ordered drain (end streams, wait for imports, close every open app),
  // handed to whoever owns the listener through the build's entries: `./start`
  // wires it to SIGTERM/SIGINT and exits (#5494); `./embed` returns it to a
  // host that owns its own listener, signals and exit (#5546). This file
  // installs no signal handler. Not under `vite dev` (vite owns its signals)
  // or the build's analysis pass.
  if (!dev && !building)
    registerEmbeddedDrain(
      createDrain({
        drain: drainShell,
        endStreams: closeAllStreams,
        stopWork: async () => {
          stopHostedProvisioning();
          await stopShellImports();
        },
      }),
      // One-shot operator commands (`smrt-app-shell migrate-to-postgres`,
      // #5193), run by `build/operator.js` inside this bundle.
      {
        run: (argv) =>
          runOperatorCommand(argv, {
            out: (line) => process.stdout.write(`${line}\n`),
            err: (line) => process.stderr.write(`${line}\n`),
          }),
      },
    );
  // The assistant's review of the changes waiting runs after the exact checks.
  installChangeReview();
  // Hosted: the hosted inference gate is registered, or the server does not
  // start (#5194). The desktop never registers one.
  await installHostedInferenceGate({
    db: async () => (await runtime.deployedRuntime()).db,
  });
  // Plan changes provision or revoke the members' hosted keys, where the
  // operator configured a gateway (#5194). Inert otherwise and on the desktop.
  await installHostedProvisioning({
    db: async () => (await runtime.deployedRuntime()).db,
  });
  // Hosted: app-authored method code runs only for a tenant whose plan grants
  // it (#5194); the check is built here or the server does not start.
  await installMethodCodeGate({
    db: async () => (await runtime.deployedRuntime()).db,
  });
  // The hosted app has no owner link to hand off and no embedded job runner
  // for workbook imports (both are the desktop's): neither starts there.
  if ((await shellProfile()) === 'cloud') return;
  // First start: leave the one-time owner link for `smrt app open` (#5165).
  // Also renew a link an earlier boot or `smrt app setup` saved, while no owner has claimed it.
  await ensureOwnerHandoff(runtime);
  keepOwnerHandoffFresh(runtime);
  await shellImports().catch(() => {
    process.stderr.write(
      'Workbook imports are unavailable. Opening Import will try again.\n',
    );
  });
};
export const handle = sequence(
  runtime.handle,
  storageMeteringHandle,
  appsRestHandle,
);
