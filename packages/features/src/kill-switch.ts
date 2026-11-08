/**
 * Operator kill switches (#4760).
 *
 * A kill switch is an incident lever, not a feature flag: it stores
 * DISABLE rows in `_smrt_feature_overrides` (the same table, conflict key
 * and write paths as flags) but reads them with stricter semantics than
 * {@link FeatureResolver}:
 *
 * - A global DISABLE turns the switch off everywhere. No tenant row, plan
 *   grant or default can turn it back on (a flag's tenant override would).
 * - Otherwise a DISABLE on the tenant itself turns it off for that tenant.
 * - ENABLE and INHERIT rows are ignored: "on" is the absence of a DISABLE,
 *   so enabling means deleting the DISABLE row at that scope.
 *
 * Reads are uncached (one or two indexed lookups), so a switch takes effect
 * on the next check in every process. Kill-switch keys have no
 * `FeatureDefinition`: they never appear in `FeatureSettingsService` (whose
 * tenant column would suggest a tenant ENABLE overrides a global DISABLE),
 * and `FeatureResolver` refuses to read an undeclared key. Never define
 * one as a feature.
 *
 * Keys belong to their consumer: `inference.hosted.enabled` is
 * `HOSTED_INFERENCE_KILL_SWITCH` in `@happyvertical/smrt-inference/gate`
 * (#4760). Keys are persisted identifiers: never rename one.
 *
 * Writing a switch is an operator act. `setKillSwitch()` writes through the
 * collection directly, so its caller is the authorization (the CLI holds
 * database credentials); hosts exposing a switch in an admin UI write the
 * same rows through `FeatureOverrideService` with their authorizer.
 */

import { FeatureOverrideCollection } from './feature-overrides.js';
import { type FeatureHostOptions, withoutListBounds } from './list-bounds.js';
import { FeatureOverrideEffect, GLOBAL_FEATURE_SCOPE_ID } from './types.js';

/** The state of one kill switch for one tenant (or globally). */
export interface KillSwitchState {
  key: string;
  /** `false` when a global or tenant DISABLE row exists. */
  enabled: boolean;
  /** The scope whose DISABLE row turned it off. */
  disabledBy?: 'global' | 'tenant';
}

function normalizedTenantId(tenantId: string | null | undefined): string {
  return typeof tenantId === 'string' ? tenantId.trim() : '';
}

/**
 * Read a kill switch: global DISABLE first, then the tenant's own DISABLE
 * (matched as given and lower-cased; `setKillSwitch()` stores tenant ids
 * lower-cased, so a UUID typed in either case applies). No tenant: the
 * global switch only.
 */
export async function readKillSwitch(
  overrides: FeatureOverrideCollection,
  key: string,
  options: { tenantId?: string | null } = {},
): Promise<KillSwitchState> {
  const global = await overrides.getGlobalOverride(key);
  if (global?.isDisabled()) {
    return { key, enabled: false, disabledBy: 'global' };
  }
  const tenantId = normalizedTenantId(options.tenantId);
  if (tenantId) {
    const ids = [...new Set([tenantId, tenantId.toLowerCase()])];
    const rows = await overrides.getOverrideMap(key, 'tenant', ids);
    for (const row of rows.values()) {
      if (row.isDisabled()) {
        return { key, enabled: false, disabledBy: 'tenant' };
      }
    }
  }
  return { key, enabled: true };
}

/**
 * Turn a kill switch off (write a DISABLE row) or on (delete the DISABLE
 * row) at the global scope, or for one tenant. Turning a tenant on does not
 * lift a global DISABLE. Returns the switch's state afterwards.
 */
export async function setKillSwitch(
  overrides: FeatureOverrideCollection,
  key: string,
  options: { enabled: boolean; tenantId?: string | null },
): Promise<KillSwitchState> {
  const tenantId = normalizedTenantId(options.tenantId);
  if (options.tenantId !== undefined && options.tenantId !== null) {
    if (!tenantId) {
      throw new Error('A kill switch tenant id must not be blank.');
    }
  }
  if (!tenantId) {
    if (options.enabled) {
      await overrides.removeOverride(key, 'global', GLOBAL_FEATURE_SCOPE_ID);
    } else {
      await overrides.setGlobalOverride(key, FeatureOverrideEffect.DISABLE);
    }
    return readKillSwitch(overrides, key);
  }
  // A tenant DISABLE is stored lower-cased, which the reader matches for any
  // spelling of the id (an operator may type a UUID in upper case). Enabling
  // clears every row for the tenant in any spelling (one written verbatim
  // by an admin UI included).
  const lower = tenantId.toLowerCase();
  if (options.enabled) {
    const rows = await overrides.findByFeatureKey(key);
    const ids = new Set([lower]);
    for (const row of rows) {
      if (row.scopeType === 'tenant' && row.scopeId.toLowerCase() === lower) {
        ids.add(row.scopeId);
      }
    }
    for (const id of ids) {
      await overrides.removeOverride(key, 'tenant', id);
    }
  } else {
    await overrides.setTenantOverride(
      key,
      lower,
      FeatureOverrideEffect.DISABLE,
    );
  }
  return readKillSwitch(overrides, key, { tenantId });
}

/**
 * Kill switches over one database: `read(key, { tenantId })` and
 * `set(key, { enabled, tenantId })`. The override collection is built once,
 * lazily, without the host's list bounds (see `list-bounds.ts`).
 */
export class KillSwitchService {
  private overrides?: Promise<FeatureOverrideCollection>;

  constructor(private readonly options: FeatureHostOptions = {}) {}

  private collection(): Promise<FeatureOverrideCollection> {
    if (!this.overrides) {
      const pending = FeatureOverrideCollection.create(
        withoutListBounds(this.options),
      );
      this.overrides = pending;
      pending.catch(() => {
        if (this.overrides === pending) this.overrides = undefined;
      });
    }
    return this.overrides;
  }

  async read(
    key: string,
    options: { tenantId?: string | null } = {},
  ): Promise<KillSwitchState> {
    return readKillSwitch(await this.collection(), key, options);
  }

  async set(
    key: string,
    options: { enabled: boolean; tenantId?: string | null },
  ): Promise<KillSwitchState> {
    return setKillSwitch(await this.collection(), key, options);
  }
}
