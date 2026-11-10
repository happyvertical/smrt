import type { InferenceSettingsOutcome } from '@happyvertical/smrt-inference/server';
import { fail } from '@sveltejs/kit';
import {
  inferenceSettingsController,
  readPayload,
  requireSettingsSession,
} from '$lib/server/settings';
import type { Actions, PageServerLoad } from './$types';

type Payload<K extends keyof ReturnType<typeof inferenceSettingsController>> =
  Parameters<ReturnType<typeof inferenceSettingsController>[K]>[1];

/** An outcome from the controller as the page's action result. */
function result<T extends Record<string, unknown>>(
  outcome: InferenceSettingsOutcome<T>,
) {
  if (outcome.ok) return outcome;
  return fail(outcome.status, { error: outcome.error });
}

export const load: PageServerLoad = async ({ locals, url, depends }) => {
  depends('smrt:inference-settings');
  const session = requireSettingsSession(locals);
  // No key is ever sent to the browser, only whether one is stored.
  return inferenceSettingsController().load(session, url.searchParams.get('by'));
};

export const actions: Actions = {
  saveDefaults: async ({ request, locals }) => {
    const session = requireSettingsSession(locals);
    const change = await readPayload<Payload<'saveDefaults'>>(request);
    return result(await inferenceSettingsController().saveDefaults(session, change));
  },

  // Owner only: refused before the body is read; the key is stored through
  // the user resolver (as the `inference.provider-config` secret) and never
  // comes back to the browser.
  saveKey: async ({ request, locals }) => {
    const session = requireSettingsSession(locals);
    const controller = inferenceSettingsController();
    if (!controller.canCustomize(session)) {
      return fail(403, { error: 'You are not allowed to change this setting.' });
    }
    const change = await readPayload<Payload<'saveKey'>>(request);
    return result(await controller.saveKey(session, change));
  },

  saveTier: async ({ request, locals }) => {
    const session = requireSettingsSession(locals);
    const change = await readPayload<Payload<'saveTier'>>(request);
    return result(await inferenceSettingsController().saveTier(session, change));
  },

  saveDefaultTier: async ({ request, locals }) => {
    const session = requireSettingsSession(locals);
    const change = await readPayload<Payload<'saveDefaultTier'>>(request);
    return result(
      await inferenceSettingsController().saveDefaultTier(session, change),
    );
  },

  saveAlias: async ({ request, locals }) => {
    const session = requireSettingsSession(locals);
    const change = await readPayload<Payload<'saveAlias'>>(request);
    return result(await inferenceSettingsController().saveAlias(session, change));
  },

  saveFusion: async ({ request, locals }) => {
    const session = requireSettingsSession(locals);
    const change = await readPayload<Payload<'saveFusion'>>(request);
    return result(await inferenceSettingsController().saveFusion(session, change));
  },

  saveTranscripts: async ({ request, locals }) => {
    const session = requireSettingsSession(locals);
    const change = await readPayload<Payload<'saveTranscripts'>>(request);
    return result(
      await inferenceSettingsController().saveTranscripts(session, change),
    );
  },

  // Probes return a key-free result; they write nothing.
  testConnection: async ({ request, locals }) => {
    const session = requireSettingsSession(locals);
    const input = await readPayload<Payload<'testConnection'>>(request);
    return result(
      await inferenceSettingsController().testConnection(session, input),
    );
  },

  testCandidate: async ({ request, locals }) => {
    const session = requireSettingsSession(locals);
    const candidate = await readPayload<Payload<'testCandidate'>>(request);
    return result(
      await inferenceSettingsController().testCandidate(session, candidate),
    );
  },

  discoverModels: async ({ locals }) => {
    const session = requireSettingsSession(locals);
    return inferenceSettingsController().discoverModels(session);
  },
};
