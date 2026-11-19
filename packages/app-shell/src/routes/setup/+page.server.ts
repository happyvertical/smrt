import {
  createOwnerSetupPage,
  DEFAULT_OWNER_SETUP_MESSAGES,
} from '@happyvertical/smrt-app-runtime/sveltekit';

import { error } from '@sveltejs/kit';
import { isDesktopWrapper } from '$lib/server/desktop';
import { shellProfile } from '$lib/server/host';
import { runtime } from '$lib/server/smrt';

/**
 * Local-profile, loopback-only, single-use owner bootstrap for terminal use
 * (`smrt app setup` / `open` / `recover`). The runtime removes the hand-off
 * files once the claim commits. Under the desktop wrapper the owner link signs
 * the person in, so this page never sends them to a terminal command.
 */
const desktop = isDesktopWrapper();

const page = createOwnerSetupPage(runtime, {
  messages: desktop
    ? {
        setup_invalid:
          'This sign-in link is no longer valid. Quit and reopen the app.',
        setup_conflict:
          'A workspace for this app already exists. Quit and reopen the app.',
      }
    : DEFAULT_OWNER_SETUP_MESSAGES,
});

/** The local owner bootstrap does not exist in the cloud profile: a 404. */
async function localOnly(): Promise<void> {
  if ((await shellProfile()) !== 'local') error(404, 'Not found');
}

export const actions = {
  default: async (event: Parameters<typeof page.actions.default>[0]) => {
    await localOnly();
    return page.actions.default(event);
  },
};

export const load = async (event: Parameters<typeof page.load>[0]) => {
  await localOnly();
  return { ...(await page.load(event)), desktop };
};
