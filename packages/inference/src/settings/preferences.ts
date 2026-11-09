/**
 * User inference choices as the smrt-preferences kind `inference` (#4754):
 * mode, provider, base URL, model and default tier, at the tenant default
 * and per user. Never a key: the validator refuses credential-shaped members
 * (keys go to smrt-secrets through the host).
 *
 * smrt-preferences is not a dependency: the kind is a plain definition the
 * host registers with `registerPreferenceKind(inferencePreferenceKind)` (and
 * the two permissions with smrt-users' `registerPermissionDefinitions`), and
 * {@link createInferencePreferences} takes the store structurally.
 */
import {
  INFERENCE_TIERS,
  type InferenceTier,
  isInferenceTier,
} from '@happyvertical/smrt-core';
import {
  findKeyMember,
  INFERENCE_MODES,
  type InferenceMode,
} from './targets.js';

export const INFERENCE_PREFERENCE_KIND = 'inference';

/** Default surface id: one inference choice per tenant and user. */
export const INFERENCE_PREFERENCE_SURFACE = 'default';

/** Authorizes changing the tenant's default inference choices. */
export const CUSTOMIZE_INFERENCE_PERMISSION = 'inference.customize';

/** Authorizes a user to keep their own inference choices. */
export const PERSONALIZE_INFERENCE_PERMISSION = 'inference.personalize';

/** For smrt-users' `registerPermissionDefinitions()`. */
export const INFERENCE_PERMISSION_DEFINITIONS = [
  {
    slug: CUSTOMIZE_INFERENCE_PERMISSION,
    category: 'inference',
    name: 'Customize Inference',
    description:
      'Change the default inference mode, provider and model everyone in the tenant uses',
  },
  {
    slug: PERSONALIZE_INFERENCE_PERMISSION,
    category: 'inference',
    name: 'Personalize Inference',
    description:
      'Keep a personal inference mode, provider and model on top of the tenant default',
  },
] as const;

/** The `inference` preference payload. Every member is optional. */
export interface InferencePreferences {
  mode?: InferenceMode;
  provider?: string;
  baseUrl?: string;
  model?: string;
  defaultTier?: InferenceTier;
}

/** Structural copy of smrt-preferences' issue shape. */
export interface InferencePreferenceIssue {
  path: string | null;
  code: string;
  message: string;
}

const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
// Visible characters only: no whitespace or control characters.
const MODEL_PATTERN = /^[!-~\u00a1-\uffff]{1,200}$/;

function issue(path: string, message: string): InferencePreferenceIssue {
  return { path, code: 'invalid_setting', message };
}

function validBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

/**
 * Validate an `inference` payload: unknown or invalid members are removed
 * and reported, credential-shaped members refuse the whole payload.
 */
export function validateInferencePreferences(payload: unknown): {
  ok: boolean;
  canonical: InferencePreferences | null;
  issues: InferencePreferenceIssue[];
} {
  if (payload === null || payload === undefined) {
    return { ok: true, canonical: null, issues: [] };
  }
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      ok: false,
      canonical: null,
      issues: [issue('', 'inference preferences are an object')],
    };
  }
  const keyMember = findKeyMember(payload);
  if (keyMember) {
    return {
      ok: false,
      canonical: null,
      issues: [
        issue(
          keyMember,
          'keys are never stored as preferences; they go to smrt-secrets',
        ),
      ],
    };
  }
  const input = payload as Record<string, unknown>;
  const issues: InferencePreferenceIssue[] = [];
  const canonical: InferencePreferences = {};
  for (const [member, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === '') continue;
    switch (member) {
      case 'mode':
        if ((INFERENCE_MODES as readonly unknown[]).includes(value)) {
          canonical.mode = value as InferenceMode;
        } else {
          issues.push(
            issue(member, `mode is one of ${INFERENCE_MODES.join(', ')}`),
          );
        }
        break;
      case 'provider':
        if (typeof value === 'string' && PROVIDER_PATTERN.test(value)) {
          canonical.provider = value;
        } else issues.push(issue(member, 'invalid provider id'));
        break;
      case 'baseUrl':
        if (typeof value === 'string' && validBaseUrl(value)) {
          canonical.baseUrl = value;
        } else {
          issues.push(
            issue(
              member,
              'the base URL is an http(s) URL without credentials, query or fragment',
            ),
          );
        }
        break;
      case 'model':
        if (typeof value === 'string' && MODEL_PATTERN.test(value)) {
          canonical.model = value;
        } else issues.push(issue(member, 'invalid model id'));
        break;
      case 'defaultTier':
        if (isInferenceTier(value)) canonical.defaultTier = value;
        else {
          issues.push(
            issue(
              member,
              `the default tier is one of ${INFERENCE_TIERS.join(', ')}`,
            ),
          );
        }
        break;
      default:
        issues.push(issue(member, 'unknown inference preference'));
    }
  }
  return {
    ok: issues.length === 0,
    canonical: Object.keys(canonical).length > 0 ? canonical : null,
    issues,
  };
}

