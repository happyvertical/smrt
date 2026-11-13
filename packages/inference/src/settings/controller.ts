/**
 * What a page that hosts `InferenceSettingsPanel` does on the server, minus
 * the web framework: the data the panel loads and the writes behind its
 * callbacks. A SvelteKit template app and the app shell each wire their
 * `load` and form actions to one controller, so the two cannot drift.
 *
 * The controller decides nothing about identity. The host passes a session
 * (`can(permission)` is its own check: a permission snapshot, or the shell's
 * owner lookup) and the controller gates every write on
 * {@link CUSTOMIZE_INFERENCE_PERMISSION}, again in the settings service's
 * authorizer. No method returns or logs a key; a refusal names none.
 */
import { APP_INFERENCE_SCOPE_ID } from '../models/InferenceOverride.js';
import type { InferenceSettingsHost } from './host.js';
import { inferenceSettingsFailure } from './host.js';
import {
  type InferenceKeyPayload,
  inferenceKeyIsSet,
  saveInferenceKey,
} from './key-store.js';
import {
  CUSTOMIZE_INFERENCE_PERMISSION,
  createInferencePreferences,
  type InferencePreferenceStoreLike,
  PERSONALIZE_INFERENCE_PERMISSION,
} from './preferences.js';
import type { InferenceUsageReportDimension } from './settings-service.js';
import type { InferenceMode } from './targets.js';

const USAGE_DIMENSIONS: readonly InferenceUsageReportDimension[] = [
  'model',
  'tier',
  'prompt',
  'fusion',
  'template',
];

/** The panel's props: shared by every host's `load`. */
async function loadPage(
  options: InferenceSettingsControllerOptions,
  session: InferenceControllerSession,
  by?: string | null,
) {
  const { host } = options;
  const settings = await host.settingsService(
    session,
    CUSTOMIZE_INFERENCE_PERMISSION,
  );
  const tenantId = session.tenantId;
  const requested = (by ?? '')
    .split(',')
    .filter((value): value is InferenceUsageReportDimension =>
      (USAGE_DIMENSIONS as readonly string[]).includes(value),
    );
  const preferences = await createInferencePreferences(
    await options.preferenceStore(),
  ).read();
  const usage = await settings
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
      keySet: await inferenceKeyIsSet(host.userResolver()),
    },
    providers: settings.listProviderOptions(),
    tiers: await settings.listInferenceSettings({ tenantId }),
    defaultTier: await settings.getDefaultTierSetting({ tenantId }),
    aliases: await settings.listInferenceAliases(),
    fusions: await settings.listInferenceFusions(),
    transcripts: await settings.getTranscriptSettings(),
    usage,
  };
}

/** What {@link InferenceSettingsController.load} returns (the panel's props). */
export type InferenceSettingsPageData = Awaited<ReturnType<typeof loadPage>>;

type Tier = 'cheap' | 'good' | 'great' | 'best';

/** The principal of a settings request. */
export interface InferenceControllerSession {
  tenantId: string;
  /** Whether the session holds `permission` (the host's own check). */
  can(permission: string): boolean;
}

/** A write's result: `fail()` it in the framework, or show `message`. */
export type InferenceSettingsOutcome<T = Record<never, never>> =
  | ({ ok: true; message?: string } & T)
  | { ok: false; status: number; error: string };

export interface InferenceSettingsControllerOptions {
  host: InferenceSettingsHost;
  /** The smrt-preferences store for the request's principal. */
  preferenceStore: () => Promise<InferencePreferenceStoreLike>;
}

export interface InferenceSettingsController {
  /** Whether the session may write app-wide settings and keys. */
  canCustomize(session: InferenceControllerSession): boolean;
  /** The panel's props. `by` is the usage report grouping (`a,b`). */
  load(
    session: InferenceControllerSession,
    by?: string | null,
  ): Promise<InferenceSettingsPageData>;
  saveDefaults(
    session: InferenceControllerSession,
    change: {
      mode: InferenceMode;
      provider?: string;
      baseUrl?: string;
      model?: string;
      defaultTier?: Tier;
    },
  ): Promise<InferenceSettingsOutcome>;
  saveKey(
    session: InferenceControllerSession,
    change: InferenceKeyPayload,
  ): Promise<InferenceSettingsOutcome>;
  saveTier(
    session: InferenceControllerSession,
    change: {
      tier: Tier;
      scope: 'app' | 'tenant';
      target: Record<string, unknown> | null;
    },
  ): Promise<InferenceSettingsOutcome>;
  saveDefaultTier(
    session: InferenceControllerSession,
    change: { scope: 'app' | 'tenant'; tier: Tier | null },
  ): Promise<InferenceSettingsOutcome>;
  saveAlias(
    session: InferenceControllerSession,
    change: {
      name: string;
      candidates: unknown[] | null;
      description?: string;
    },
  ): Promise<InferenceSettingsOutcome>;
  saveFusion(
    session: InferenceControllerSession,
    change: { name: string; definition: Record<string, unknown> | null },
  ): Promise<InferenceSettingsOutcome>;
  saveTranscripts(
    session: InferenceControllerSession,
    change: {
      settings: { enabled: boolean; sample: number; maxBytes: number } | null;
    },
  ): Promise<InferenceSettingsOutcome>;
  /** Probes return a key-free result and write nothing. */
  testConnection(
    session: InferenceControllerSession,
    input: {
      provider?: string;
      preset?: string;
      baseUrl?: string;
      model?: string;
    },
  ): Promise<InferenceSettingsOutcome<{ result: unknown }>>;
  testCandidate(
    session: InferenceControllerSession,
    candidate: Record<string, unknown>,
  ): Promise<InferenceSettingsOutcome<{ result: unknown }>>;
  discoverModels(
    session: InferenceControllerSession,
  ): Promise<{ discovered: unknown }>;
}

