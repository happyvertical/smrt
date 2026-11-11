/** The existing template inference page, exposed as a controller-bound host mount. */

import type { SmrtRuntimeLocals } from '@happyvertical/smrt-app-runtime/sveltekit';
import type {
  InferenceSettingsController,
  InferenceSettingsOutcome,
} from '@happyvertical/smrt-inference/server';
import type { Actions, ServerLoad } from '@sveltejs/kit';
import { error, fail } from '@sveltejs/kit';

export interface SettingsSession {
  tenantId: string;
  userId: string;
  can(permission: string): boolean;
}
export const requireSettingsSession = (input: unknown): SettingsSession => {
  const locals = input as SmrtRuntimeLocals;
  if (!locals.user?.id || !locals.tenantId) error(401, 'Sign in required');
  const permissions = new Set(locals.permissions ?? []);
  return {
    tenantId: locals.tenantId,
    userId: locals.user.id,
    can: (permission) => permissions.has(permission),
  };
};
export async function readPayload<T>(request: Request): Promise<T> {
  const raw = (await request.formData()).get('payload');
  if (typeof raw !== 'string') error(400, 'Missing payload');
  try {
    return JSON.parse(raw) as T;
  } catch {
    error(400, 'Invalid payload');
  }
}

export function createInferenceSettingsPage(
  controller: InferenceSettingsController,
) {
  const inferenceSettingsController = () => controller;
  type Payload<K extends keyof InferenceSettingsController> = Parameters<
    InferenceSettingsController[K]
  >[1];

  /** An outcome from the controller as the page's action result. */
  function result<T extends Record<string, unknown>>(
    outcome: InferenceSettingsOutcome<T>,
  ) {
    if (outcome.ok) return outcome;
    return fail(outcome.status, { error: outcome.error });
  }

  const load = (async ({ locals, url, depends }) => {
    depends('smrt:inference-settings');
    const session = requireSettingsSession(locals);
    // No key is ever sent to the browser, only whether one is stored.
    return inferenceSettingsController().load(
      session,
      url.searchParams.get('by'),
    );
  }) satisfies ServerLoad;

  const actions: Actions = {
    saveDefaults: async ({ request, locals }) => {
      const session = requireSettingsSession(locals);
      const change = await readPayload<Payload<'saveDefaults'>>(request);
      return result(
        await inferenceSettingsController().saveDefaults(session, change),
      );
    },

    // Owner only: refused before the body is read; the key is stored through
    // the user resolver (as the `inference.provider-config` secret) and never
    // comes back to the browser.
    saveKey: async ({ request, locals }) => {
      const session = requireSettingsSession(locals);
      const controller = inferenceSettingsController();
      if (!controller.canCustomize(session)) {
        return fail(403, {
          error: 'You are not allowed to change this setting.',
        });
      }
      const change = await readPayload<Payload<'saveKey'>>(request);
      return result(await controller.saveKey(session, change));
    },

    saveTier: async ({ request, locals }) => {
      const session = requireSettingsSession(locals);
      const change = await readPayload<Payload<'saveTier'>>(request);
      return result(
        await inferenceSettingsController().saveTier(session, change),
      );
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
      return result(
        await inferenceSettingsController().saveAlias(session, change),
      );
    },

    saveFusion: async ({ request, locals }) => {
      const session = requireSettingsSession(locals);
      const change = await readPayload<Payload<'saveFusion'>>(request);
      return result(
        await inferenceSettingsController().saveFusion(session, change),
      );
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

  return { load, actions };
}
