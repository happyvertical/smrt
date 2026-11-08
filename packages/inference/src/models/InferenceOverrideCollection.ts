import { SmrtCollection } from '@happyvertical/smrt-core';
import {
  APP_INFERENCE_SCOPE_ID,
  InferenceOverride,
} from './InferenceOverride.js';

/** `app` (the `__app__` row) or one tenant. */
export type InferenceOverrideScopeType = 'app' | 'tenant';

/**
 * Reads and unauthorized writes of `_smrt_inference_overrides`. Hosts write
 * through `InferenceOverrideService` (authorizer-gated, fails closed); call
 * {@link setOverride} / {@link removeOverride} directly only after your own
 * authorization decision.
 */
export class InferenceOverrideCollection extends SmrtCollection<InferenceOverride> {
  static readonly _itemClass = InferenceOverride;

  /**
   * Every row of one scope, keyed by binding id: one bounded read. An
   * enumeration read: build the collection without list bounds (the
   * settings service does) so a host-wide `maxListLimit` cannot drop a row.
   */
  async getScopeMap(
    scopeType: InferenceOverrideScopeType,
    scopeId: string,
  ): Promise<Map<string, InferenceOverride>> {
    const tenantId = scopeType === 'app' ? null : scopeId;
    const rows = await this.list({ where: { tenantId } });
    const result = new Map<string, InferenceOverride>();
    for (const row of rows) result.set(row.binding, row);
    return result;
  }

  /** The row for one binding at one scope. */
  async findByScope(
    binding: string,
    scopeType: InferenceOverrideScopeType,
    scopeId: string,
  ): Promise<InferenceOverride | null> {
    const tenantId = scopeType === 'app' ? null : scopeId;
    const rows = await this.list({ where: { binding, tenantId }, limit: 1 });
    return rows[0] ?? null;
  }

  /**
   * Set the stored value (and, for app rows, optionally the tenant
   * allow-list) of one binding at one scope, creating the row when needed.
   * `undefined` leaves a column untouched; `null` clears it. A row left with
   * neither a value nor an allow-list is deleted.
   */
  async setOverride(
    binding: string,
    scopeType: InferenceOverrideScopeType,
    scopeId: string,
    change: { target?: unknown; tenantAllowList?: string[] | null },
  ): Promise<InferenceOverride | null> {
    const existing = await this.findByScope(binding, scopeType, scopeId);
    const target =
      change.target === undefined
        ? (existing?.target ?? null)
        : change.target === null
          ? null
          : JSON.stringify(change.target);
    const tenantAllowList =
      change.tenantAllowList === undefined
        ? (existing?.tenantAllowList ?? null)
        : change.tenantAllowList === null
          ? null
          : JSON.stringify(change.tenantAllowList);

    if (target === null && tenantAllowList === null) {
      if (existing) await existing.delete();
      return null;
    }
    if (existing) {
      existing.target = target;
      existing.tenantAllowList = tenantAllowList;
      await existing.save();
      return existing;
    }
    const created = await this.create({
      binding,
      tenantId: scopeType === 'app' ? null : scopeId,
      target,
      tenantAllowList,
    });
    await created.save();
    return created;
  }

  /** Delete the row for one binding at one scope, if any. */
  async removeOverride(
    binding: string,
    scopeType: InferenceOverrideScopeType,
    scopeId: string,
  ): Promise<boolean> {
    const existing = await this.findByScope(binding, scopeType, scopeId);
    if (!existing) return false;
    await existing.delete();
    return true;
  }
}

export { APP_INFERENCE_SCOPE_ID };
