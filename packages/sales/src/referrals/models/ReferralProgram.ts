/**
 * ReferralProgram — program-level defaults for referral intake.
 * @packageDocumentation
 */

import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type {
  ReferralProgramOptions,
  ReferralProgramStatus,
} from '../types.js';

/**
 * A ReferralProgram anchors links, touches, referrals, agreements, and
 * exceptions, and carries the program-level DEFAULTS:
 *
 * - `defaultAttributionPolicyKey` — which versioned AttributionPolicy
 *   `AttributionService.resolve()` loads when the caller doesn't override.
 * - `defaultCommissionPlanKey` — the suggested commissions plan for new
 *   ReferralAgreements (the agreement's own `commissionPlanKey` is what
 *   actually binds terms).
 *
 * Both defaults are KEYS, not pinned versions: the active version is
 * resolved at attribution/qualification time and pinned on the Referral /
 * ReferralTermSnapshot, so program rows stay stable across policy and plan
 * amendments.
 *
 * Natural key `(tenant_id, key)` — each tenant names its programs once.
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  conflictColumns: ['tenant_id', 'key'],
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get'] },
  cli: { skipApiCheck: true },
})
export class ReferralProgram extends SmrtObject {
  /** Tenant ID for multi-tenant isolation (nullable → global programs). */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** Stable program key within the tenant (natural-key component). */
  @field({ required: true })
  key: string = '';

  /** Human-readable program name. */
  name: string = '';

  /**
   * Program lifecycle: `draft` (default) → `active` → `paused` /
   * `archived`. Applications gate intake on `active`; this module records
   * the status without enforcing transition edges.
   */
  status: ReferralProgramStatus = 'draft';

  /**
   * Default commissions-plan key suggested to new ReferralAgreements.
   * Empty means the program has no default — agreements must name a plan.
   */
  defaultCommissionPlanKey: string = '';

  /**
   * Default AttributionPolicy key `AttributionService.resolve()` uses when
   * the caller passes no `policyKey` override.
   */
  defaultAttributionPolicyKey: string = '';

  /**
   * Free-form JSON object stored as a string. Use
   * {@link getMetadata}/{@link setMetadata} instead of parsing manually.
   */
  metadata: string = '{}';

  constructor(options: ReferralProgramOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.key !== undefined) this.key = options.key;
    if (options.name !== undefined) this.name = options.name;
    if (options.status !== undefined) this.status = options.status;
    if (options.defaultCommissionPlanKey !== undefined)
      this.defaultCommissionPlanKey = options.defaultCommissionPlanKey;
    if (options.defaultAttributionPolicyKey !== undefined)
      this.defaultAttributionPolicyKey = options.defaultAttributionPolicyKey;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  /** Whether the program is accepting new referral activity. */
  isActive(): boolean {
    return this.status === 'active';
  }

  /** Parse the metadata JSON string; returns `{}` on malformed content. */
  getMetadata(): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(this.metadata);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  }

  /** Serialize and store the metadata object. */
  setMetadata(metadata: Record<string, unknown>): void {
    this.metadata = JSON.stringify(metadata);
  }
}

export default ReferralProgram;
