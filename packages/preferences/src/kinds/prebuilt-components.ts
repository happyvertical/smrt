/** Tenant-wide owner preference controlling cookbook building-block tools. */
import { notifyRuntimeExposureChanged } from '@happyvertical/smrt-core/runtime-exposure';
import {
  PreferenceAccessError,
  type PreferencePrincipal,
  requirePreferencePrincipal,
} from '../context.js';
import type { PreferenceKindDefinition } from '../kinds.js';
import type { PreferenceStore } from '../store.js';

export const PREBUILT_COMPONENTS_PREFERENCE_KIND = 'pre-built-components';
const SURFACE = 'app';
export const prebuiltComponentsPreferenceKind: PreferenceKindDefinition = {
  kind: PREBUILT_COMPONENTS_PREFERENCE_KIND,
  formatVersion: 1,
  permissions: { tenant: 'recipes.configure', user: 'recipes.configure' },
  validate(payload, context) {
    const valid =
      context.scope === 'tenant' &&
      (payload === null ||
        (typeof payload === 'object' &&
          !Array.isArray(payload) &&
          Object.keys(payload).length === 1 &&
          typeof (payload as { enabled?: unknown }).enabled === 'boolean'));
    return valid
      ? { ok: true, canonical: payload, issues: [] }
      : {
          ok: false,
          canonical: null,
          issues: [
            {
              path: null,
              code: 'invalid_prebuilt_components',
              message:
                'Pre-built components is one tenant preference: { enabled: boolean }.',
            },
          ],
        };
  },
};

/** Host loads once per tenant before serving and refreshes on external changes.
 * Unknown/unreadable tenants fail closed. No per-user override can reopen it. */
export function createPrebuiltComponentsPreference(options: {
  store: PreferenceStore;
  /** Reuse the host's live owner authority (e.g. isApprovalOwner). */
  isOwner(principal: PreferencePrincipal): Promise<boolean>;
}) {
  const enabled = new Map<string, boolean>();
  const publish = (tenantId: string, value: boolean) => {
    enabled.set(tenantId, value);
    notifyRuntimeExposureChanged();
  };
  async function read() {
    const principal = requirePreferencePrincipal();
    try {
      const state = await options.store.load(
        PREBUILT_COMPONENTS_PREFERENCE_KIND,
        SURFACE,
      );
      const value =
        state.issues.length === 0 &&
        (state.tenant.payload as { enabled?: boolean } | null)?.enabled !==
          false;
      publish(principal.tenantId, value);
      return { enabled: value, revision: state.tenant.revision };
    } catch (error) {
      publish(principal.tenantId, false);
      throw error;
    }
  }
  return {
    read,
    isEnabled(tenantId: string | null | undefined): boolean {
      return !!tenantId && enabled.get(tenantId) === true;
    },
    async write(value: boolean, revision: string | null) {
      const principal = requirePreferencePrincipal();
      if (!(await options.isOwner(principal)))
        throw new PreferenceAccessError(
          'Only the owner can change pre-built components',
        );
      const result = await options.store.save(
        PREBUILT_COMPONENTS_PREFERENCE_KIND,
        SURFACE,
        { scope: 'tenant', payload: { enabled: value }, revision },
      );
      if (result.ok) await read();
      return result;
    },
    /** On store outage, owner logout or external preference invalidation. */
    invalidate(tenantId: string): void {
      publish(tenantId, false);
    },
  };
}
