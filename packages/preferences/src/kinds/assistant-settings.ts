/**
 * The assistant's ordinary settings (#5005): hand workflow-only requests to a
 * workflow run, preview before applying, ask before removals, protect this
 * computer from local AI tools. Tenant-wide, owner-only. Inference owns the
 * setting names and their defaults (every one on); this package imports only
 * its types (a value import of inference's root would register its executor),
 * so the key list below mirrors `ASSISTANT_SETTING_KEYS`.
 *
 * The removed `work-profiles` kind is not registered: a stored row of it is
 * never read (reads are per kind), and a store call that names it is refused
 * with `UnknownPreferenceKindError`.
 */
import type { AssistantSettings } from '@happyvertical/smrt-inference';
import {
  PreferenceAccessError,
  type PreferencePrincipal,
  requirePreferencePrincipal,
} from '../context.js';
import type { PreferenceKindDefinition } from '../kinds.js';
import type { PreferenceStore } from '../store.js';

export const ASSISTANT_SETTINGS_PREFERENCE_KIND = 'assistant-settings';
const SURFACE = 'assistant';
const KEYS: readonly (keyof AssistantSettings)[] = [
  'escalateToWorkflow',
  'previewBeforeApply',
  'requireRemovalApproval',
  'protectLocalCli',
];

function isAssistantSettings(value: unknown): value is AssistantSettings {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([key, setting]) =>
        (KEYS as readonly string[]).includes(key) &&
        typeof setting === 'boolean',
    )
  );
}

export const assistantSettingsPreferenceKind: PreferenceKindDefinition = {
  kind: ASSISTANT_SETTINGS_PREFERENCE_KIND,
  formatVersion: 1,
  permissions: { tenant: 'inference.customize', user: 'inference.customize' },
  validate(payload, context) {
    return context.scope === 'tenant' &&
      (payload === null || isAssistantSettings(payload))
      ? { ok: true, canonical: payload, issues: [] }
      : {
          ok: false,
          canonical: null,
          issues: [
            {
              path: null,
              code: 'invalid_assistant_settings',
              message:
                'Assistant settings hold only the workflow handoff, preview, removal approval and local AI protection switches.',
            },
          ],
        };
  },
};

/** Owner check and the generic store permission/CAS both apply to writes and reset. */
export function createAssistantSettingsPreference(options: {
  store: PreferenceStore;
  isOwner(principal: PreferencePrincipal): Promise<boolean>;
}) {
  async function owner() {
    if (!(await options.isOwner(requirePreferencePrincipal())))
      throw new PreferenceAccessError(
        'Only the owner can change the assistant settings',
      );
  }
  return {
    async read() {
      const state = await options.store.load(
        ASSISTANT_SETTINGS_PREFERENCE_KIND,
        SURFACE,
      );
      return {
        settings: (state.tenant.payload ?? {}) as AssistantSettings,
        revision: state.tenant.revision,
        issues: state.issues,
      };
    },
    /**
     * Turning local AI protection off needs `confirmUnprotectedCli` unless
     * it is already off.
     */
    async write(
      settings: AssistantSettings,
      revision: string | null,
      confirmation?: { confirmUnprotectedCli?: boolean },
    ) {
      await owner();
      if (
        settings?.protectLocalCli === false &&
        confirmation?.confirmUnprotectedCli !== true
      ) {
        const previous = await this.read();
        if (previous.settings.protectLocalCli !== false)
          throw new PreferenceAccessError(
            'Confirm that chat can run commands and change files on this computer',
          );
      }
      return options.store.save(ASSISTANT_SETTINGS_PREFERENCE_KIND, SURFACE, {
        scope: 'tenant',
        payload: settings,
        revision,
      });
    },
    async reset(revision: string | null) {
      await owner();
      return options.store.reset(ASSISTANT_SETTINGS_PREFERENCE_KIND, SURFACE, {
        scope: 'tenant',
        revision,
      });
    },
  };
}
