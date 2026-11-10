import { createRuntimeHealthHandler } from '@happyvertical/smrt-app-runtime/sveltekit';

import { runtime } from '$lib/server/smrt';

/** Liveness; local responses add the identity `smrt app start` verifies. */
export const GET = createRuntimeHealthHandler(runtime);
