/**
 * Lead — identified prospect with guarded lifecycle and audited merge support.
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
import type { LeadOptions, LeadStatus } from '../types.js';

/**
 * Legal status transitions for a Lead, keyed by the prior persisted status.
 * A status re-saved unchanged (no-op) and a brand-new row are always
 * permitted; this map governs *changes* only.
 *
 * Flow: `new → working|qualified|disqualified|merged`;
 * `working → qualified|disqualified|merged`; `qualified → merged`;
 * `disqualified → working|merged` (re-open); `merged` is terminal.
 *
 * Guards against raw mass-assignment forcing, e.g., a merged lead back to
 * `working` or a qualified lead back to `new` (commerce Contract pattern).
 */
const LEAD_STATUS_TRANSITIONS: Record<LeadStatus, LeadStatus[]> = {
  new: ['working', 'qualified', 'disqualified', 'merged'],
  working: ['qualified', 'disqualified', 'merged'],
  qualified: ['merged'],
  disqualified: ['working', 'merged'],
  merged: [],
};

/**
 * Module-scoped record of the status each Lead instance was loaded with, for
 * the save-time transition guard. WeakMap keeps it out of the schema and GCs
 * with the instance — same pattern as commerce Contract.
 */
const loadedLeadStatus = new WeakMap<Lead, LeadStatus>();

