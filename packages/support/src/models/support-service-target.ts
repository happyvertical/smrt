/**
 * Service Target clocks and escalations (FR-30/FR-31).
 *
 * - **SupportServiceTarget** — one acknowledgement/response/update/resolution
 *   clock on a case, derived from the applicable plan's targets, coverage
 *   calendar, and pause rules. `escalationJobId` holds the one-shot
 *   `_smrt_jobs` row scheduled at `dueAt` so satisfying the target can cancel
 *   the pending escalation.
 * - **SupportEscalation** — the auditable record of one escalation firing
 *   (target breach, target risk, manual, or AI-triggered).
 *
 * Both are written by the target engine / case service only; generated
 * surfaces are read-only.
 */

import {
  field,
  foreignKey,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { backgroundEligible } from '@happyvertical/smrt-jobs';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  parseJsonField,
  parseStringArrayField,
  type ServiceTargetStatus,
  type ServiceTargetType,
  type SupportEscalationReason,
} from '../types.js';

/** Outcome of one {@link SupportServiceTarget.checkAndEscalate} delivery. */
export interface CheckAndEscalateResult {
  outcome: 'breached' | 'escalated' | 'rescheduled' | 'noop' | 'missing';
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'support_service_targets',
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
  conflictColumns: ['case_id', 'target_type', 'cycle'],
})
export class SupportServiceTarget extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @foreignKey('SupportCase', { required: true })
  caseId: string = '';

  @field({ type: 'text' })
  targetType: ServiceTargetType = 'acknowledgement';

  /**
   * Recurrence cycle for repeating clocks (`update` restarts after each
   * update). One-shot clocks stay at cycle 0.
   */
  cycle: number = 0;

  /** Severity key the minutes were derived from (audit). */
  @field({ type: 'text' })
  severity: string = '';

  /** Configured clock length in covered minutes. */
  baseMinutes: number = 0;

  /** When the clock started running. */
  startedAt: Date = new Date();

  /** Current deadline, in wall-clock time (recomputed on pause/resume). */
  dueAt: Date = new Date();

  @field({ type: 'text' })
  status: ServiceTargetStatus = 'pending';

  /** Set while the clock is paused (plan pause rules). */
  pausedAt: Date | null = null;

  /** Accumulated paused time, excluded from the clock. */
  pausedTotalSeconds: number = 0;

  satisfiedAt: Date | null = null;

  breachedAt: Date | null = null;

  cancelledAt: Date | null = null;

  /** One-shot `_smrt_jobs` id scheduled for `dueAt` (cancel on satisfy). */
  @field({ type: 'text' })
  escalationJobId: string = '';

  @field({ type: 'text' })
  metadata: string = '{}';

  getMetadata(): Record<string, unknown> {
    return parseJsonField(this.metadata, {});
  }

  setMetadata(value: Record<string, unknown>): void {
    this.metadata = JSON.stringify(value ?? {});
  }

  isRunning(): boolean {
    return this.status === 'pending';
  }

  /**
   * One-shot escalation job entry point, delivered at-least-once by the
   * jobs runner at `dueAt` (and again for delayed policy steps). Reloads its
   * own persisted state first, so stale deliveries are harmless:
   *
   * - not `pending` and no due pending-escalation marker → no-op (already
   *   satisfied/cancelled/paused, or an already-breached clock without a due
   *   follow-up step);
   * - `pending` with `dueAt` in the future → no-op (the clock was
   *   rescheduled after this job was enqueued);
   * - `pending` and overdue → mark breached and escalate through the plan's
   *   escalation policy;
   * - `breached` with a due pending-escalation marker → continue with the
   *   next policy step.
   *
   * The engine is imported dynamically to avoid a static model → service
   * cycle. `args.at` (ISO string or `Date`) pins "now" for deterministic
   * tests; the runner passes no args, so production uses wall-clock time.
   */
  @backgroundEligible()
  async checkAndEscalate(
    args?: Record<string, unknown>,
    _context?: unknown,
  ): Promise<CheckAndEscalateResult> {
    const rawAt = args?.at;
    const at =
      rawAt instanceof Date
        ? rawAt
        : typeof rawAt === 'string' && !Number.isNaN(new Date(rawAt).getTime())
          ? new Date(rawAt)
          : new Date();

    if (!this.id) {
      return { outcome: 'missing' };
    }
    // Load fresh, authoritative state — the enqueued row may be stale.
    const targets = await SupportServiceTargetCollection.create({
      db: this.db,
    });
    const fresh = await targets.get({ id: this.id });
    if (!fresh) {
      return { outcome: 'missing' };
    }

    if (fresh.status === 'pending') {
      if (fresh.dueAt.getTime() > at.getTime()) {
        return { outcome: 'rescheduled' };
      }
      fresh.breachedAt = at;
      fresh.status = 'breached';
      await fresh.save();
      const { ServiceTargetEngine } = await import(
        '../services/service-target-engine.js'
      );
      const engine = await ServiceTargetEngine.create({ db: this.db });
      await engine.escalateForBreach(fresh, { at });
      return { outcome: 'breached' };
    }

    if (fresh.status === 'breached') {
      const { ServiceTargetEngine } = await import(
        '../services/service-target-engine.js'
      );
      const engine = await ServiceTargetEngine.create({ db: this.db });
      const continued = await engine.continueEscalation(fresh, at);
      return { outcome: continued ? 'escalated' : 'noop' };
    }

    return { outcome: 'noop' };
  }
}

