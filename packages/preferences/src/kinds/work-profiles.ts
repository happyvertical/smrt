/** Owner work-profile overrides; inference owns recommendations and resolution. */
import type {
  AssistantSafetySettings,
  WorkProfileName,
  WorkProfileSettings,
} from '@happyvertical/smrt-inference';
import {
  PreferenceAccessError,
  type PreferencePrincipal,
  requirePreferencePrincipal,
} from '../context.js';
import type { PreferenceKindDefinition } from '../kinds.js';
import type { PreferenceStore } from '../store.js';

export type WorkProfilePreferences = Partial<
  Record<WorkProfileName, WorkProfileSettings>
> & { safety?: AssistantSafetySettings };
export const WORK_PROFILES_PREFERENCE_KIND = 'work-profiles';
const SURFACE = 'assistant';
const profiles = new Set(['design', 'assist', 'background']);
const engines = new Set(['claude-code', 'codex', 'chatgpt', 'api']);
const budgets = new Set([
  'maxSteps',
  'maxTokens',
  'maxTurnTokens',
  'requestTimeoutMs',
  'turnTimeoutMs',
  'maxRunTokens',
  'runTimeoutMs',
  'passes',
  'repairRetries',
  'toolResultChars',
]);
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
function validSettings(value: unknown): boolean {
  if (!record(value)) return false;
  return Object.entries(value).every(([key, v]) => {
    if (key === 'engine') return typeof v === 'string' && engines.has(v);
    if (key === 'model')
      return (
        typeof v === 'string' &&
        v.length > 0 &&
        v.length <= 200 &&
        !v.startsWith('-') &&
        !/\s/.test(v) &&
        [...v].every(
          (character) =>
            character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
        )
      );
    if (key === 'effort')
      return (
        typeof v === 'string' &&
        ['low', 'medium', 'high', 'xhigh', 'max'].includes(v)
      );
    if (key === 'autoEscalate' || key === 'previewBeforeApply')
      return typeof v === 'boolean';
    if (key === 'budgets')
      return (
        record(v) &&
        Object.entries(v).every(
          ([k, n]) =>
            budgets.has(k) &&
            Number.isSafeInteger(n) &&
            (n as number) >= (k === 'repairRetries' ? 0 : 1),
        )
      );
    return false;
  });
}
export const workProfilesPreferenceKind: PreferenceKindDefinition = {
  kind: WORK_PROFILES_PREFERENCE_KIND,
  formatVersion: 1,
  permissions: { tenant: 'inference.customize', user: 'inference.customize' },
  validate(payload, context) {
    const valid =
      context.scope === 'tenant' &&
      (payload === null ||
        (record(payload) &&
          Object.entries(payload).every(([name, value]) =>
            name === 'safety'
              ? record(value) &&
                Object.entries(value).every(
                  ([key, v]) =>
                    ['requireRemovalApproval', 'protectLocalCli'].includes(
                      key,
                    ) && typeof v === 'boolean',
                )
              : profiles.has(name) && validSettings(value),
          )));
    return valid
      ? { ok: true, canonical: payload, issues: [] }
      : {
          ok: false,
          canonical: null,
          issues: [
            {
              path: null,
              code: 'invalid_work_profiles',
              message:
                'Work profiles must contain only supported engine, model, effort, budget, escalation and preview settings.',
            },
          ],
        };
  },
};

/** Owner check and the generic store permission/CAS both apply to writes and reset. */
export function createWorkProfilesPreference(options: {
  store: PreferenceStore;
  isOwner(principal: PreferencePrincipal): Promise<boolean>;
}) {
  async function owner() {
    if (!(await options.isOwner(requirePreferencePrincipal())))
      throw new PreferenceAccessError(
        'Only the owner can change assistant quality',
      );
  }
  return {
    async read() {
      const state = await options.store.load(
        WORK_PROFILES_PREFERENCE_KIND,
        SURFACE,
      );
      return {
        settings: (state.tenant.payload ?? {}) as WorkProfilePreferences,
        revision: state.tenant.revision,
        issues: state.issues,
      };
    },
    async write(
      settings: WorkProfilePreferences,
      revision: string | null,
      confirmation?: { confirmUnprotectedCli?: boolean },
    ) {
      await owner();
      if (
        settings?.safety?.protectLocalCli === false &&
        confirmation?.confirmUnprotectedCli !== true
      ) {
        const previous = await this.read();
        if (previous.settings.safety?.protectLocalCli !== false)
          throw new PreferenceAccessError(
            'Confirm that chat can run commands and change files on this computer',
          );
      }
      return options.store.save(WORK_PROFILES_PREFERENCE_KIND, SURFACE, {
        scope: 'tenant',
        payload: settings,
        revision,
      });
    },
    async reset(revision: string | null) {
      await owner();
      return options.store.reset(WORK_PROFILES_PREFERENCE_KIND, SURFACE, {
        scope: 'tenant',
        revision,
      });
    },
  };
}
