/**
 * SupportPolicy — governs what the AI support workflow may do without a human
 * (FR-28a/FR-28b): which phases run automatically, whether low-risk
 * resolutions may complete autonomously, the confidence floor, sensitive
 * categories, and the tool whitelist for troubleshooting.
 *
 * Resolution is most-specific-wins per case: `(planId, projectId)` exact →
 * `planId` → `projectId` → tenant default (both null) → the package's
 * conservative built-in defaults (see `DEFAULT_SUPPORT_POLICY`). Policies are
 * operator configuration, so they expose full generated CRUD.
 */

import {
  field,
  foreignKey,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { parseJsonField, parseStringArrayField } from '../types.js';

/**
 * Conservative defaults applied when no SupportPolicy row matches: the AI
 * acknowledges, classifies, and answers, but never closes a case or executes
 * tools until a policy explicitly enables it. Handoff triggers are always
 * active regardless of policy.
 */
export const DEFAULT_SUPPORT_POLICY = {
  autoAcknowledge: true,
  autoClassify: true,
  autoAnswer: true,
  autoTroubleshoot: false,
  autoResolve: false,
  autoResolveMaxSeverity: '',
  confidenceThreshold: 0.7,
  maxAutoAttempts: 1,
  autoSendEmailReplies: false,
  sensitiveCategories: [] as string[],
  allowedTools: [] as string[],
} as const;

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'support_policies',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
  conflictColumns: ['tenant_id', 'name'],
})
export class SupportPolicy extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** Policy name, unique per tenant (`conflictColumns`). */
  name: string = '';

  /** Scope: applies to cases under this plan (null = any plan). */
  @foreignKey('SupportPlan')
  planId: string | null = null;

  /** Scope: applies to cases for this app-defined project (null = any). */
  @field({ type: 'text', nullable: true })
  projectId: string | null = null;

  @field({ type: 'boolean' })
  enabled: boolean = true;

  /** Immediately acknowledge new inbound cases. */
  @field({ type: 'boolean' })
  autoAcknowledge: boolean = true;

  /** Classify severity/category/sensitivity on intake. */
  @field({ type: 'boolean' })
  autoClassify: boolean = true;

  /** Post an automated answer using scoped knowledge. */
  @field({ type: 'boolean' })
  autoAnswer: boolean = true;

  /** Run tool-executing troubleshooting (gated OFF by default). */
  @field({ type: 'boolean' })
  autoTroubleshoot: boolean = false;

  /** Allow the AI to resolve (close out) low-risk cases (OFF by default). */
  @field({ type: 'boolean' })
  autoResolve: boolean = false;

  /**
   * Highest severity the AI may auto-resolve (e.g. `sev4` = questions only).
   * Empty means "no severity is eligible" even when `autoResolve` is true.
   */
  @field({ type: 'text' })
  autoResolveMaxSeverity: string = '';

  /**
   * Confidence floor for automated answers/resolutions; below it the workflow
   * triggers a `low_confidence` Human Handoff.
   */
  confidenceThreshold: number = 0.7;

  /** Max automated resolution attempts before a `failed_resolution` handoff. */
  maxAutoAttempts: number = 1;

  /** Whether automated email replies may be sent (vs drafted) — OFF default. */
  @field({ type: 'boolean' })
  autoSendEmailReplies: boolean = false;

  /**
   * Categories considered sensitive: classification into one of these always
   * triggers a Human Handoff (FR-28b). JSON array of category keys.
   */
  @field({ type: 'text' })
  sensitiveCategories: string = '[]';

  /** Tool ids the troubleshooting phase may execute. JSON array, fail-closed. */
  @field({ type: 'text' })
  allowedTools: string = '[]';

  @field({ type: 'text' })
  metadata: string = '{}';

  getSensitiveCategories(): string[] {
    return parseStringArrayField(this.sensitiveCategories);
  }

  setSensitiveCategories(categories: string[]): void {
    this.sensitiveCategories = JSON.stringify(categories ?? []);
  }

  getAllowedTools(): string[] {
    return parseStringArrayField(this.allowedTools);
  }

  setAllowedTools(tools: string[]): void {
    this.allowedTools = JSON.stringify(tools ?? []);
  }

  getMetadata(): Record<string, unknown> {
    return parseJsonField(this.metadata, {});
  }

  setMetadata(value: Record<string, unknown>): void {
    this.metadata = JSON.stringify(value ?? {});
  }

  /** Specificity rank for resolution: exact scope wins over partial. */
  scopeRank(): number {
    let rank = 0;
    if (this.planId) rank += 2;
    if (this.projectId) rank += 1;
    return rank;
  }
}

export class SupportPolicyCollection extends SmrtCollection<SupportPolicy> {
  static readonly _itemClass = SupportPolicy;

  /**
   * Resolve the effective policy for a case scope, most-specific-wins.
   * Returns `null` when no enabled policy matches (callers then apply
   * {@link DEFAULT_SUPPORT_POLICY}).
   */
  async resolveForScope(options: {
    planId?: string | null;
    projectId?: string | null;
  }): Promise<SupportPolicy | null> {
    const policies = await this.list({ where: { enabled: true } });
    const planId = options.planId ?? null;
    const projectId = options.projectId ?? null;
    const applicable = policies.filter((policy) => {
      if (policy.planId && policy.planId !== planId) return false;
      if (policy.projectId && policy.projectId !== projectId) return false;
      return true;
    });
    applicable.sort((a, b) => b.scopeRank() - a.scopeRank());
    return applicable[0] ?? null;
  }
}

export default SupportPolicy;
