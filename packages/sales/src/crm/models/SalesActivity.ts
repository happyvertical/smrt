/**
 * SalesActivity — the activity, next-action, and audit trail for CRM subjects.
 * @packageDocumentation
 */

import {
  crossPackageRef,
  field,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type {
  SalesActivityOptions,
  SalesActivitySubjectKind,
} from '../types.js';

/**
 * SalesActivity is the shared trail for Leads and Opportunities: human
 * touchpoints (`note`, `call`, `email`, `meeting`), next actions (`task`
 * with `dueAt`/`completedAt`), and framework-written audit rows
 * (`assignment`, `qualification`, `stage_change`, `merge`, `status_change`).
 *
 * The subject is polymorphic by string pair — `subjectKind`
 * (`'lead' | 'opportunity'`) plus `subjectId` — deliberately NOT a typed FK
 * so one table serves both subjects. `activityKind` is an OPEN string;
 * `SALES_ACTIVITY_KINDS` exports the recommended vocabulary.
 *
 * Activities are an immutable trail: the generated surfaces expose only
 * `create`/`list`/`get` (no update/delete). Merges intentionally leave the
 * losing lead's activities attached to the loser —
 * `LeadCollection.activitiesIncludingMerged()` re-assembles the full history
 * across merge chains.
 *
 * @example
 * ```typescript
 * const activities = await SalesActivityCollection.create({ db });
 * await activities.create({
 *   subjectKind: 'lead',
 *   subjectId: lead.id,
 *   activityKind: 'task',
 *   summary: 'Send follow-up deck',
 *   dueAt: new Date('2026-08-01'),
 * });
 * const open = await activities.findOpenTasks('lead', lead.id ?? '');
 * ```
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  api: { include: ['create', 'list', 'get'] }, // immutable trail — no update/delete
  mcp: { include: ['list', 'create'] },
  cli: false,
})
export class SalesActivity extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation.
   * Nullable to support both tenant-scoped and global activities.
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** Which model the activity attaches to: `'lead'` or `'opportunity'`. */
  subjectKind: SalesActivitySubjectKind = 'lead';

  /** Id of the subject row. Required. */
  @field({ required: true })
  subjectId: string = '';

  /**
   * Kind of activity — OPEN string so consumers can extend the vocabulary
   * without schema changes. See `SALES_ACTIVITY_KINDS` for the recommended
   * kinds (framework-written rows use `qualification`, `stage_change`,
   * `merge`).
   */
  activityKind: string = 'note';

  /** One-line human-readable description. */
  summary: string = '';

  /** Next-action due date — set for `task`-like activities. */
  dueAt: Date | null = null;

  /** When the next action was completed; `null` while open. */
  completedAt: Date | null = null;

  /**
   * Profile of the human/agent who performed or recorded the activity —
   * cross-package string reference to smrt-profiles.
   */
  @crossPackageRef('@happyvertical/smrt-profiles:Profile')
  actorProfileId: string = '';

  /**
   * Free-form JSON object stored as a string (framework audit rows carry
   * structured detail here, e.g. `stage_change` from/to ids or the full
   * loser snapshot on `merge`). Use {@link getMetadata}/{@link setMetadata}.
   */
  metadata: string = '{}';

  constructor(options: SalesActivityOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.subjectKind !== undefined)
      this.subjectKind = options.subjectKind;
    if (options.subjectId !== undefined) this.subjectId = options.subjectId;
    if (options.activityKind !== undefined)
      this.activityKind = options.activityKind;
    if (options.summary !== undefined) this.summary = options.summary;
    if (options.dueAt !== undefined) this.dueAt = options.dueAt;
    if (options.completedAt !== undefined)
      this.completedAt = options.completedAt;
    if (options.actorProfileId !== undefined)
      this.actorProfileId = options.actorProfileId;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  /** Whether this is an open next action (due date set, not completed). */
  isOpenTask(): boolean {
    return this.dueAt !== null && this.completedAt === null;
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

export default SalesActivity;
