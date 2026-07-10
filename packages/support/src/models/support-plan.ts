/**
 * SupportPlan — the client-facing **Managed Support Plan** (FR-31): coverage
 * hours and channels, severity definitions, acknowledgement / response /
 * update / resolution Service Targets, pause rules, escalation policy, an
 * availability fee, included support time, and metered overage pricing.
 *
 * Pure hourly support is a plan with zero availability fee and zero included
 * minutes. A Service Target here is an operational objective — it becomes a
 * contractual Service Level Agreement only in the governing agreement, which
 * is out of this package's scope.
 *
 * Client pricing lives here; Support Specialist earnings live in the separate
 * {@link SupportCompensationPlan} — the two are never merged (FR-32/FR-35).
 *
 * `subscriptionPlanKey` optionally binds the plan to a
 * `@happyvertical/smrt-subscriptions` plan by its natural key for entitlement
 * checks — a string reference, deliberately not a package dependency.
 */

import {
  field,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  type CoverageWindow,
  DEFAULT_SEVERITY_DEFINITIONS,
  type EscalationStep,
  parseJsonField,
  parseStringArrayField,
  type ServiceTargetMinutes,
  type SeverityDefinition,
  type TimeApprovalPolicy,
} from '../types.js';

/** Default target minutes applied when a plan omits a severity's targets. */
export const DEFAULT_TARGET_MINUTES: ServiceTargetMinutes = {
  acknowledgementMinutes: 60,
  responseMinutes: 240,
  updateMinutes: null,
  resolutionMinutes: null,
};

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'support_plans',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
  conflictColumns: ['tenant_id', 'plan_key'],
})
export class SupportPlan extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** Natural key, unique per tenant (`conflictColumns`). */
  @field({ type: 'text' })
  planKey: string = '';

  /** Display name (inherited `name` field). */
  name: string = '';

  @field({ type: 'text' })
  description: string = '';

  /** `draft` | `active` | `archived`. */
  @field({ type: 'text' })
  status: string = 'active';

  /** Channels this plan covers (JSON array of channel kinds). */
  @field({ type: 'text' })
  channels: string = '["chat","email"]';

  /** IANA timezone the coverage calendar is expressed in. */
  @field({ type: 'text' })
  timezone: string = 'UTC';

  /**
   * Coverage calendar: JSON array of {@link CoverageWindow}. Empty array
   * means 24×7 coverage (clocks always run).
   */
  @field({ type: 'text' })
  coverage: string = '[]';

  /** Holiday dates excluded from coverage (JSON array of `YYYY-MM-DD`). */
  @field({ type: 'text' })
  holidays: string = '[]';

  /**
   * Severity vocabulary for this plan: JSON map of severity key →
   * {@link SeverityDefinition}. Empty object falls back to
   * `DEFAULT_SEVERITY_DEFINITIONS`.
   */
  @field({ type: 'text' })
  severityDefinitions: string = '{}';

  /**
   * Service Targets per severity: JSON map of severity key →
   * {@link ServiceTargetMinutes}. Missing severities fall back to
   * `DEFAULT_TARGET_MINUTES`; explicit `null` minutes disable that clock.
   */
  @field({ type: 'text' })
  targets: string = '{}';

  /**
   * Case statuses that pause Service Target clocks (FR-29b: waiting periods
   * pause clocks only when the plan says so). JSON array of statuses.
   */
  @field({ type: 'text' })
  pauseStatuses: string = '["waiting_on_client"]';

  /** Escalation policy: JSON array of {@link EscalationStep}, level order. */
  @field({ type: 'text' })
  escalationPolicy: string = '[]';

  /** Recurring availability/retainer fee (0.0 = pure hourly support). */
  availabilityFeeAmount: number = 0.0;

  @field({ type: 'text' })
  currency: string = 'USD';

  /** Included support minutes per period (0 = none included). */
  includedMinutes: number = 0;

  /** Metered hourly rate for time beyond the included minutes. */
  overageHourlyRate: number = 0.0;

  /** Premium hourly rate for on-call work (0.0 = use overage rate). */
  onCallHourlyRate: number = 0.0;

  /**
   * Time-entry approval policy for work under this plan (FR-36): JSON
   * {@link TimeApprovalPolicy}. Empty object = operator approval.
   */
  @field({ type: 'text' })
  timeApprovalPolicy: string = '{}';

  /** Optional `@happyvertical/smrt-subscriptions` plan natural key binding. */
  @field({ type: 'text' })
  subscriptionPlanKey: string = '';

  @field({ type: 'text' })
  metadata: string = '{}';

  getChannels(): string[] {
    return parseStringArrayField(this.channels);
  }

  setChannels(channels: string[]): void {
    this.channels = JSON.stringify(channels ?? []);
  }

  getCoverage(): CoverageWindow[] {
    const parsed = parseJsonField<CoverageWindow[]>(this.coverage, []);
    return Array.isArray(parsed) ? parsed : [];
  }

  setCoverage(windows: CoverageWindow[]): void {
    this.coverage = JSON.stringify(windows ?? []);
  }

  getHolidays(): string[] {
    return parseStringArrayField(this.holidays);
  }

  setHolidays(dates: string[]): void {
    this.holidays = JSON.stringify(dates ?? []);
  }

  getSeverityDefinitions(): Record<string, SeverityDefinition> {
    const parsed = parseJsonField<Record<string, SeverityDefinition>>(
      this.severityDefinitions,
      {},
    );
    return Object.keys(parsed).length > 0
      ? parsed
      : { ...DEFAULT_SEVERITY_DEFINITIONS };
  }

  setSeverityDefinitions(defs: Record<string, SeverityDefinition>): void {
    this.severityDefinitions = JSON.stringify(defs ?? {});
  }

  getTargets(): Record<string, Partial<ServiceTargetMinutes>> {
    return parseJsonField(this.targets, {});
  }

  setTargets(targets: Record<string, Partial<ServiceTargetMinutes>>): void {
    this.targets = JSON.stringify(targets ?? {});
  }

  /** Effective target minutes for a severity, with defaults applied. */
  targetsForSeverity(severity: string): ServiceTargetMinutes {
    const configured = this.getTargets()[severity] ?? {};
    return { ...DEFAULT_TARGET_MINUTES, ...configured };
  }

  getPauseStatuses(): string[] {
    return parseStringArrayField(this.pauseStatuses);
  }

  setPauseStatuses(statuses: string[]): void {
    this.pauseStatuses = JSON.stringify(statuses ?? []);
  }

  getEscalationPolicy(): EscalationStep[] {
    const parsed = parseJsonField<EscalationStep[]>(this.escalationPolicy, []);
    return Array.isArray(parsed) ? parsed : [];
  }

  setEscalationPolicy(steps: EscalationStep[]): void {
    this.escalationPolicy = JSON.stringify(steps ?? []);
  }

  getTimeApprovalPolicy(): TimeApprovalPolicy {
    const parsed = parseJsonField<Partial<TimeApprovalPolicy>>(
      this.timeApprovalPolicy,
      {},
    );
    return { mode: 'operator', ...parsed };
  }

  setTimeApprovalPolicy(policy: TimeApprovalPolicy): void {
    this.timeApprovalPolicy = JSON.stringify(policy ?? {});
  }

  getMetadata(): Record<string, unknown> {
    return parseJsonField(this.metadata, {});
  }

  setMetadata(value: Record<string, unknown>): void {
    this.metadata = JSON.stringify(value ?? {});
  }

  /**
   * The plan terms captured onto a case at apply time (`planSnapshot`), so
   * later plan edits never rewrite the terms a case was handled under.
   */
  snapshotTerms(): Record<string, unknown> {
    return {
      planId: this.id,
      planKey: this.planKey,
      name: this.name,
      timezone: this.timezone,
      channels: this.getChannels(),
      coverage: this.getCoverage(),
      holidays: this.getHolidays(),
      severityDefinitions: this.getSeverityDefinitions(),
      targets: this.getTargets(),
      pauseStatuses: this.getPauseStatuses(),
      escalationPolicy: this.getEscalationPolicy(),
      availabilityFeeAmount: this.availabilityFeeAmount,
      currency: this.currency,
      includedMinutes: this.includedMinutes,
      overageHourlyRate: this.overageHourlyRate,
      onCallHourlyRate: this.onCallHourlyRate,
      timeApprovalPolicy: this.getTimeApprovalPolicy(),
      subscriptionPlanKey: this.subscriptionPlanKey,
      capturedAt: new Date().toISOString(),
    };
  }
}

export class SupportPlanCollection extends SmrtCollection<SupportPlan> {
  static readonly _itemClass = SupportPlan;

  async byPlanKey(planKey: string): Promise<SupportPlan | null> {
    const matches = await this.list({ where: { planKey }, limit: 1 });
    return matches[0] ?? null;
  }
}

export default SupportPlan;
