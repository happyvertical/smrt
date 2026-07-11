/**
 * ReferralTouch — immutable attribution evidence.
 *
 * A touch records that a prospect interacted with a referral artifact: a
 * link click, a code entry, a partner-submitted introduction, or an
 * operator's manual assignment. Touches are the CANDIDATE SET attribution
 * resolves over — `AttributionService.resolve()` gathers eligible touches
 * within the policy window and credits per the policy's mode.
 *
 * Immutability contract (same as the commissions module's `EarningEvent`):
 * touches are evidence. The generated surface exposes `create`/`list`/`get`
 * only (no update, no delete), and application code must treat persisted
 * rows as append-only — Referrals point at their winning touch via
 * `primaryTouchId` and AttributionExceptions embed candidate touches, so
 * rewriting a touch would orphan the audit trail. Corrections are modelled
 * as NEW touches (e.g. a `manual_assignment`).
 *
 * @packageDocumentation
 */

import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { ReferralTouchKind, ReferralTouchOptions } from '../types.js';

@TenantScoped({ mode: 'optional' })
@smrt({
  // Immutable evidence: create/list/get only — no update or delete on any
  // generated surface.
  api: { include: ['create', 'list', 'get'] },
  mcp: { include: ['list', 'create'] },
  // High-volume evidence rows are not useful from the CLI.
  cli: false,
})
export class ReferralTouch extends SmrtObject {
  /** Tenant ID for multi-tenant isolation (nullable → global touches). */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** The ReferralLink that produced this touch (empty for touchpoints
   * without a link, e.g. manual assignments). */
  @foreignKey('ReferralLink')
  linkId: string = '';

  /** The share code involved, when the touch came through a code/link. */
  code: string = '';

  /** The Referrer this touch credits. Required. */
  @foreignKey('Referrer', { required: true })
  referrerId: string = '';

  /** The ReferralProgram the touch belongs to. */
  @foreignKey('ReferralProgram')
  programId: string = '';

  /** What kind of interaction this evidence records. */
  kind: ReferralTouchKind = 'click';

  /**
   * Prospect identity when known — a generic `(subjectKind, subjectId)`
   * pair (e.g. `('lead', <id>)`, `('email', 'a@b.test')`). Attribution
   * matches touches to a resolution's subject and/or target through these.
   */
  subjectKind: string = '';

  /** Identifier within the {@link subjectKind} namespace. */
  subjectId: string = '';

  /** When the interaction occurred (not when it was ingested). */
  occurredAt: Date = new Date();

  /**
   * Evidence payload as a JSON object string (the code/link/url for clicks,
   * actor + reason for manual assignments, …). Use
   * {@link getEvidence}/{@link setEvidence}.
   */
  evidence: string = '{}';

  /**
   * Free-form JSON object stored as a string. Use
   * {@link getMetadata}/{@link setMetadata} instead of parsing manually.
   */
  metadata: string = '{}';

  constructor(options: ReferralTouchOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.linkId !== undefined) this.linkId = options.linkId;
    if (options.code !== undefined) this.code = options.code;
    if (options.referrerId !== undefined) this.referrerId = options.referrerId;
    if (options.programId !== undefined) this.programId = options.programId;
    if (options.kind !== undefined) this.kind = options.kind;
    if (options.subjectKind !== undefined)
      this.subjectKind = options.subjectKind;
    if (options.subjectId !== undefined) this.subjectId = options.subjectId;
    if (options.occurredAt !== undefined)
      this.occurredAt =
        ReferralTouch.coerceDate(options.occurredAt) ?? new Date();
    if (options.evidence !== undefined) this.evidence = options.evidence;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  /**
   * Re-coerce {@link occurredAt} after the framework reapplies raw option /
   * hydrated row values (SQLite hands back ISO strings).
   */
  override async initialize(): Promise<this> {
    await super.initialize();
    this.occurredAt = ReferralTouch.coerceDate(this.occurredAt) ?? new Date();
    return this;
  }

  /** Parse {@link evidence}; returns `{}` on empty/invalid JSON. */
  getEvidence(): Record<string, unknown> {
    if (!this.evidence) return {};
    try {
      const parsed = JSON.parse(this.evidence) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  /** Serialize and store {@link evidence}. */
  setEvidence(evidence: Record<string, unknown>): void {
    this.evidence = JSON.stringify(evidence ?? {});
  }

  /** Parse {@link metadata}; returns `{}` on malformed content. */
  getMetadata(): Record<string, unknown> {
    if (!this.metadata) return {};
    try {
      const parsed = JSON.parse(this.metadata) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  /** Serialize and store {@link metadata}. */
  setMetadata(data: Record<string, unknown>): void {
    this.metadata = JSON.stringify(data ?? {});
  }

  private static coerceDate(value: unknown): Date | null {
    if (value == null) return null;
    if (value instanceof Date) return value;
    if (typeof value === 'number' || typeof value === 'string') {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    return null;
  }
}

export default ReferralTouch;
