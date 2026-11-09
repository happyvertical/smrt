/**
 * Request foundation from `@happyvertical/smrt-app-runtime/sveltekit`: the
 * fail-closed startup gate (`init`) and the signed session that supplies the
 * owner's identity and tenant context. Configure the runtime in
 * `$lib/server/smrt`. The builder operations' generated REST routes are served
 * by `appsRestHandle` (approval gate, logged errors) after the session is set.
 */
import { sequence } from '@sveltejs/kit/hooks';
import { appsRestHandle } from '$lib/server/apps-rest';
import { runtime } from '$lib/server/smrt';

export const { init } = runtime;
export const handle = sequence(runtime.handle, appsRestHandle);
