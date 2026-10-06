/**
 * LeadCollection — collection manager for Lead, including qualification into
 * opportunities, audited duplicate merges, and merge-aware history reads.
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { getTenantId, TenantContextError } from '@happyvertical/smrt-tenancy';
import { Lead } from '../models/Lead.js';
import type { Opportunity } from '../models/Opportunity.js';
import type { PipelineDefinition } from '../models/PipelineDefinition.js';
import type { PipelineStage } from '../models/PipelineStage.js';
import type { SalesActivity } from '../models/SalesActivity.js';
import type { SalesRepresentative } from '../models/SalesRepresentative.js';
import {
  emptyLeadInboxStatusCounts,
  type LeadInboxOptions,
  type LeadInboxResult,
  type NormalizedLeadInboxOptions,
  normalizeLeadInboxOptions,
} from '../services/lead-inbox.js';
import type {
  LeadStatus,
  MergeLeadsParams,
  MergeLeadsResult,
  QualifyLeadParams,
} from '../types.js';
import { OpportunityCollection } from './OpportunityCollection.js';
import { PipelineDefinitionCollection } from './PipelineDefinitionCollection.js';
import { SalesActivityCollection } from './SalesActivityCollection.js';
import { SalesRepresentativeCollection } from './SalesRepresentativeCollection.js';

/**
 * Winner contact fields that {@link LeadCollection.mergeLeads} fills from the
 * loser when (and only when) the winner's value is empty. Non-empty winner
 * data is never overwritten.
 */
const MERGE_FILL_CONTACT_FIELDS = [
  'contactName',
  'email',
  'phone',
  'organizationName',
] as const;

/** Narrow a possibly-unset SmrtObject id into a usable string. */
function requireId(value: string | null | undefined, what: string): string {
  if (!value) {
    throw new Error(`LeadCollection: ${what} has no id`);
  }
  return value;
}

export class LeadCollection extends SmrtCollection<Lead> {
  static readonly _itemClass = Lead;

  private opportunityCollectionPromise: Promise<OpportunityCollection> | null =
    null;
  private pipelineCollectionPromise: Promise<PipelineDefinitionCollection> | null =
    null;
  private activityCollectionPromise: Promise<SalesActivityCollection> | null =
    null;
  private representativeCollectionPromise: Promise<SalesRepresentativeCollection> | null =
    null;

  /** Sibling opportunity collection sharing this collection's DB connection. */
  private async getOpportunityCollection(): Promise<OpportunityCollection> {
    if (!this.opportunityCollectionPromise) {
      this.opportunityCollectionPromise = OpportunityCollection.create({
        db: this.db,
        _reuseInitializedDb: true,
        _deferRuntimeInitialization: true,
      });
    }
    return this.opportunityCollectionPromise;
  }

  /** Sibling pipeline collection sharing this collection's DB connection. */
  private async getPipelineCollection(): Promise<PipelineDefinitionCollection> {
    if (!this.pipelineCollectionPromise) {
      this.pipelineCollectionPromise = PipelineDefinitionCollection.create({
        db: this.db,
        _reuseInitializedDb: true,
        _deferRuntimeInitialization: true,
      });
    }
    return this.pipelineCollectionPromise;
  }

  /** Sibling activity collection sharing this collection's DB connection. */
  private async getActivityCollection(): Promise<SalesActivityCollection> {
    if (!this.activityCollectionPromise) {
      this.activityCollectionPromise = SalesActivityCollection.create({
        db: this.db,
        _reuseInitializedDb: true,
        _deferRuntimeInitialization: true,
      });
    }
    return this.activityCollectionPromise;
  }

  /** Sibling representative collection sharing this collection's DB connection. */
  private async getRepresentativeCollection(): Promise<SalesRepresentativeCollection> {
    if (!this.representativeCollectionPromise) {
      this.representativeCollectionPromise =
        SalesRepresentativeCollection.create({
          db: this.db,
          _reuseInitializedDb: true,
          _deferRuntimeInitialization: true,
        });
    }
    return this.representativeCollectionPromise;
  }

