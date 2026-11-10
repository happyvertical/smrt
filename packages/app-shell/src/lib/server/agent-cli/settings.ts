// The owner's non-secret assistant settings, as the smrt-preferences kind
// `assistant` (the same store smrt-inference keeps its `inference` choices in):
//
//   engine      which engine runs the assistant: `api` (an API key, resolved
//               through smrt-inference's tiers) or a local agent CLI,
//               `claude-code` / `codex` (the person's own installed, signed-in
//               tool; see ./tools.ts for the legal rule) or `chatgpt` (the
//               owner's own ChatGPT plan, Sign in with ChatGPT).
//   chatgptModel the model the owner picked for `chatgpt` (an id from the
//               signed-in account's catalog); absent = the catalog's first.
//   onboarding  set once the first-run flow is finished (`fresh`) or skipped.
//   view        the owner's saved choice of which copy of the app the content
//               shows while a draft is open (`live` or `draft`), at user scope
//               (see ../view.ts).
//
// Why not a member of the `inference` preference: that payload is the
// settings panel's own form and `saveDefaults` replaces it whole, which would
// erase these members on the next save; and a subprocess agent loop is not a
// chat-completion tier target, so smrt-core's tier/mode model has no seat for
// it. Never a key: the validator refuses anything but these members.
import {
  type PreferenceKindDefinition,
  registerPreferenceKind,
} from '@happyvertical/smrt-preferences';
import { registerPermissionDefinitions } from '@happyvertical/smrt-users';

export const ASSISTANT_PREFERENCE_KIND = 'assistant';
export const ASSISTANT_PREFERENCE_SURFACE = 'default';

/** The scope an agent CLI's MCP token carries. */
export const ASSISTANT_USE_PERMISSION = 'assistant.use';
export const ASSISTANT_CUSTOMIZE_PERMISSION = 'assistant.customize';
export const ASSISTANT_PERSONALIZE_PERMISSION = 'assistant.personalize';

import {
  ASSISTANT_ENGINES,
  type AssistantEngineId as AssistantEngine,
} from '../../assistant/events.ts';

export { ASSISTANT_ENGINES, type AssistantEngine };
export const ONBOARDING_OUTCOMES = ['fresh', 'skipped'] as const;
export type OnboardingOutcome = (typeof ONBOARDING_OUTCOMES)[number];

/** A model id from the plan's catalog: bounded, no whitespace. */
export const CHATGPT_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;

export interface AssistantPreferences {
  engine?: AssistantEngine;
  chatgptModel?: string;
  onboarding?: OnboardingOutcome;
  /**
   * Which copy of the app the owner is looking at while a draft is open
   * (`live` or `draft`). Written at USER scope (per owner) by `view.ts`; the
   * server turns it into an explicit target for the assistant's turn.
   */
  view?: 'live' | 'draft';
}

export function isAssistantEngine(value: unknown): value is AssistantEngine {
  return (ASSISTANT_ENGINES as readonly unknown[]).includes(value);
}

const issue = (path: string, message: string) => ({
  path,
  code: 'invalid_setting',
  message,
});

export function validateAssistantPreferences(payload: unknown) {
  if (payload === null || payload === undefined)
    return { ok: true, canonical: null, issues: [] };
  if (typeof payload !== 'object' || Array.isArray(payload))
    return {
      ok: false,
      canonical: null,
      issues: [issue('', 'assistant preferences are an object')],
    };
  const canonical: AssistantPreferences = {};
  const issues: ReturnType<typeof issue>[] = [];
  for (const [member, value] of Object.entries(payload)) {
    if (value === undefined || value === null || value === '') continue;
    if (member === 'engine') {
      if (isAssistantEngine(value)) canonical.engine = value;
      else
        issues.push(
          issue(member, `engine is one of ${ASSISTANT_ENGINES.join(', ')}`),
        );
    } else if (member === 'chatgptModel') {
      if (typeof value === 'string' && CHATGPT_MODEL_PATTERN.test(value))
        canonical.chatgptModel = value;
      else issues.push(issue(member, 'chatgptModel is a model id'));
    } else if (member === 'onboarding') {
      if ((ONBOARDING_OUTCOMES as readonly unknown[]).includes(value))
        canonical.onboarding = value as OnboardingOutcome;
      else
        issues.push(
          issue(
            member,
            `onboarding is one of ${ONBOARDING_OUTCOMES.join(', ')}`,
          ),
        );
    } else if (member === 'view') {
      if (value === 'live' || value === 'draft') canonical.view = value;
      else issues.push(issue(member, "view is 'live' or 'draft'"));
    } else issues.push(issue(member, 'unknown assistant preference'));
  }
  return {
    ok: issues.length === 0,
    canonical: Object.keys(canonical).length > 0 ? canonical : null,
    issues,
  };
}

