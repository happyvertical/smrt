import {
  createOwnerSetupPage,
  DEFAULT_OWNER_SETUP_MESSAGES,
} from '@happyvertical/smrt-app-runtime/sveltekit';

import { isDesktopWrapper } from '$lib/server/desktop';
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

export const actions = page.actions;

export const load = async (event: Parameters<typeof page.load>[0]) => ({
  ...(await page.load(event)),
  desktop,
});
