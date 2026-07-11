/**
 * AttributionException — the conflict-review queue and override audit trail.
 *
 * When attribution cannot conclude automatically (exact-timestamp ties,
 * competing manual assignments, or a policy whose `conflictBehavior` is
 * `review`), `AttributionService.resolve()` creates an OPEN exception
 * carrying the candidate touches and creates NO referral rows. A human (or
 * policy re-run) resolves it via `AttributionService.resolveException()`,
 * which requires a `resolutionReason`, creates the awarded referral(s), and
 * stamps the resolution audit fields here. `AttributionService.override()`
 * writes an already-RESOLVED exception row as the audit record of a
 * re-attribution.
 *
 * The generated surface is read-only (`list`/`get`): exceptions are minted
 * and resolved exclusively by the attribution service so the audit fields
 * stay trustworthy.
 *
 * @packageDocumentation
 */

import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type {
  AttributionExceptionCandidate,
  AttributionExceptionOptions,
  AttributionExceptionStatus,
} from '../types.js';

@TenantScoped({ mode: 'optional' })
@smrt({
  // Read-only generated surface: resolution happens through
  // AttributionService so reasons/actors are always recorded.
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: false,
})
export class AttributionException extends SmrtObject {
  /** Tenant ID for multi-tenant isolation (nullable → global rows). */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** Target the conflicting attribution is about. Required. */
  @field({ required: true })
  targetKind: string = '';

  /** Identifier within the {@link targetKind} namespace. Required. */
  @field({ required: true })
  targetId: string = '';

  /** The ReferralProgram the contention belongs to. */
  @foreignKey('ReferralProgram')
  programId: string = '';

  /** `open` (default, awaiting review) or `resolved`. */
  status: AttributionExceptionStatus = 'open';

  /**
   * Why the exception was raised — recommended vocabulary: `'tie'`
   * (exact-timestamp tie between distinct referrers),
   * `'competing_touches'` (competing manual assignments), and
   * `'policy_review'` (`conflictBehavior: 'review'` with multiple
   * referrers). Open string.
   */
  conflictReason: string = '';

  /**
   * The competing touches as a JSON-string array of
   * {@link AttributionExceptionCandidate}. Use
   * {@link getCandidates}/{@link setCandidates}.
   */
  candidates: string = '[]';

  /**
   * How the exception was resolved — `'override'` (human award) or
   * `'policy'` (policy re-run). Empty while open.
   */
  resolutionMode: string = '';

  /** Why credit was awarded the way it was. REQUIRED to resolve. */
  resolutionReason: string = '';

  /**
   * Who resolved the exception — cross-package string reference to a
   * smrt-profiles Profile.
   */
  @crossPackageRef('@happyvertical/smrt-profiles:Profile')
  resolvedByProfileId: string = '';

  /**
   * Ids of the Referral rows the resolution created, as a JSON-string
   * array. Use {@link getResolvedReferralIds}/{@link setResolvedReferralIds}.
   */
  resolvedReferralIds: string = '[]';

  /** When the exception was resolved. */
  resolvedAt: Date | null = null;

  /**
   * Free-form JSON object stored as a string (the attribution service
   * stamps the policy pin here for later resolution). Use
   * {@link getMetadata}/{@link setMetadata}.
   */
  metadata: string = '{}';

  constructor(options: AttributionExceptionOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.targetKind !== undefined) this.targetKind = options.targetKind;
    if (options.targetId !== undefined) this.targetId = options.targetId;
    if (options.programId !== undefined) this.programId = options.programId;
    if (options.status !== undefined) this.status = options.status;
    if (options.conflictReason !== undefined)
      this.conflictReason = options.conflictReason;
    if (options.candidates !== undefined) this.candidates = options.candidates;
    if (options.resolutionMode !== undefined)
      this.resolutionMode = options.resolutionMode;
    if (options.resolutionReason !== undefined)
      this.resolutionReason = options.resolutionReason;
    if (options.resolvedByProfileId !== undefined)
      this.resolvedByProfileId = options.resolvedByProfileId;
    if (options.resolvedReferralIds !== undefined)
      this.resolvedReferralIds = options.resolvedReferralIds;
    if (options.resolvedAt !== undefined)
      this.resolvedAt = AttributionException.coerceDate(options.resolvedAt);
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  /** Re-coerce date fields after the framework reapplies raw option values. */
  override async initialize(): Promise<this> {
    await super.initialize();
    this.resolvedAt = AttributionException.coerceDate(this.resolvedAt);
    return this;
  }

  /** Whether the exception still awaits review. */
  isOpen(): boolean {
    return this.status === 'open';
  }

  /** Parse {@link candidates}; returns `[]` on empty/invalid JSON. */
  getCandidates(): AttributionExceptionCandidate[] {
    if (!this.candidates) return [];
    try {
      const parsed = JSON.parse(this.candidates) as unknown;
      return Array.isArray(parsed)
        ? (parsed as AttributionExceptionCandidate[])
        : [];
    } catch {
      return [];
    }
  }

  /** Serialize and store {@link candidates}. */
  setCandidates(candidates: AttributionExceptionCandidate[]): void {
    this.candidates = JSON.stringify(candidates ?? []);
  }

  /** Parse {@link resolvedReferralIds}; returns `[]` on empty/invalid JSON. */
  getResolvedReferralIds(): string[] {
    if (!this.resolvedReferralIds) return [];
    try {
      const parsed = JSON.parse(this.resolvedReferralIds) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === 'string')
        : [];
    } catch {
      return [];
    }
  }

  /** Serialize and store {@link resolvedReferralIds}. */
  setResolvedReferralIds(ids: string[]): void {
    this.resolvedReferralIds = JSON.stringify(ids ?? []);
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

  /**
   * Mark the exception resolved (mutates; the caller saves). Requires a
   * non-empty reason — resolutions without a recorded rationale are
   * rejected.
   */
  markResolved(input: {
    mode: string;
    reason: string;
    resolvedByProfileId?: string;
    referralIds: string[];
    at?: Date;
  }): void {
    if (this.status !== 'open') {
      throw new Error(
        `AttributionException ${this.id ?? '<new>'}: cannot resolve from status '${this.status}'`,
      );
    }
    if (!input.reason?.trim()) {
      throw new Error(
        `AttributionException ${this.id ?? '<new>'}: a non-empty resolutionReason is required`,
      );
    }
    this.status = 'resolved';
    this.resolutionMode = input.mode;
    this.resolutionReason = input.reason;
    this.resolvedByProfileId = input.resolvedByProfileId ?? '';
    this.setResolvedReferralIds(input.referralIds);
    this.resolvedAt = input.at ?? new Date();
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

export default AttributionException;
