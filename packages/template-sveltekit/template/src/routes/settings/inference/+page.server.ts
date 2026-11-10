import {
  APP_INFERENCE_SCOPE_ID,
  CUSTOMIZE_INFERENCE_PERMISSION,
  createInferencePreferences,
  type InferenceMode,
  type InferenceUsageReportDimension,
  PERSONALIZE_INFERENCE_PERMISSION,
} from '@happyvertical/smrt-inference/server';
import { fail } from '@sveltejs/kit';
import {
  type InferenceKeyPayload,
  inferenceKeyIsSet,
  saveInferenceKey,
} from '$lib/server/inference-keys';
import {
  inferencePreferenceStore,
  inferenceSettingsService,
  inferenceUserResolver,
  readPayload,
  requireSettingsSession,
  type SettingsLocals,
  type SettingsSession,
  settingsFailure,
} from '$lib/server/settings';
import type { Actions, PageServerLoad } from './$types';

const USAGE_DIMENSIONS: readonly InferenceUsageReportDimension[] = [
  'model',
  'tier',
  'prompt',
  'fusion',
  'template',
];

function scopeOf(session: SettingsSession, scope: 'app' | 'tenant') {
  return scope === 'tenant'
    ? { scopeType: 'tenant' as const, scopeId: session.tenantId }
    : { scopeType: 'app' as const, scopeId: APP_INFERENCE_SCOPE_ID };
}

/** Run one write; a refusal comes back as a `fail()` the page shows inline. */
async function write(
  locals: SettingsLocals,
  run: (
    service: Awaited<ReturnType<typeof inferenceSettingsService>>,
    session: SettingsSession,
  ) => Promise<unknown>,
) {
  const session = requireSettingsSession(locals);
  try {
    const service = await inferenceSettingsService(
      session,
      CUSTOMIZE_INFERENCE_PERMISSION,
    );
    await run(service, session);
  } catch (cause) {
    const failure = settingsFailure(cause);
    return fail(failure.status, { error: failure.error });
  }
  return { message: 'Saved.' };
}

export const load: PageServerLoad = async ({ locals, url, depends }) => {
  depends('smrt:inference-settings');
  const session = requireSettingsSession(locals);
  const service = await inferenceSettingsService(
    session,
    CUSTOMIZE_INFERENCE_PERMISSION,
  );
  const tenantId = session.tenantId;
  const requested = (url.searchParams.get('by') ?? '')
    .split(',')
    .filter((value): value is InferenceUsageReportDimension =>
      (USAGE_DIMENSIONS as readonly string[]).includes(value),
    );
  const preferences = await createInferencePreferences(
    await inferencePreferenceStore(),
  ).read();
  const usage = await service
    .usage({ by: requested.length > 0 ? requested : ['model'], tenantId })
    .catch(() => null);
  return {
    tenantId,
    // The owner customizes the whole app; anyone else reads.
    canEdit: session.can(CUSTOMIZE_INFERENCE_PERMISSION),
    canPersonalize: session.can(PERSONALIZE_INFERENCE_PERMISSION),
    // No key is ever sent to the browser, only whether one is stored.
    defaults: {
      ...preferences.choices,
      keySet: await inferenceKeyIsSet(inferenceUserResolver()),
    },
    providers: service.listProviderOptions(),
    tiers: await service.listInferenceSettings({ tenantId }),
    defaultTier: await service.getDefaultTierSetting({ tenantId }),
    aliases: await service.listInferenceAliases(),
    fusions: await service.listInferenceFusions(),
    transcripts: await service.getTranscriptSettings(),
    usage,
  };
};

