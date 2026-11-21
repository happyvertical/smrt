/**
 * Request foundation from `@happyvertical/smrt-app-runtime/sveltekit`: the
 * fail-closed startup gate (`init`) and the signed session that supplies the
 * owner's identity and tenant context. Configure the runtime in
 * `$lib/server/smrt`. The builder operations' generated REST routes are served
 * by `appsRestHandle` (approval gate, logged errors) after the session is set.
 */
import { sequence } from '@sveltejs/kit/hooks';
import { appsRestHandle } from '$lib/server/apps-rest';
import { installChangeReview } from '$lib/server/change-review';
import { shellProfile } from '$lib/server/host';
import { installHostedInferenceGate } from '$lib/server/hosted-inference';
import { shellImports } from '$lib/server/import-runtime';
import {
  ensureOwnerHandoff,
  keepOwnerHandoffFresh,
} from '$lib/server/owner-handoff';
import { runtime } from '$lib/server/smrt';

export const init = async () => {
  await runtime.ready();
  // The assistant's review of the changes waiting runs after the exact checks.
  installChangeReview();
  // Hosted: the hosted inference gate is registered, or the server does not
  // start (#5194). The desktop never registers one.
  await installHostedInferenceGate({
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
export const handle = sequence(runtime.handle, appsRestHandle);
