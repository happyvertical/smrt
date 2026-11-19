import { createSessionLayoutLoad } from '@happyvertical/smrt-app-runtime/sveltekit';
import { redirect } from '@sveltejs/kit';
import {
  asSettingsOwner,
  assistantSettings,
} from '$lib/server/agent-cli/service';
import { shellProfile } from '$lib/server/host';
import { principalFromLocals } from '$lib/server/owner';
import { DEPENDS } from '$lib/ui/events';
import { isPluginRequest } from '$lib/ui/layout';
import { loadChanges, loadDescription } from '$lib/ui/load';
import { needsWelcome } from '$lib/ui/onboarding-client';
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
  event.depends(DEPENDS.changes);
  const { session } = sessionLoad(event);
  // As a plugin view in Claude, Codex or ChatGPT the shell has no chat of its
  // own (the host app is the chat).
  const embedded = isPluginRequest({
    secFetchDest: event.request.headers.get('sec-fetch-dest'),
    embed: event.url.searchParams.get('embed'),
  });
  if (!session.authenticated)
    return {
      session,
      description: null,
      changes: null,
      embedded,
      onboardingComplete: false,
    };
  // Check ownership before reading the saved copy. Signed-in members have no shell.
  const liveResult = await loadDescription(event.fetch, 'live');
  // Records and the structure the owner sees are always live: changes waiting
  // (#5178) never replace the view, they wait beside it.
  const result = liveResult;
  const liveDescription = liveResult.ok ? liveResult.description : null;
  const description = result.ok ? result.description : null;
  // The ONE source of the waiting count: the header pill, /changes and
  // History all read it from here.
  const changes = description ? await loadChanges(event.fetch) : null;
  // First run: an owner with an empty app who has not finished or skipped the
  // welcome steps is sent there once. An app that already has models is in
  // use, so it is never interrupted (the steps stay open from Settings).
  const owner = principalFromLocals(event.locals);
  let onboardingComplete = false;
  if (description && owner) {
    const settings = await asSettingsOwner(owner, () =>
      assistantSettings().read(),
    ).catch(() => null);
    onboardingComplete =
      settings?.onboarding != null ||
      Object.keys(description.models).length > 0;
    // The welcome steps connect a local AI tool or a ChatGPT plan; the hosted
    // app has neither, so nobody is sent there.
    if (
      settings &&
      (await shellProfile()) === 'local' &&
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
  return {
    session,
    description,
    liveDescription,
    changes,
    embedded,
    onboardingComplete,
  };
};