export class SupportServiceTargetCollection extends SmrtCollection<SupportServiceTarget> {
  static readonly _itemClass = SupportServiceTarget;

  async forCase(caseId: string): Promise<SupportServiceTarget[]> {
    return this.list({ where: { caseId }, orderBy: 'created_at ASC' });
  }

  /** Active clock of a type on a case (highest cycle wins). */
  async activeTarget(
    caseId: string,
    targetType: ServiceTargetType,
  ): Promise<SupportServiceTarget | null> {
    const matches = await this.list({
      where: { caseId, targetType, 'status in': ['pending', 'paused'] },
      orderBy: 'cycle DESC',
      limit: 1,
    });
    return matches[0] ?? null;
  }
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'support_escalations',
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
})
export class SupportEscalation extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @foreignKey('SupportCase', { required: true })
  caseId: string = '';

  /** Escalation level applied (1-based, follows the plan's policy steps). */
  level: number = 1;

  @field({ type: 'text' })
  reason: SupportEscalationReason = 'target_breach';

  /** Breached/at-risk target that triggered this, when applicable. */
  @foreignKey('SupportServiceTarget')
  targetId: string | null = null;

  @field({ type: 'text' })
  targetType: string = '';

  /** Escalation action taken: `notify` | `reassign`. */
  @field({ type: 'text' })
  action: string = 'notify';

  @foreignKey('SupportSpecialist')
  fromSpecialistId: string | null = null;

  @foreignKey('SupportSpecialist')
  toSpecialistId: string | null = null;

  /** Profiles notified (JSON array of profile ids). */
  @field({ type: 'text' })
  notifiedProfileIds: string = '[]';

  occurredAt: Date = new Date();

  @field({ type: 'text' })
  note: string = '';

  getNotifiedProfileIds(): string[] {
    return parseStringArrayField(this.notifiedProfileIds);
  }

  setNotifiedProfileIds(ids: string[]): void {
    this.notifiedProfileIds = JSON.stringify(ids ?? []);
  }
}

export class SupportEscalationCollection extends SmrtCollection<SupportEscalation> {
  static readonly _itemClass = SupportEscalation;

  async forCase(caseId: string): Promise<SupportEscalation[]> {
    return this.list({ where: { caseId }, orderBy: 'occurred_at ASC' });
  }
}

export default SupportServiceTarget;
