import { createSessionLayoutLoad } from '@happyvertical/smrt-app-runtime/sveltekit';
import { redirect } from '@sveltejs/kit';
import {
  asSettingsOwner,
  assistantSettings,
} from '$lib/server/agent-cli/service';
import { principalFromLocals } from '$lib/server/owner';
import { api } from '$lib/ui/api';
import { DEPENDS } from '$lib/ui/events';
import { isPluginRequest } from '$lib/ui/layout';
import { loadDescription } from '$lib/ui/load';
import { needsWelcome } from '$lib/ui/onboarding-client';
import type { DraftInfo, Target } from '$lib/ui/types';
import type { LayoutServerLoad } from './$types';

/**
 * Server-owned session summary (whether a user is signed in, the tenant the
 * session authorizes) plus the app's description for the owner. The menu, the
 * approvals badge and every page read the description from here; the live
 * store invalidates `smrt:shell` when it changes.
 */
const sessionLoad = createSessionLayoutLoad();

export const load: LayoutServerLoad = async (event) => {
  event.depends(DEPENDS.shell);
  const { session } = sessionLoad(event);
  // As a plugin view in Claude, Codex or ChatGPT the shell has no chat of its
  // own (the host app is the chat).
  const embedded = isPluginRequest({
    secFetchDest: event.request.headers.get('sec-fetch-dest'),
    embed: event.url.searchParams.get('embed'),
  });
  if (!session.authenticated) return { session, description: null, embedded };
  // Check ownership before reading the saved copy. Signed-in members have no shell.
  const liveResult = await loadDescription(event.fetch, 'live');
  const draftState = liveResult.ok
    ? (
        await api<{ draft: DraftInfo | null; view: Target }>(
          '/api/shell/draft',
          { fetch: event.fetch },
        )
      ).data
    : { draft: null, view: 'live' as const };
  const result =
    draftState.view === 'draft' && draftState.draft?.publishable
      ? await loadDescription(event.fetch, 'draft')
      : liveResult;
  const liveDescription = liveResult.ok ? liveResult.description : null;
  const description = result.ok ? result.description : null;
  // First run: an owner with an empty app who has not finished or skipped the
  // welcome steps is sent there once. An app that already has models is in
  // use, so it is never interrupted (the steps stay open from Settings).
  const owner = principalFromLocals(event.locals);
  if (description && owner) {
    const settings = await asSettingsOwner(owner, () =>
      assistantSettings().read(),
    ).catch(() => null);
    if (
      settings &&
      needsWelcome({
        pathname: event.url.pathname,
        modelCount: Object.keys(description.models).length,
        onboarding: settings.onboarding,
      })
    )
      // The embed flag survives the redirect (the iframe header does anyway).
      redirect(
        303,
        event.url.searchParams.get('embed') === 'plugin'
          ? '/welcome?embed=plugin'
          : '/welcome',
      );
  }
  return { session, description, liveDescription, embedded };
};