export const NOT_ALLOWED_OUTCOME = {
  ok: false,
  status: 403,
  error: 'You are not allowed to change this setting.',
} as const;

/** Build the controller over a host. */
export function createInferenceSettingsController(
  options: InferenceSettingsControllerOptions,
): InferenceSettingsController {
  const { host } = options;
  const service = (session: InferenceControllerSession) =>
    host.settingsService(session, CUSTOMIZE_INFERENCE_PERMISSION);
  const scopeOf = (
    session: InferenceControllerSession,
    scope: 'app' | 'tenant',
  ) =>
    scope === 'tenant'
      ? { scopeType: 'tenant' as const, scopeId: session.tenantId }
      : { scopeType: 'app' as const, scopeId: APP_INFERENCE_SCOPE_ID };

  /** Run one write; a refusal comes back as an outcome, never a throw. */
  const write = async (
    session: InferenceControllerSession,
    run: (settings: Awaited<ReturnType<typeof service>>) => Promise<unknown>,
  ): Promise<InferenceSettingsOutcome> => {
    try {
      await run(await service(session));
    } catch (cause) {
      const failure = inferenceSettingsFailure(cause);
      return { ok: false, ...failure };
    }
    return { ok: true, message: 'Saved.' };
  };

  const probe = async (
    session: InferenceControllerSession,
    run: (settings: Awaited<ReturnType<typeof service>>) => Promise<unknown>,
  ): Promise<InferenceSettingsOutcome<{ result: unknown }>> => {
    try {
      return { ok: true, result: await run(await service(session)) };
    } catch (cause) {
      return {
        ok: false,
        status: 400,
        error: inferenceSettingsFailure(cause).error,
      };
    }
  };

  return {
    canCustomize: (session) => session.can(CUSTOMIZE_INFERENCE_PERMISSION),

    load: (session, by) => loadPage(options, session, by),

    async saveDefaults(session, change) {
      const scope = session.can(CUSTOMIZE_INFERENCE_PERMISSION)
        ? 'tenant'
        : 'user';
      try {
        const preferences = createInferencePreferences(
          await options.preferenceStore(),
        );
        const current = await preferences.read();
        const result = await preferences.write(change, {
          scope,
          revision: current.revisions[scope],
        });
        if (!result.ok) {
          return {
            ok: false,
            status: result.reason === 'not_allowed' ? 403 : 400,
            error:
              result.reason === 'conflict'
                ? 'These settings changed elsewhere. Reload and try again.'
                : 'These choices were refused.',
          };
        }
      } catch (cause) {
        return { ok: false, ...inferenceSettingsFailure(cause) };
      }
      return { ok: true, message: 'Saved.' };
    },

    // Owner only: the key is stored through the user resolver (as the
    // `inference.provider-config` secret) and never comes back to the browser.
    async saveKey(session, change) {
      if (!session.can(CUSTOMIZE_INFERENCE_PERMISSION)) {
        return { ...NOT_ALLOWED_OUTCOME };
      }
      try {
        // A preset key needs a model: the owner's saved default.
        const saved = await createInferencePreferences(
          await options.preferenceStore(),
        ).read();
        await saveInferenceKey(
          host.userResolver(),
          change,
          saved.choices.model,
        );
      } catch (cause) {
        return { ok: false, ...inferenceSettingsFailure(cause) };
      }
      return { ok: true, message: 'Saved.' };
    },

    saveTier: (session, change) =>
      write(session, (settings) =>
        settings.setTierOverride({
          tier: change.tier,
          ...scopeOf(session, change.scope),
          target: change.target as never,
        }),
      ),

    saveDefaultTier: (session, change) =>
      write(session, (settings) =>
        settings.setDefaultTierOverride({
          ...scopeOf(session, change.scope),
          tier: change.tier,
        }),
      ),

    saveAlias: (session, change) =>
      write(session, (settings) =>
        settings.setAlias({
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
      ),

    saveFusion: (session, change) =>
      write(session, (settings) =>
        settings.setFusion({
          name: change.name,
          definition: change.definition,
        }),
      ),

    saveTranscripts: (session, change) =>
      write(session, (settings) =>
        settings.setTranscriptSettings({ settings: change.settings }),
      ),

    testConnection: (session, input) =>
      probe(session, (settings) => settings.testConnection(input)),

    testCandidate: (session, candidate) =>
      probe(session, (settings) => settings.testCandidate(candidate as never)),

    async discoverModels(session) {
      return { discovered: await (await service(session)).discoverModels() };
    },
  };
}