export const actions: Actions = {
  saveDefaults: async ({ request, locals }) => {
    const session = requireSettingsSession(locals);
    const change = await readPayload<{
      mode: InferenceMode;
      provider?: string;
      baseUrl?: string;
      model?: string;
      defaultTier?: 'cheap' | 'good' | 'great' | 'best';
    }>(request);
    const scope = session.can(CUSTOMIZE_INFERENCE_PERMISSION)
      ? 'tenant'
      : 'user';
    try {
      const preferences = createInferencePreferences(
        await inferencePreferenceStore(),
      );
      const current = await preferences.read();
      const result = await preferences.write(change, {
        scope,
        revision: current.revisions[scope],
      });
      if (!result.ok) {
        return fail(result.reason === 'not_allowed' ? 403 : 400, {
          error:
            result.reason === 'conflict'
              ? 'These settings changed elsewhere. Reload and try again.'
              : 'These choices were refused.',
        });
      }
    } catch (cause) {
      const failure = settingsFailure(cause);
      return fail(failure.status, { error: failure.error });
    }
    return { message: 'Saved.' };
  },

  // Owner only: the key is stored through the user resolver (as the
  // `inference.provider-config` secret) and never comes back to the browser.
  saveKey: async ({ request, locals }) => {
    const session = requireSettingsSession(locals);
    if (!session.can(CUSTOMIZE_INFERENCE_PERMISSION)) {
      return fail(403, { error: 'You are not allowed to change this setting.' });
    }
    const change = await readPayload<InferenceKeyPayload>(request);
    try {
      // A preset key needs a model: the owner's saved default.
      const saved = await createInferencePreferences(
        await inferencePreferenceStore(),
      ).read();
      await saveInferenceKey(
        inferenceUserResolver(),
        change,
        saved.choices.model,
      );
    } catch (cause) {
      const failure = settingsFailure(cause);
      return fail(failure.status, { error: failure.error });
    }
    return { message: 'Saved.' };
  },

  saveTier: async ({ request, locals }) => {
    const change = await readPayload<{
      tier: 'cheap' | 'good' | 'great' | 'best';
      scope: 'app' | 'tenant';
      target: Record<string, unknown> | null;
    }>(request);
    return write(locals, (service, session) =>
      service.setTierOverride({
        tier: change.tier,
        ...scopeOf(session, change.scope),
        target: change.target as never,
      }),
    );
  },

  saveDefaultTier: async ({ request, locals }) => {
    const change = await readPayload<{
      scope: 'app' | 'tenant';
      tier: 'cheap' | 'good' | 'great' | 'best' | null;
    }>(request);
    return write(locals, (service, session) =>
      service.setDefaultTierOverride({
        ...scopeOf(session, change.scope),
        tier: change.tier,
      }),
    );
  },

  saveAlias: async ({ request, locals }) => {
    const change = await readPayload<{
      name: string;
      candidates: unknown[] | null;
      description?: string;
    }>(request);
    return write(locals, (service) =>
      service.setAlias({
        name: change.name,
        alias:
          change.candidates === null
            ? null
            : ({
                candidates: change.candidates,
                ...(change.description
                  ? { description: change.description }
                  : {}),
              } as never),
      }),
    );
  },

  saveFusion: async ({ request, locals }) => {
    const change = await readPayload<{
      name: string;
      definition: Record<string, unknown> | null;
    }>(request);
    return write(locals, (service) =>
      service.setFusion({ name: change.name, definition: change.definition }),
    );
  },

  saveTranscripts: async ({ request, locals }) => {
    const change = await readPayload<{
      settings: { enabled: boolean; sample: number; maxBytes: number } | null;
    }>(request);
    return write(locals, (service) =>
      service.setTranscriptSettings({ settings: change.settings }),
    );
  },

  // Probes return a key-free result; they write nothing.
  testConnection: async ({ request, locals }) => {
    const session = requireSettingsSession(locals);
    const input = await readPayload<{
      provider?: string;
      preset?: string;
      baseUrl?: string;
      model?: string;
    }>(request);
    try {
      const service = await inferenceSettingsService(
        session,
        CUSTOMIZE_INFERENCE_PERMISSION,
      );
      return { result: await service.testConnection(input) };
    } catch (cause) {
      return fail(400, { error: settingsFailure(cause).error });
    }
  },

  testCandidate: async ({ request, locals }) => {
    const session = requireSettingsSession(locals);
    const candidate = await readPayload<Record<string, unknown>>(request);
    try {
      const service = await inferenceSettingsService(
        session,
        CUSTOMIZE_INFERENCE_PERMISSION,
      );
      return { result: await service.testCandidate(candidate as never) };
    } catch (cause) {
      return fail(400, { error: settingsFailure(cause).error });
    }
  },

  discoverModels: async ({ locals }) => {
    const session = requireSettingsSession(locals);
    const service = await inferenceSettingsService(
      session,
      CUSTOMIZE_INFERENCE_PERMISSION,
    );
    return { discovered: await service.discoverModels() };
  },
};
