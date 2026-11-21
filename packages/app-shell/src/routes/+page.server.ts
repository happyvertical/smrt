import { cloudSignInHref } from '$lib/server/cloud-auth';
import { isDesktopWrapper } from '$lib/server/desktop';
import { shellProfile } from '$lib/server/host';
import { DEPENDS } from '$lib/ui/events';
import { loadRecords } from '$lib/ui/load';
import type { PageServerLoad } from './$types';

const COUNT_LIMIT = 1000;

export const load: PageServerLoad = async ({ parent, depends, fetch, url }) => {
  depends(DEPENDS.records);
  const { description, session } = await parent();
  // The hosted app's signed-out landing: sign in with an account (there is no
  // owner link or setup page there). Nothing is looked up for a signed-in visitor.
  const hosted =
    !session.authenticated &&
    (await shellProfile().then(
      (profile) => profile === 'cloud',
      () => false,
    ));
  const signIn = hosted ? await cloudSignInHref() : null;
  const counts: Record<string, { count: number; capped: boolean } | null> = {};
  if (description) {
    await Promise.all(
      Object.keys(description.models).map(async (model) => {
        try {
          const rows = await loadRecords(
            fetch,
            model,
            COUNT_LIMIT,
            description.mode,
          );
          counts[model] = {
            count: rows.length,
            capped: rows.length >= COUNT_LIMIT,
          };
        } catch {
          counts[model] = null;
        }
      }),
    );
  }
  // The signed-out card words its way back in differently under the wrapper.
  return {
    counts,
    desktop: isDesktopWrapper(),
    hosted,
    signIn,
    signInFailed: hosted && url.searchParams.get('signin') === 'failed',
  };
};