  /** Leads in a given lifecycle status, newest first. */
  async findByStatus(status: LeadStatus): Promise<Lead[]> {
    return await this.list({
      where: { status },
      orderBy: 'created_at DESC',
    });
  }

  /** Leads owned by a given sales rep, newest first. */
  async findByOwner(ownerRepId: string): Promise<Lead[]> {
    return await this.list({
      where: { ownerRepId },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Return one tenant's Lead inbox with exact pagination and tab counts.
   *
   * `total` applies every requested filter. `statusCounts` applies the same
   * owner and search scope, but deliberately ignores status/unassigned/overdue
   * so a host can switch tabs without issuing a second request. Search is a
   * trimmed, case-insensitive literal substring across name, contact name,
   * email, phone, and organization. `next_action` sorts the earliest open task
   * first and places Leads without an open task last. Every order has an id
   * tie-breaker, so offset pages remain stable while the underlying data does.
   *
   * The read performs a constant number of queries: page, counts, earliest
   * open tasks, and owners. It requires ambient tenancy and applies an explicit
   * tenant predicate to both Lead and activity SQL.
   */
  async listInbox(options: LeadInboxOptions): Promise<LeadInboxResult> {
    const tenantId = getTenantId();
    if (!tenantId) {
      throw new TenantContextError(
        'LeadCollection.listInbox: an ambient tenant context is required',
      );
    }
    const normalized = normalizeLeadInboxOptions(options);
    const now = normalized.now.toISOString();
    const readScope = await this.resolveListReadPredicate();
    const base = buildInboxBasePredicate(normalized, tenantId, readScope);
    const tab = buildInboxTabPredicate(normalized, now);
    const nextActionsCte = inboxNextActionsCte();
    const orderBy = inboxOrderBy(normalized.sort);

    const leads = await this.query(
      `${nextActionsCte.sql}
       SELECT l.*
       FROM ${this.tableName} l
       LEFT JOIN inbox_next_actions na ON na.subject_id = CAST(l.id AS TEXT)
       WHERE (${base.sql}) AND (${tab.sql})
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`,
      [
        tenantId,
        ...base.values,
        ...tab.values,
        normalized.limit,
        normalized.offset,
      ],
      { allowRawOnTenantScoped: true },
    );
    const visibleLeads = await readScope.finish(leads);

    const countResult = await this.db.query(
      `${nextActionsCte.sql}
       SELECT l.status,
              COUNT(*) AS status_count,
              SUM(CASE WHEN l.owner_rep_id IS NULL OR CAST(l.owner_rep_id AS TEXT) = '' THEN 1 ELSE 0 END) AS unassigned_count,
              SUM(CASE WHEN na.due_at < ? THEN 1 ELSE 0 END) AS overdue_count,
              SUM(CASE WHEN ${tab.sql} THEN 1 ELSE 0 END) AS filtered_count
       FROM ${this.tableName} l
       LEFT JOIN inbox_next_actions na ON na.subject_id = CAST(l.id AS TEXT)
       WHERE ${base.sql}
       GROUP BY l.status`,
      tenantId,
      now,
      ...tab.values,
      ...base.values,
    );
    const statusCounts = emptyLeadInboxStatusCounts();
    let total = 0;
    for (const row of countResult.rows) {
      const status = String(row.status);
      if (status in statusCounts && status !== 'all') {
        statusCounts[status as keyof typeof statusCounts] = toInboxCount(
          row.status_count,
        );
      }
      statusCounts.all += toInboxCount(row.status_count);
      statusCounts.unassigned += toInboxCount(row.unassigned_count);
      statusCounts.overdue += toInboxCount(row.overdue_count);
      total += toInboxCount(row.filtered_count);
    }

    if (visibleLeads.length === 0) {
      return { leads: visibleLeads, items: [], total, statusCounts };
    }

    const leadIds = visibleLeads.map((lead) =>
      requireId(lead.id, 'inbox lead'),
    );
    const activities = await this.getActivityCollection();
    const idPlaceholders = leadIds.map(() => '?').join(', ');
    const nextActions = await activities.query(
      `SELECT a.*
       FROM sales_activities a
       WHERE a.tenant_id = ?
         AND a.subject_kind = 'lead'
         AND a.activity_kind = 'task'
         AND a.completed_at IS NULL
         AND a.due_at IS NOT NULL
         AND a.subject_id IN (${idPlaceholders})
         AND NOT EXISTS (
           SELECT 1 FROM sales_activities earlier
           WHERE earlier.tenant_id = a.tenant_id
             AND earlier.subject_kind = a.subject_kind
             AND earlier.subject_id = a.subject_id
             AND earlier.activity_kind = 'task'
             AND earlier.completed_at IS NULL
             AND earlier.due_at IS NOT NULL
             AND (earlier.due_at < a.due_at OR (earlier.due_at = a.due_at AND earlier.id < a.id))
         )`,
      [tenantId, ...leadIds],
      { allowRawOnTenantScoped: true },
    );
    const nextActionByLead = new Map<string, SalesActivity>(
      nextActions.map((activity) => [activity.subjectId, activity]),
    );

    const ownerIds = [
      ...new Set(
        visibleLeads.map((lead) => lead.ownerRepId).filter((id) => id !== ''),
      ),
    ];
    const owners = ownerIds.length
      ? await (await this.getRepresentativeCollection()).listByIds(ownerIds)
      : [];
    const ownerById = new Map<string, SalesRepresentative>(
      owners.map((owner) => [requireId(owner.id, 'inbox owner'), owner]),
    );
    const items = visibleLeads.map((lead) => ({
      lead,
      owner: ownerById.get(lead.ownerRepId) ?? null,
      nextAction:
        nextActionByLead.get(requireId(lead.id, 'inbox lead')) ?? null,
    }));

    return { leads: visibleLeads, items, total, statusCounts };
  }

  /**
   * Qualify a lead into an Opportunity.
   *
   * Transitions the lead to `qualified` (stamping `qualifiedAt` once) and
   * creates an Opportunity at the FIRST stage of the target pipeline —
   * `pipelineId` when given, otherwise the seeded default pipeline
   * (`ensureDefaultPipeline()`). The opportunity adopts the first stage's
   * probability, copies the lead's `sourceKind`/`sourceId` for reporting,
   * and defaults its name/owner from the lead. A `qualification`
   * SalesActivity is written on BOTH the lead and the opportunity.
   *
   * IDEMPOTENT: when the lead is already `qualified` and an opportunity
   * exists for it, that opportunity is returned unchanged (no new rows, no
   * new activities). A qualified lead with no opportunity (interrupted
   * earlier run) is healed by creating the missing opportunity.
   *
   * Illegal source statuses are rejected by the lead's save-time transition
   * guard (`disqualified`/`merged` leads cannot be qualified).
   *
   * @returns The (existing or newly created) opportunity
   */
  async qualify(params: QualifyLeadParams): Promise<Opportunity> {
    const lead = await this.get({ id: params.leadId });
    if (!lead) {
      throw new Error(
        `LeadCollection.qualify: lead '${params.leadId}' not found`,
      );
    }
    const leadId = requireId(lead.id, `lead '${params.leadId}'`);

    const opportunities = await this.getOpportunityCollection();
    if (lead.status === 'qualified') {
      const existing = await opportunities.findByLead(leadId);
      if (existing[0]) {
        return existing[0];
      }
    }

    // Resolve the target pipeline and its entry stage BEFORE mutating the
    // lead, so a bad pipelineId leaves the lead untouched.
    const pipelines = await this.getPipelineCollection();
    let pipeline: PipelineDefinition;
    let stages: PipelineStage[];
    if (params.pipelineId) {
      const found = await pipelines.get({ id: params.pipelineId });
      if (!found) {
        throw new Error(
          `LeadCollection.qualify: pipeline '${params.pipelineId}' not found`,
        );
      }
      pipeline = found;
      stages = await pipelines.getStages(requireId(pipeline.id, 'pipeline'));
    } else {
      ({ pipeline, stages } = await pipelines.ensureDefaultPipeline({
        ...(lead.tenantId !== null ? { tenantId: lead.tenantId } : {}),
      }));
    }
    const firstStage = stages[0];
    if (!firstStage) {
      throw new Error(
        `LeadCollection.qualify: pipeline '${pipeline.key || pipeline.id}' has no stages`,
      );
    }

    if (lead.status !== 'qualified') {
      lead.status = 'qualified'; // save-guard rejects illegal transitions
      if (!lead.qualifiedAt) {
        lead.qualifiedAt = params.now ?? new Date();
      }
      await lead.save();
    }

    const opportunity = await opportunities.create({
      ...(lead.tenantId !== null ? { tenantId: lead.tenantId } : {}),
      name: params.opportunityName ?? lead.name,
      leadId,
      ownerRepId: params.ownerRepId ?? lead.ownerRepId,
      pipelineId: pipeline.id ?? '',
      stageId: firstStage.id ?? '',
      probability: firstStage.probability,
      expectedValueCents: params.expectedValueCents ?? 0,
      currency: params.currency ?? 'USD',
      expectedCloseAt: params.expectedCloseAt ?? null,
      status: 'open',
      sourceKind: lead.sourceKind,
      sourceId: lead.sourceId,
    });
    const opportunityId = requireId(opportunity.id, 'created opportunity');

    const activities = await this.getActivityCollection();
    const tenantScope =
      lead.tenantId !== null ? { tenantId: lead.tenantId } : {};
    await activities.create({
      ...tenantScope,
      subjectKind: 'lead',
      subjectId: leadId,
      activityKind: 'qualification',
      summary: `Qualified into opportunity '${opportunity.name}'`,
      actorProfileId: params.actorProfileId ?? '',
      metadata: JSON.stringify({
        opportunityId,
        pipelineId: pipeline.id ?? '',
        stageId: firstStage.id ?? '',
        stageKey: firstStage.key,
      }),
    });
    await activities.create({
      ...tenantScope,
      subjectKind: 'opportunity',
      subjectId: opportunityId,
      activityKind: 'qualification',
      summary: `Created from qualified lead '${lead.name}'`,
      actorProfileId: params.actorProfileId ?? '',
      metadata: JSON.stringify({
        leadId,
        pipelineId: pipeline.id ?? '',
        stageId: firstStage.id ?? '',
        stageKey: firstStage.key,
      }),
    });

    return opportunity;
  }

  /**
   * Audited duplicate merge: fold the `loserId` lead into the `winnerId`
   * lead.
   *
   * Validations: the ids must differ, both leads must exist, the loser must
   * not already be merged, the winner must not itself be merged (merge into
   * the chain head instead), and the merge must not create a
   * `mergedIntoId` cycle.
   *
   * Effects:
   * - EMPTY winner contact fields (`contactName`/`email`/`phone`/
   *   `organizationName`) are filled from the loser; non-empty winner data
   *   is never overwritten;
   * - the loser's acquisition context is appended into the winner's under a
   *   `mergedSources` array (both histories preserved verbatim);
   * - the loser becomes terminal: `status: 'merged'` +
   *   `mergedIntoId: winnerId`;
   * - a `merge` SalesActivity is written on BOTH leads, each carrying a full
   *   pre-merge loser snapshot in metadata;
   * - the loser's existing activities STAY attached to the loser (history
   *   preserved in place) — read the combined trail via
   *   {@link activitiesIncludingMerged}.
   */
  async mergeLeads(params: MergeLeadsParams): Promise<MergeLeadsResult> {
    const { winnerId, loserId } = params;
    if (winnerId === loserId) {
      throw new Error(
        `LeadCollection.mergeLeads: winner and loser must be distinct leads (got '${winnerId}' twice)`,
      );
    }
    const winner = await this.get({ id: winnerId });
    if (!winner) {
      throw new Error(
        `LeadCollection.mergeLeads: winner lead '${winnerId}' not found`,
      );
    }
    const loser = await this.get({ id: loserId });
    if (!loser) {
      throw new Error(
        `LeadCollection.mergeLeads: loser lead '${loserId}' not found`,
      );
    }
    if (loser.status === 'merged') {
      throw new Error(
        `LeadCollection.mergeLeads: lead '${loserId}' is already merged into '${loser.mergedIntoId}'`,
      );
    }
    if (winner.status === 'merged') {
      throw new Error(
        `LeadCollection.mergeLeads: winner lead '${winnerId}' has itself been merged into ` +
          `'${winner.mergedIntoId}' — merge into the chain head instead`,
      );
    }

    // Cycle guard (defense in depth for raw-set mergedIntoId data): walking
    // the winner's merge ancestry must never reach the loser.
    const visited = new Set<string>([winnerId]);
    let cursor = winner.mergedIntoId;
    while (cursor) {
      if (cursor === loserId) {
        throw new Error(
          `LeadCollection.mergeLeads: merging '${loserId}' into '${winnerId}' would create a merge cycle`,
        );
      }
      if (visited.has(cursor)) break; // pre-existing cycle in data — stop walking
      visited.add(cursor);
      const ancestor = await this.get({ id: cursor });
      cursor = ancestor?.mergedIntoId ?? '';
    }

    // Full pre-merge snapshot of the loser for both audit rows.
    const loserSnapshot = loser.toJSON() as Record<string, unknown>;

    // Fill EMPTY winner contact fields from the loser — never overwrite.
    const filledFields: string[] = [];
    for (const fieldName of MERGE_FILL_CONTACT_FIELDS) {
      if (winner[fieldName] === '' && loser[fieldName] !== '') {
        winner[fieldName] = loser[fieldName];
        filledFields.push(fieldName);
      }
    }

    // Preserve BOTH acquisition histories: append the loser's context (plus
    // its source pointer) under the winner's `mergedSources` array.
    const winnerContext = winner.getAcquisitionContext();
    const priorSources = winnerContext.mergedSources;
    const mergedSources = Array.isArray(priorSources) ? [...priorSources] : [];
    mergedSources.push({
      leadId: loserId,
      mergedAt: new Date().toISOString(),
      sourceKind: loser.sourceKind,
      sourceId: loser.sourceId,
      acquisitionContext: loser.getAcquisitionContext(),
    });
    winner.setAcquisitionContext({ ...winnerContext, mergedSources });

    await winner.save();

    loser.status = 'merged';
    loser.mergedIntoId = winnerId;
    await loser.save();

    const activities = await this.getActivityCollection();
    const actorProfileId = params.actorProfileId ?? '';
    const reason = params.reason ?? '';
    const auditDetail = {
      winnerId,
      loserId,
      reason,
      filledFields,
      loserSnapshot,
    };
    await activities.create({
      ...(winner.tenantId !== null ? { tenantId: winner.tenantId } : {}),
      subjectKind: 'lead',
      subjectId: winnerId,
      activityKind: 'merge',
      summary: `Merged duplicate lead '${loser.name}' into this lead`,
      actorProfileId,
      metadata: JSON.stringify({ ...auditDetail, direction: 'absorbed' }),
    });
    await activities.create({
      ...(loser.tenantId !== null ? { tenantId: loser.tenantId } : {}),
      subjectKind: 'lead',
      subjectId: loserId,
      activityKind: 'merge',
      summary: `Merged into lead '${winner.name}'`,
      actorProfileId,
      metadata: JSON.stringify({ ...auditDetail, direction: 'merged_away' }),
    });

    return { winner, loser };
  }

  /**
   * The lead's activity trail INCLUDING the trails of every lead merged into
   * it, transitively (losers keep their own activities; this read
   * re-assembles the full history across `mergedIntoId` chains).
   *
   * Traversal is breadth-first over merge children with a visited-set guard,
   * so malformed cyclic data cannot loop. Results are in chronological
   * order.
   */
  async activitiesIncludingMerged(leadId: string): Promise<SalesActivity[]> {
    const visited = new Set<string>();
    let frontier = [leadId];
    while (frontier.length > 0) {
      const batch = frontier.filter((id) => id && !visited.has(id));
      if (batch.length === 0) break;
      for (const id of batch) {
        visited.add(id);
      }
      const children = await this.list({
        where: { 'mergedIntoId in': batch },
      });
      frontier = children
        .map((child) => child.id ?? '')
        .filter((id) => id !== '');
    }

    const activities = await this.getActivityCollection();
    return await activities.list({
      where: { subjectKind: 'lead', 'subjectId in': Array.from(visited) },
      orderBy: ['createdAt ASC', 'id ASC'],
    });
  }
}

interface InboxSqlPredicate {
  sql: string;
  values: unknown[];
}

function inboxNextActionsCte(): InboxSqlPredicate {
  return {
    sql: `WITH inbox_next_actions AS (
      SELECT subject_id, MIN(due_at) AS due_at
      FROM sales_activities
      WHERE tenant_id = ?
        AND subject_kind = 'lead'
        AND activity_kind = 'task'
        AND completed_at IS NULL
        AND due_at IS NOT NULL
      GROUP BY subject_id
    )`,
    values: [],
  };
}

function buildInboxBasePredicate(
  options: NormalizedLeadInboxOptions,
  tenantId: string,
  readScope: { sql: string; values: unknown[] },
): InboxSqlPredicate {
  const clauses = ['l.tenant_id = ?', `(${readScope.sql})`];
  const values: unknown[] = [tenantId, ...readScope.values];
  if (options.ownerRepId) {
    clauses.push('l.owner_rep_id = ?');
    values.push(options.ownerRepId);
  }
  if (options.search) {
    const literal = options.search.toLowerCase().replace(/[!%_]/g, '!$&');
    const match = `%${literal}%`;
    clauses.push(`(
      LOWER(COALESCE(l.name, '')) LIKE ? ESCAPE '!'
      OR LOWER(COALESCE(l.contact_name, '')) LIKE ? ESCAPE '!'
      OR LOWER(COALESCE(l.email, '')) LIKE ? ESCAPE '!'
      OR LOWER(COALESCE(l.phone, '')) LIKE ? ESCAPE '!'
      OR LOWER(COALESCE(l.organization_name, '')) LIKE ? ESCAPE '!'
    )`);
    values.push(match, match, match, match, match);
  }
  return { sql: clauses.join(' AND '), values };
}

function buildInboxTabPredicate(
  options: NormalizedLeadInboxOptions,
  now: string,
): InboxSqlPredicate {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (options.status) {
    clauses.push('l.status = ?');
    values.push(options.status);
  }
  if (options.unassigned) {
    clauses.push(
      "(l.owner_rep_id IS NULL OR CAST(l.owner_rep_id AS TEXT) = '')",
    );
  }
  if (options.overdue) {
    clauses.push('na.due_at < ?');
    values.push(now);
  }
  return { sql: clauses.join(' AND ') || '1 = 1', values };
}

function inboxOrderBy(sort: NormalizedLeadInboxOptions['sort']): string {
  switch (sort) {
    case 'name':
      return 'LOWER(l.name) ASC, l.id ASC';
    case 'next_action':
      return 'CASE WHEN na.due_at IS NULL THEN 1 ELSE 0 END ASC, na.due_at ASC, l.id ASC';
    default:
      return 'l.created_at DESC, l.id ASC';
  }
}

function toInboxCount(value: unknown): number {
  const count = Number(value ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(
      `LeadCollection.listInbox: database returned invalid count '${String(value)}'`,
    );
  }
  return count;
}

export default LeadCollection;
