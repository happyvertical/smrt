import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { resolveApplicationStateRoot } from '@happyvertical/smrt-app-runtime';
import { createOwnerSetupPage } from '@happyvertical/smrt-app-runtime/sveltekit';

import { runtime } from '$lib/server/smrt';

/** Local-profile, loopback-only, single-use owner bootstrap. */
export const { load, actions } = createOwnerSetupPage(runtime, {
  // `pnpm app:setup` leaves the invitation in mode-0600 handoff files; once
  // the owner exists they only hold a token that now fails closed.
  onOwnerClaimed() {
    const stateRoot = resolveApplicationStateRoot({
      appId: runtime.applicationId(),
      dataDirectory: process.env.SMRT_DATA_DIR,
      sourceRoot: process.cwd(),
    });
    for (const file of ['onboarding.json', 'onboarding-launch.html']) {
      rmSync(join(stateRoot, file), { force: true });
    }
  },
});