/** The kind definition for smrt-preferences' `registerPreferenceKind()`. */
export const inferencePreferenceKind = {
  kind: INFERENCE_PREFERENCE_KIND,
  formatVersion: 1,
  permissions: {
    tenant: CUSTOMIZE_INFERENCE_PERMISSION,
    user: PERSONALIZE_INFERENCE_PERMISSION,
  },
  validate(payload: unknown) {
    return validateInferencePreferences(payload);
  },
};

type WriteResult =
  | { ok: true; revision?: string | null; [extra: string]: unknown }
  | { ok: false; reason: string; [extra: string]: unknown };

/** The slice of smrt-preferences' `PreferenceStore` this layer uses. */
export interface InferencePreferenceStoreLike {
  load(
    kind: string,
    surfaceId: string,
  ): Promise<{
    tenant: { payload: unknown; revision: string | null };
    user?: { payload: unknown; revision: string | null } | null;
    issues: InferencePreferenceIssue[];
    canCustomize: { tenant: boolean; user: boolean };
  }>;
  save(
    kind: string,
    surfaceId: string,
    input: {
      scope: 'tenant' | 'user';
      payload: unknown;
      revision: string | null;
    },
  ): Promise<WriteResult>;
  reset(
    kind: string,
    surfaceId: string,
    input: { scope: 'tenant' | 'user'; revision?: string | null },
  ): Promise<WriteResult>;
}

/** What a settings screen reads. */
export interface InferencePreferenceRead {
  /** Tenant default with the user's choices on top (member by member). */
  choices: InferencePreferences;
  tenant: InferencePreferences | null;
  user: InferencePreferences | null;
  revisions: { tenant: string | null; user: string | null };
  issues: InferencePreferenceIssue[];
  canCustomize: { tenant: boolean; user: boolean };
}

/** Read and write the `inference` preference over a preference store. */
export function createInferencePreferences(
  store: InferencePreferenceStoreLike,
  surfaceId: string = INFERENCE_PREFERENCE_SURFACE,
) {
  return {
    async read(): Promise<InferencePreferenceRead> {
      const state = await store.load(INFERENCE_PREFERENCE_KIND, surfaceId);
      const tenant =
        (state.tenant.payload as InferencePreferences | null) ?? null;
      const user = (state.user?.payload as InferencePreferences | null) ?? null;
      return {
        choices: { ...(tenant ?? {}), ...(user ?? {}) },
        tenant,
        user,
        revisions: {
          tenant: state.tenant.revision,
          user: state.user?.revision ?? null,
        },
        issues: state.issues,
        canCustomize: state.canCustomize,
      };
    },

    /** Save choices at a scope (default `user`); `revision` is the one the client loaded. */
    write(
      choices: InferencePreferences,
      options: { scope?: 'tenant' | 'user'; revision: string | null },
    ): Promise<WriteResult> {
      return store.save(INFERENCE_PREFERENCE_KIND, surfaceId, {
        scope: options.scope ?? 'user',
        payload: choices,
        revision: options.revision,
      });
    },

    reset(
      options: { scope?: 'tenant' | 'user'; revision?: string | null } = {},
    ): Promise<WriteResult> {
      return store.reset(INFERENCE_PREFERENCE_KIND, surfaceId, {
        scope: options.scope ?? 'user',
        revision: options.revision,
      });
    },
  };
}

export type InferencePreferencesApi = ReturnType<
  typeof createInferencePreferences
>;
