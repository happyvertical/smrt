/**
 * SupportCase — the canonical, tenant-scoped record of a client support
 * request (FR-28/FR-29): one Case per request across every channel, carrying
 * priority, severity, plan snapshot, lifecycle state, assignment, resolution,
 * and reopen history.
 *
 * Internal model — writes go through {@link SupportCaseService} (closed-facade
 * idiom, mirroring `smrt-chat`'s `ChatService`). The generated CRUD surface is
 * read-only (`list`/`get`); the save-time transition guard below additionally
 * rejects illegal status flips done via raw field assignment.
 */

import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  OPEN_SUPPORT_CASE_STATUSES,
  parseJsonField,
  SUPPORT_CASE_STATUS_TRANSITIONS,
  type SupportCaseStatus,
} from '../types.js';

/**
 * Status each persisted row was loaded with, for the save-time transition
 * guard. WeakMap (not a column) so it never round-trips through the DB.
 */
const loadedCaseStatus = new WeakMap<SupportCase, SupportCaseStatus>();

/** Generate a short human-facing case number (unique enough per tenant). */
export function generateCaseNumber(now: Date = new Date()): string {
  const stamp = now.getTime().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `SUP-${stamp}-${rand}`;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'support_cases',
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
})
export class SupportCase extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** Human-facing case reference (e.g. `SUP-…`), generated at open time. */
  @field({ type: 'text' })
  caseNumber: string = '';

  /** Short client-facing summary of the request. */
  @field({ type: 'text' })
  subject: string = '';

  /** Initial request text (the first inbound interaction's body). */
  @field({ type: 'text' })
  description: string = '';

  @field({ type: 'text' })
  status: SupportCaseStatus = 'new';

  /** Queue ordering priority: `low` | `normal` | `high` | `urgent`. */
  @field({ type: 'text' })
  priority: string = 'normal';

  /**
   * Severity key resolved against the plan's severity definitions (e.g.
   * `sev1`…`sev4`). Empty until triage/classification assigns one.
   */
  @field({ type: 'text' })
  severity: string = '';

  /** Classification category (AI- or human-assigned). Free vocabulary. */
  @field({ type: 'text' })
  category: string = '';

  /** Whether the subject matter was flagged sensitive (handoff trigger). */
  @field({ type: 'boolean' })
  sensitive: boolean = false;

  /** Origin transport kind (`chat` | `email` | …). */
  @field({ type: 'text' })
  channelKind: string = '';

  /**
   * The Client this Case belongs to (FR-29) — a `Person` or `Organization`
   * Profile. Nullable so unmatched inbound email can park a Case for triage;
   * intake marks those with `metadata.unresolvedClient`.
   */
  @crossPackageRef('@happyvertical/smrt-profiles:Profile', { nullable: true })
  clientProfileId: string | null = null;

  /** The person who opened the request, when distinct from the Client. */
  @crossPackageRef('@happyvertical/smrt-profiles:Profile', { nullable: true })
  openedByProfileId: string | null = null;

  /**
   * App-defined Project reference (a client initiative, not a repo board).
   * Deliberately a plain string — the consuming app owns the Project concept.
   */
  @field({ type: 'text', nullable: true })
  projectId: string | null = null;

  /** Channel binding that created this case, when intake-created. */
  @foreignKey('SupportChannelBinding')
  bindingId: string | null = null;

  /**
   * Deterministic conversation key used by create-or-join intake dedup
   * (e.g. `chat:<roomId>[:<threadId>]` or `email:<rfc-message-id>`).
   */
  @field({ type: 'text' })
  threadKey: string = '';

  /** Managed Support Plan governing this case, when one applies. */
  @foreignKey('SupportPlan')
  planId: string | null = null;

  /**
   * JSON snapshot of the plan terms captured when the plan was applied, so
   * later plan edits never rewrite the terms a case was handled under.
   * Read through {@link getPlanSnapshot}.
   */
  @field({ type: 'text' })
  planSnapshot: string = '{}';

  @foreignKey('SupportSpecialist')
  assignedSpecialistId: string | null = null;

  assignedAt: Date | null = null;

  /** Client/plan preferred specialist considered first by routing (FR-30). */
  @foreignKey('SupportSpecialist')
  preferredSpecialistId: string | null = null;

  /** Current escalation level (0 = never escalated). */
  escalationLevel: number = 0;

  escalatedAt: Date | null = null;

  /** First outbound acknowledgement of any kind (starts as `null`). */
  acknowledgedAt: Date | null = null;

  /** First substantive outbound response (specialist or agent). */
  firstRespondedAt: Date | null = null;

  /** Set when the client explicitly requested a human (FR-28b). */
  humanRequestedAt: Date | null = null;

  resolvedAt: Date | null = null;

  @crossPackageRef('@happyvertical/smrt-profiles:Profile', { nullable: true })
  resolvedByProfileId: string | null = null;

  /** How the case was resolved: `automated` | `human` | `delivery`. */
  @field({ type: 'text' })
  resolutionKind: string = '';

  @field({ type: 'text' })
  resolutionSummary: string = '';

  closedAt: Date | null = null;

  /** Times this case was reopened; prior resolutions live in case events. */
  reopenCount: number = 0;

  lastReopenedAt: Date | null = null;

  /** Per-case escape hatch: disable the AI workflow for this case only. */
  @field({ type: 'boolean' })
  aiEnabled: boolean = true;

  @field({ type: 'text' })
  metadata: string = '{}';

  /** Whether the case is in an open (not resolved/closed) state. */
  isOpen(): boolean {
    return OPEN_SUPPORT_CASE_STATUSES.includes(this.status);
  }

  getMetadata(): Record<string, unknown> {
    return parseJsonField(this.metadata, {});
  }

  setMetadata(value: Record<string, unknown>): void {
    this.metadata = JSON.stringify(value ?? {});
  }

  updateMetadata(patch: Record<string, unknown>): void {
    this.setMetadata({ ...this.getMetadata(), ...patch });
  }

  getPlanSnapshot(): Record<string, unknown> {
    return parseJsonField(this.planSnapshot, {});
  }

  setPlanSnapshot(value: Record<string, unknown>): void {
    this.planSnapshot = JSON.stringify(value ?? {});
  }

  /**
   * Capture the status the row was loaded with so the save-time guard can
   * reject illegal flips made via raw field assignment.
   */
  override async initialize(): Promise<this> {
    await super.initialize();
    if (await this.isSaved()) {
      loadedCaseStatus.set(this, this.status);
    }
    return this;
  }

  /** Validate the status transition before persisting, then save. */
  override async save(): Promise<this> {
    const prior = await this.resolvePriorStatus();
    this.assertStatusTransition(prior);
    const result = (await super.save()) as this;
    loadedCaseStatus.set(this, this.status);
    return result;
  }

  protected assertStatusTransition(prior: SupportCaseStatus | undefined): void {
    if (prior === undefined) return; // new row — any starting status
    if (prior === this.status) return; // no-op re-save
    const allowed = SUPPORT_CASE_STATUS_TRANSITIONS[prior] ?? [];
    if (!allowed.includes(this.status)) {
      throw new Error(
        `SupportCase ${this.caseNumber || this.id}: illegal status transition ` +
          `'${prior}' → '${this.status}'.`,
      );
    }
  }

  /**
   * Resolve the AUTHORITATIVE prior status. The WeakMap only covers rows
   * hydrated through {@link initialize}; a `create({ id, _skipLoad: true })`
   * upsert would otherwise look brand-new and skip the guard, so when the
   * instance carries an id, read the persisted row directly (S5 #1390 idiom).
   */
  protected async resolvePriorStatus(): Promise<SupportCaseStatus | undefined> {
    if (this.id) {
      try {
        const row = await this.db.get(this.tableName, { id: this.id });
        if (row && row.status != null) {
          return row.status as SupportCaseStatus;
        }
      } catch {
        // DB not ready / table absent — fall through to the in-memory record.
      }
    }
    return loadedCaseStatus.get(this);
  }
}

