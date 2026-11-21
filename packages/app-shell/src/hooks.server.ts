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
import { closeAllStreams } from '$lib/server/events';
import { drainShell, shellProfile } from '$lib/server/host';
import { shellImports, stopShellImports } from '$lib/server/import-runtime';
import {
  ensureOwnerHandoff,
  keepOwnerHandoffFresh,
} from '$lib/server/owner-handoff';
import { installShutdown } from '$lib/server/shutdown';
import { runtime } from '$lib/server/smrt';
import { storageMeteringHandle } from '$lib/server/storage-metering-handle';

export const init = async () => {
  await runtime.ready();
  // SIGTERM/SIGINT: stop accepting, drain every open app, exit (#5494). Not
  // under `vite dev` (vite owns its signals) or the build's analysis pass.
  if (!dev && !building)
    installShutdown({
      drain: drainShell,
      endStreams: closeAllStreams,
      stopWork: stopShellImports,
    });
  // The assistant's review of the changes waiting runs after the exact checks.
  installChangeReview();
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