/**
 * Lead is an identified prospect: a person/organization that showed intent
 * but has not yet been qualified into an Opportunity.
 *
 * Acquisition provenance is generic — `sourceKind`/`sourceId` name where the
 * lead came from (a campaign, an import, a referral, a form, …) without this
 * module knowing referral semantics; `acquisitionContext` preserves the raw
 * acquisition payload as JSON, and audited merges append the loser's context
 * under a `mergedSources` array so no acquisition history is ever lost.
 *
 * Leads are never deleted (audit trail): duplicates are merged via
 * `LeadCollection.mergeLeads()` — the loser becomes terminal `merged` with
 * `mergedIntoId` pointing at the winner, and its activities stay attached.
 *
 * @example
 * ```typescript
 * const leads = await LeadCollection.create({ db });
 * const lead = await leads.create({
 *   name: 'Acme rooftop retrofit',
 *   email: 'facilities@acme.test',
 *   sourceKind: 'campaign',
 *   sourceId: 'spring-2026',
 * });
 * const opportunity = await leads.qualify({ leadId: lead.id ?? '' });
 * ```
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  api: { include: ['list', 'get', 'create', 'update'] }, // no delete — audit trail
  mcp: { include: ['list', 'get', 'create'] },
  cli: true,
})
export class Lead extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation.
   * Nullable to support both tenant-scoped and global leads.
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** Short descriptive name of the prospect/deal-to-be. Required. */
  @field({ required: true })
  name: string = '';

  /** Primary human contact name. */
  contactName: string = '';

  /** Primary contact email. */
  email: string = '';

  /** Primary contact phone. */
  phone: string = '';

  /** Prospect organization/company name. */
  organizationName: string = '';

  /**
   * Optional identity link once the prospect is a known Profile —
   * cross-package string reference to smrt-profiles.
   */
  @crossPackageRef('@happyvertical/smrt-profiles:Profile')
  profileId: string = '';

  /** Owning sales rep (assignment). Empty while unassigned. */
  @foreignKey('SalesRepresentative')
  ownerRepId: string = '';

  /** Lifecycle status; transitions are save-guarded (see module map). */
  status: LeadStatus = 'new';

  /**
   * Generic acquisition-source kind (open string): `'campaign'`,
   * `'referral'`, `'import'`, `'web_form'`, … CRM stores the pointer without
   * interpreting it — referral attribution lives in the referrals module.
   */
  sourceKind: string = '';

  /** Identifier within the `sourceKind` namespace. */
  sourceId: string = '';

  /**
   * Preserved acquisition history as a JSON object string. Use
   * {@link getAcquisitionContext}/{@link setAcquisitionContext}. Merges append
   * the losing lead's context under a `mergedSources` array — both sides'
   * histories survive.
   */
  acquisitionContext: string = '{}';

  /**
   * Generic external intake-draft reference (open string) — e.g. the id of a
   * form submission, imported CSV row, or referral intake draft that this
   * lead was materialized from.
   */
  intakeRef: string = '';

  /**
   * Winner lead this row was merged into. Set (with status `merged`) by
   * `LeadCollection.mergeLeads()`; empty for live leads. Self-referencing FK.
   */
  @foreignKey('Lead')
  mergedIntoId: string = '';

  /** When the lead was qualified into an opportunity. */
  qualifiedAt: Date | null = null;

  /**
   * Free-form JSON object stored as a string. Use
   * {@link getMetadata}/{@link setMetadata} instead of parsing manually.
   */
  metadata: string = '{}';

  constructor(options: LeadOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.name !== undefined) this.name = options.name;
    if (options.contactName !== undefined)
      this.contactName = options.contactName;
    if (options.email !== undefined) this.email = options.email;
    if (options.phone !== undefined) this.phone = options.phone;
    if (options.organizationName !== undefined)
      this.organizationName = options.organizationName;
    if (options.profileId !== undefined) this.profileId = options.profileId;
    if (options.ownerRepId !== undefined) this.ownerRepId = options.ownerRepId;
    if (options.status !== undefined) this.status = options.status;
    if (options.sourceKind !== undefined) this.sourceKind = options.sourceKind;
    if (options.sourceId !== undefined) this.sourceId = options.sourceId;
    if (options.acquisitionContext !== undefined)
      this.acquisitionContext = options.acquisitionContext;
    if (options.intakeRef !== undefined) this.intakeRef = options.intakeRef;
    if (options.mergedIntoId !== undefined)
      this.mergedIntoId = options.mergedIntoId;
    if (options.qualifiedAt !== undefined)
      this.qualifiedAt = options.qualifiedAt;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  /** Whether the lead has been folded into another lead (terminal). */
  isMerged(): boolean {
    return this.status === 'merged';
  }

  /** Whether the lead has been qualified into an opportunity. */
  isQualified(): boolean {
    return this.status === 'qualified';
  }

  /** Parse the acquisition-context JSON string; `{}` on malformed content. */
  getAcquisitionContext(): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(this.acquisitionContext);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  }

  /** Serialize and store the acquisition-context object. */
  setAcquisitionContext(context: Record<string, unknown>): void {
    this.acquisitionContext = JSON.stringify(context);
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

  /**
   * Capture the status the row was loaded with so the save-time transition
   * guard can reject illegal status flips made via raw field assignment
   * (mass-assignment on the generated update route, a stale caller, etc.).
   * Only persisted rows carry a prior status.
   */
  override async initialize(): Promise<this> {
    await super.initialize();
    if (await this.isSaved()) {
      loadedLeadStatus.set(this, this.status);
    }
    return this;
  }

  /**
   * Validate the status transition before persisting, then save. A forged
   * `status` (e.g. un-merging a merged lead) is rejected here regardless of
   * how the instance was constructed.
   */
  override async save(): Promise<this> {
    const prior = await this.resolvePriorStatus();
    this.assertLeadStatusTransition(prior);
    const result = (await super.save()) as this;
    loadedLeadStatus.set(this, this.status);
    return result;
  }

  /**
   * Reject an illegal status flip done via raw assignment. No-op transitions
   * and brand-new rows are always allowed.
   */
  protected assertLeadStatusTransition(prior: LeadStatus | undefined): void {
    if (prior === undefined) return; // new row — any starting status is fine
    if (prior === this.status) return; // no-op re-save
    const allowed = LEAD_STATUS_TRANSITIONS[prior] ?? [];
    if (!allowed.includes(this.status)) {
      throw new Error(
        `Lead ${this.name || this.id}: illegal status transition ` +
          `'${prior}' → '${this.status}'.`,
      );
    }
  }

  /**
   * Resolve the AUTHORITATIVE prior status (commerce Contract pattern). The
   * WeakMap is only populated when {@link initialize} loaded the row from the
   * DB; it is empty for an instance built via
   * `collection.create({ id: <existing>, _skipLoad: true })` — the upsert
   * path that writes onto an existing row without hydrating it. Trusting an
   * empty WeakMap there would treat the write as a brand-new row and skip the
   * guard entirely (a poisonable prior-state).
   *
   * So when this instance carries an `id`, read the persisted row straight
   * from the database and treat its `status` as the prior. Only when no row
   * exists (truly new) do we fall back to the WeakMap. The raw row's `status`
   * column is single-word (no snake_case transform).
   */
  protected async resolvePriorStatus(): Promise<LeadStatus | undefined> {
    if (this.id) {
      try {
        const row = await this.db.get(this.tableName, { id: this.id });
        if (row && row.status != null) {
          return row.status as LeadStatus;
        }
      } catch {
        // DB not ready / table absent — fall through to the in-memory record.
      }
    }
    return loadedLeadStatus.get(this);
  }
}

export default Lead;
