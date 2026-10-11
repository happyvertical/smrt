/**
 * The `shell-layout` preference kind: the sparse `ShellSettingsDelta` the
 * AdminShell settings adapter reads and writes (navigation layout, panel
 * states and sizes, keymap), validated with smrt-svelte's
 * `sanitizeShellSettingsDelta` from the Node-safe `./workspace/server` entry.
 *
 * The surface id names the shell (the app's `storageKey`, e.g. `admin`).
 */
import {
  mergeShellSettingsDelta,
  type ShellSettingsDelta,
  type ShellSettingsIssue,
  sanitizeShellSettingsDelta,
} from '@happyvertical/smrt-svelte/workspace/server';
import type {
  PreferenceIssue,
  PreferenceKindDefinition,
  PreferenceScope,
} from '../kinds.js';
import {
  CUSTOMIZE_SHELL_PERMISSION,
  PERSONALIZE_SHELL_PERMISSION,
} from '../permissions.js';
import type {
  PreferenceResetResult,
  PreferenceSaveResult,
  PreferenceStore,
} from '../store.js';

export const SHELL_LAYOUT_PREFERENCE_KIND = 'shell-layout';

function toPreferenceIssue(issue: ShellSettingsIssue): PreferenceIssue {
  return {
    path: issue.path || null,
    code: 'invalid_setting',
    message: issue.message,
    detail: issue,
  };
}

export const shellLayoutPreferenceKind: PreferenceKindDefinition = {
  kind: SHELL_LAYOUT_PREFERENCE_KIND,
  formatVersion: 1,
  permissions: {
    tenant: CUSTOMIZE_SHELL_PERMISSION,
    user: PERSONALIZE_SHELL_PERMISSION,
  },
  validate(payload) {
    const { delta, issues } = sanitizeShellSettingsDelta(payload);
    return {
      ok: issues.length === 0,
      canonical: Object.keys(delta).length > 0 ? delta : null,
      issues: issues.map(toPreferenceIssue),
    };
  },
};

/** What a shell reads: the merged delta plus each tier for an editor. */
export interface ShellSettingsPreferenceRead {
  /** Tenant default merged with the user's delta (`mergeShellSettingsDelta`). */
  delta: ShellSettingsDelta;
  tenant: ShellSettingsDelta | null;
  user: ShellSettingsDelta | null;
  /** Revisions of each tier, for guarded writes. */
  revisions: { tenant: string | null; user: string | null };
  issues: PreferenceIssue[];
  canCustomize: { tenant: boolean; user: boolean };
}

export interface ShellSettingsPreferenceWriteOptions {
  /** Default `user`. */
  scope?: PreferenceScope;
  /**
   * The revision the client loaded. Omitted, the current revision is read
   * just before the write: last-writer-wins for that call, which is what the
   * shell's `ShellSettingsAdapter.write(delta)` (no revision) gets.
   */
  revision?: string | null;
}

/**
 * The server half of a shell `ShellSettingsAdapter`. A host exposes `read`
 * and `write` as remote functions and the browser adapter calls them:
 *
 * ```ts
 * const adapter: ShellSettingsAdapter = {
 *   read: async () => (await readShellSettings('admin')).delta,
 *   write: (delta) => writeShellSettings('admin', delta),
 * };
 * ```
 */
export interface ShellSettingsPreferences {
  read(surfaceId: string): Promise<ShellSettingsPreferenceRead>;
  write(
    surfaceId: string,
    delta: unknown,
    options?: ShellSettingsPreferenceWriteOptions,
  ): Promise<PreferenceSaveResult>;
  reset(
    surfaceId: string,
    options?: ShellSettingsPreferenceWriteOptions,
  ): Promise<PreferenceResetResult>;
}

function compact(delta: ShellSettingsDelta): ShellSettingsDelta {
  return Object.fromEntries(
    Object.entries(delta).filter(([, value]) => value !== undefined),
  ) as ShellSettingsDelta;
}

/** Shell settings persistence over the generic preference store. */
export function createShellSettingsPreferences(
  store: PreferenceStore,
): ShellSettingsPreferences {
  return {
    async read(surfaceId) {
      const state = await store.load(SHELL_LAYOUT_PREFERENCE_KIND, surfaceId);
      const tenant =
        (state.tenant.payload as ShellSettingsDelta | null) ?? null;
      const user = (state.user?.payload as ShellSettingsDelta | null) ?? null;
      return {
        delta: compact(mergeShellSettingsDelta(tenant ?? {}, user ?? {})),
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

    async write(surfaceId, delta, options = {}) {
      const scope = options.scope ?? 'user';
      let revision = options.revision;
      if (revision === undefined) {
        const state = await store.load(SHELL_LAYOUT_PREFERENCE_KIND, surfaceId);
        revision =
          scope === 'tenant'
            ? state.tenant.revision
            : (state.user?.revision ?? null);
      }
      return store.save(SHELL_LAYOUT_PREFERENCE_KIND, surfaceId, {
        scope,
        payload: delta,
        revision,
      });
    },

    reset(surfaceId, options = {}) {
      return store.reset(SHELL_LAYOUT_PREFERENCE_KIND, surfaceId, {
        scope: options.scope ?? 'user',
        revision: options.revision,
      });
    },
  };
}
