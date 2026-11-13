import { OWNER_LINK_SECRET_ENV } from '@happyvertical/smrt-app-runtime/sveltekit';

/**
 * True when the app runs under the desktop wrapper, which gives the sidecar a
 * per-launch owner-link secret in its environment (only its presence is read
 * here). The desktop person is signed in by the owner link, so no page may
 * send them to a terminal command.
 */
export function isDesktopWrapper(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(env[OWNER_LINK_SECRET_ENV]);
}