export class SupportCaseCollection extends SmrtCollection<SupportCase> {
  static readonly _itemClass = SupportCase;

  /**
   * Find the open case an inbound interaction should join, by conversation
   * key (create-or-join dedup, FR-28). Returns the most recently updated open
   * case for the key, or `null` when a new case should be created.
   */
  async findOpenByThreadKey(
    threadKey: string,
    options: { bindingId?: string | null } = {},
  ): Promise<SupportCase | null> {
    const where: Record<string, unknown> = {
      threadKey,
      'status in': OPEN_SUPPORT_CASE_STATUSES,
    };
    if (options.bindingId !== undefined && options.bindingId !== null) {
      where.bindingId = options.bindingId;
    }
    const matches = await this.list({
      where,
      orderBy: 'updated_at DESC',
      limit: 1,
    });
    return matches[0] ?? null;
  }

  /** Queue listing with common filters, newest first. */
  async findQueue(
    options: {
      status?: SupportCaseStatus | SupportCaseStatus[];
      assignedSpecialistId?: string | null;
      clientProfileId?: string;
      projectId?: string;
      openOnly?: boolean;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<SupportCase[]> {
    const where: Record<string, unknown> = {};
    if (options.status !== undefined) {
      if (Array.isArray(options.status)) {
        where['status in'] = options.status;
      } else {
        where.status = options.status;
      }
    } else if (options.openOnly) {
      where['status in'] = OPEN_SUPPORT_CASE_STATUSES;
    }
    if (options.assignedSpecialistId !== undefined) {
      where.assignedSpecialistId = options.assignedSpecialistId;
    }
    if (options.clientProfileId !== undefined) {
      where.clientProfileId = options.clientProfileId;
    }
    if (options.projectId !== undefined) {
      where.projectId = options.projectId;
    }
    return this.list({
      where,
      orderBy: 'updated_at DESC',
      limit: options.limit ?? 50,
      offset: options.offset ?? 0,
    });
  }
}

export default SupportCase;