export const assistantPreferenceKind: PreferenceKindDefinition = {
  kind: ASSISTANT_PREFERENCE_KIND,
  formatVersion: 1,
  permissions: {
    tenant: ASSISTANT_CUSTOMIZE_PERMISSION,
    user: ASSISTANT_PERSONALIZE_PERMISSION,
  },
  validate: (payload) => validateAssistantPreferences(payload),
};

/**
 * Registered at import (the runtime's init seeds the owner role over the
 * registered permission catalog, so the owner holds these from the next start
 * after an upgrade). Registration describes a permission; the owner check in
 * `owner.ts` still gates every route.
 */
registerPreferenceKind(assistantPreferenceKind, { replace: true });
registerPermissionDefinitions([
  {
    slug: ASSISTANT_USE_PERMISSION,
    category: 'assistant',
    name: 'Use the local agent assistant',
    description:
      'Scope of the short-lived token a local agent CLI uses to call the shell’s tools',
  },
  {
    slug: ASSISTANT_CUSTOMIZE_PERMISSION,
    category: 'assistant',
    name: 'Customize the assistant',
    description: 'Choose which engine runs the assistant',
  },
  {
    slug: ASSISTANT_PERSONALIZE_PERMISSION,
    category: 'assistant',
    name: 'Personalize the assistant',
    description: 'Keep a personal assistant engine choice',
  },
]);

/** The slice of smrt-preferences' `PreferenceStore` used here. */
export interface AssistantPreferenceStore {
  load(
    kind: string,
    surfaceId: string,
  ): Promise<{
    tenant: { payload: unknown; revision: string | null };
    user?: { payload: unknown; revision: string | null } | null;
  }>;
  save(
    kind: string,
    surfaceId: string,
    input: {
      scope: 'tenant' | 'user';
      payload: unknown;
      revision: string | null;
    },
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export class AssistantSettingsError extends Error {
  constructor(
    readonly reason: string,
    message = 'The setting could not be saved.',
  ) {
    super(message);
    this.name = 'AssistantSettingsError';
  }
}

export interface AssistantSettings {
  /** The engine in effect (`api` until one is chosen). */
  engine: AssistantEngine;
  /** `null` until onboarding is finished or skipped. */
  onboarding: OnboardingOutcome | null;
  /** The owner's ChatGPT model choice, `null` = the catalog's first. */
  chatgptModel: string | null;
}

export function createAssistantSettings(
  store: () => Promise<AssistantPreferenceStore>,
) {
  const merged = (
    state: Awaited<ReturnType<AssistantPreferenceStore['load']>>,
  ) => ({
    ...((state.tenant.payload as AssistantPreferences | null) ?? {}),
    ...((state.user?.payload as AssistantPreferences | null) ?? {}),
  });
  return {
    async read(): Promise<AssistantSettings> {
      const prefs = merged(
        await (await store()).load(
          ASSISTANT_PREFERENCE_KIND,
          ASSISTANT_PREFERENCE_SURFACE,
        ),
      );
      return {
        engine: prefs.engine ?? 'api',
        onboarding: prefs.onboarding ?? null,
        chatgptModel: prefs.chatgptModel ?? null,
      };
    },

    /** Merge `patch` into the owner's tenant-level choice. */
    async write(patch: AssistantPreferences): Promise<AssistantSettings> {
      const s = await store();
      for (let attempt = 0; ; attempt++) {
        const state = await s.load(
          ASSISTANT_PREFERENCE_KIND,
          ASSISTANT_PREFERENCE_SURFACE,
        );
        const next = {
          ...((state.tenant.payload as AssistantPreferences | null) ?? {}),
          ...patch,
        };
        const result = await s.save(
          ASSISTANT_PREFERENCE_KIND,
          ASSISTANT_PREFERENCE_SURFACE,
          { scope: 'tenant', payload: next, revision: state.tenant.revision },
        );
        if (result.ok) break;
        if (result.reason === 'conflict' && attempt < 2) continue;
        throw new AssistantSettingsError(result.reason);
      }
      return this.read();
    },
  };
}
