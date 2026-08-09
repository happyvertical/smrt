import {
  crossPackageRef,
  field,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import {
  getCurrentTenant,
  isSuperAdminBypass,
  TenantIsolationError,
  tenantId,
} from '@happyvertical/smrt-tenancy';
import {
  assertDefaultValueMatchesFieldType,
  getFieldReadPermission,
  getObjectFieldMap,
  isSensitiveField,
  isTransientField,
} from '../field-definitions.js';
import {
  FIELD_POLICY_SUGGESTION_KINDS,
  FIELD_POLICY_SUGGESTION_STATUSES,
  type FieldPolicySuggestionData,
  type FieldPolicySuggestionKind,
  type FieldPolicySuggestionStatus,
} from '../types.js';

/**
 * `activeKey` sentinel for the single ACTIVE (pending) suggestion per
 * `(objectRef, fieldName, tenantId, kind)`. Settled rows key themselves by id,
 * so history never competes for the slot.
 */
export const ACTIVE_SUGGESTION_KEY = 'active';

export interface FieldPolicySuggestionOptions extends SmrtObjectOptions {
  objectRef?: string;
  fieldName?: string;
  tenantId?: string;
  kind?: FieldPolicySuggestionKind;
  proposedValue?: string | null;
  evidence?: string;
  status?: FieldPolicySuggestionStatus;
  cooldownUntil?: Date | null;
  decidedBy?: string | null;
  decidedAt?: Date | null;
}

/**
 * A pending, human-reviewable field-policy improvement proposed from real
 * usage (epic #2045, issue #2051): promote a field to the `basic` tier, or
 * seed an org default with the dominant observed value.
 *
 * Suggestion-first by design — a row DOES NOTHING until a
 * `fields.policy.manage` holder accepts it, and acceptance writes the
 * org-scope {@link ../models/FieldPolicy.FieldPolicy} row through NORMAL
 * validation (registry check, type check, security rail, required-field
 * invariant, ownership + permission split). Dismissing sets a cool-down that
 * suppresses regeneration of the same suggestion.
 *
 * **One ACTIVE suggestion per identity, structurally** (not merely by a
 * check-then-insert): {@link activeKey} is a computed column holding the
 * sentinel {@link ACTIVE_SUGGESTION_KEY} while the row is `pending` and the
 * row's own id once it settles, and it participates in `conflictColumns`. The
 * unique index therefore admits at most ONE pending row per
 * `(objectRef, fieldName, tenantId, kind)` while every settled row keys
 * itself — so two overlapping generation runs (e.g. a global and a
 * tenant-specific schedule) UPSERT onto the same row instead of duplicating,
 * with no transaction spanning their reads. It is the `FieldPolicy.scopeKey`
 * trick applied to a lifecycle slot. On settle the column flips to the row's
 * id, which frees the slot for a post-cool-down regeneration while keeping the
 * dismissed/accepted history (and its id) intact — core conflicts a persisted
 * row on its primary key (#1472), so the flip is a plain UPDATE.
 *
 * #1885 seam: this substrate is fully independent of personas'
 * `DirectiveProposal` review queue (no shared producer discriminator —
 * deliberately out of scope). Tenant learning agents MAY create
 * FieldPolicySuggestion rows through this model's normal validation; the
 * reviewed `fields.policy.manage` acceptance gate is unchanged by who
 * proposed.
 */
// Generated surfaces are CLOSED: reads would enumerate every tenant's
// suggestion queue (the model is not class-level tenant-scoped, see below),
// and generated writes would let callers forge evidence or flip status
// without the gate. All access goes through the collection's scoped actions
// (`pendingSuggestions`, `acceptSuggestion`, `dismissSuggestion`) or trusted
// server-side code.
@smrt({
  tableName: '_smrt_field_policy_suggestions',
  conflictColumns: [
    'object_ref',
    'field_name',
    'tenant_id',
    'kind',
    'active_key',
  ],
  api: { include: [] },
  cli: false,
  mcp: { include: [] },
})
export class FieldPolicySuggestion extends SmrtObject {
  /** Qualified class name of the target object (`@package/name:ClassName`). */
  @field({ required: true })
  objectRef: string = '';

  /** Field name on the target object (validated against the registry). */
  @field({ required: true })
  fieldName: string = '';

  /** Owning tenant (required — suggestions always target one org). */
  @tenantId()
  tenantId?: string;

  /** What the suggestion proposes ('promote' | 'default'). */
  @field({ required: true })
  kind: FieldPolicySuggestionKind = 'promote';

  /**
   * JSON-encoded proposed default (`kind: 'default'` only) — the exact
   * encoding `FieldPolicy.defaultValue` stores, so acceptance passes it
   * through unchanged. NULL for `promote`.
   */
  @field({ type: 'text', nullable: true })
  proposedValue: string | null = null;

  /**
   * Human-readable evidence as a JSON string: a `summary` sentence plus the
   * structured window/threshold numbers behind it (see
   * `buildFieldUsageEvidence`).
   */
  @field({ type: 'text' })
  evidence: string = '{}';

  /** Lifecycle status ('pending' | 'accepted' | 'dismissed'). */
  @field({ required: true })
  status: FieldPolicySuggestionStatus = 'pending';

  /**
   * Computed lifecycle-slot key, set in `save()`: {@link ACTIVE_SUGGESTION_KEY}
   * while `pending`, else the row's own id. It exists ONLY to make the
   * `conflictColumns` unique index express "at most one ACTIVE suggestion per
   * identity, unlimited settled history" (the `FieldPolicy.scopeKey`
   * precedent) — never read it for logic; `status` owns that.
   */
  @field({ type: 'text', required: true })
  activeKey: string = ACTIVE_SUGGESTION_KEY;

  /**
   * Until this instant, a dismissed suggestion suppresses regeneration of the
   * same `(objectRef, fieldName, tenantId, kind)` suggestion. NULL until
   * dismissed.
   */
  @field({ type: 'datetime', nullable: true })
  cooldownUntil: Date | null = null;

  /** Who accepted/dismissed (audit attribution, #2050); not validated. */
  @crossPackageRef('@happyvertical/smrt-users:User', { nullable: true })
  decidedBy: string | null = null;

  /** When the suggestion was accepted/dismissed. */
  @field({ type: 'datetime', nullable: true })
  decidedAt: Date | null = null;

  constructor(options: FieldPolicySuggestionOptions = {}) {
    super(options);
    if (options.objectRef !== undefined) this.objectRef = options.objectRef;
    if (options.fieldName !== undefined) this.fieldName = options.fieldName;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.kind !== undefined) this.kind = options.kind;
    if (options.proposedValue !== undefined) {
      this.proposedValue = options.proposedValue;
    }
    if (options.evidence !== undefined) this.evidence = options.evidence;
    if (options.status !== undefined) this.status = options.status;
    if (options.cooldownUntil !== undefined) {
      this.cooldownUntil = options.cooldownUntil;
    }
    if (options.decidedBy !== undefined) this.decidedBy = options.decidedBy;
    if (options.decidedAt !== undefined) this.decidedAt = options.decidedAt;
  }

  /** Parse the stored evidence object (guarded; junk parses as empty). */
  getEvidence(): Record<string, unknown> {
    try {
      const parsed = JSON.parse(this.evidence);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  /** Serialize an evidence object into the stored JSON string. */
  setEvidence(evidence: Record<string, unknown>): void {
    this.evidence = JSON.stringify(evidence);
  }

  /** Parse the proposed value; `undefined` when none is stored. */
  getProposedValue(): unknown {
    if (this.proposedValue === null || this.proposedValue === undefined) {
      return undefined;
    }
    try {
      return JSON.parse(this.proposedValue);
    } catch {
      return undefined;
    }
  }

  /** Serialized row shape for the collection actions. */
  toSuggestionData(): FieldPolicySuggestionData {
    return {
      id: String(this.id),
      objectRef: this.objectRef,
      fieldName: this.fieldName,
      tenantId: String(this.tenantId ?? ''),
      kind: this.kind,
      proposedValue: this.proposedValue ?? null,
      evidence: this.getEvidence(),
      status: this.status,
      cooldownUntil: toIsoOrNull(this.cooldownUntil),
      decidedBy: this.decidedBy ?? null,
      decidedAt: toIsoOrNull(this.decidedAt),
    };
  }

  override async save(): Promise<this> {
    await this.assertRowOwnedByAmbientContext('save');
    await this.validateFieldPolicySuggestion();
    this.applyActiveKey();
    return super.save();
  }

  /**
   * Recompute the lifecycle-slot key: the shared sentinel while pending (so
   * the unique index admits exactly one), the row's own id once settled (so
   * history never competes for the slot and the freed slot allows a
   * post-cool-down regeneration). A settled row that has not been persisted
   * yet is assigned its id here — the key must be unique from the first write.
   */
  private applyActiveKey(): void {
    if (this.status === 'pending') {
      this.activeKey = ACTIVE_SUGGESTION_KEY;
      return;
    }
    if (!this.id) {
      this.id = crypto.randomUUID();
    }
    this.activeKey = String(this.id);
  }

  override async delete(): Promise<void> {
    await this.assertRowOwnedByAmbientContext('delete');
    await super.delete();
  }

  /**
   * The "normal validation" the #1885 seam promises producers: registry-known
   * field, policy-addressable, never sensitive/read-permission-gated/transient
   * (those fields are count-only in usage data and get no suggestions), valid
   * kind/status, and for `default` suggestions a JSON proposed value that
   * type-checks against the manifest field type.
   */
  private async validateFieldPolicySuggestion(): Promise<void> {
    if (!this.objectRef || this.objectRef.trim() === '') {
      throw new Error('FieldPolicySuggestion.objectRef is required');
    }
    if (!this.fieldName || this.fieldName.trim() === '') {
      throw new Error('FieldPolicySuggestion.fieldName is required');
    }
    if (!this.tenantId) {
      throw new Error('FieldPolicySuggestion.tenantId is required');
    }
    if (!FIELD_POLICY_SUGGESTION_KINDS.includes(this.kind)) {
      throw new Error(
        `FieldPolicySuggestion.kind must be one of ` +
          `${FIELD_POLICY_SUGGESTION_KINDS.join(', ')}; got "${this.kind}"`,
      );
    }
    if (!FIELD_POLICY_SUGGESTION_STATUSES.includes(this.status)) {
      throw new Error(
        `FieldPolicySuggestion.status must be one of ` +
          `${FIELD_POLICY_SUGGESTION_STATUSES.join(', ')}; got "${this.status}"`,
      );
    }

    const fields = await getObjectFieldMap(this.objectRef);
    const fieldDef = fields.get(this.fieldName);
    if (!fieldDef) {
      throw new Error(
        `Unknown field "${this.fieldName}" on "${this.objectRef}"`,
      );
    }
    if (
      fieldDef._meta?.__smrtSystemField === true ||
      fieldDef.type === 'oneToMany' ||
      fieldDef.type === 'manyToMany' ||
      fieldDef.type === 'meta'
    ) {
      throw new Error(
        `Field "${this.fieldName}" on "${this.objectRef}" is not ` +
          `policy-addressable, so it cannot carry a suggestion`,
      );
    }
    if (
      isSensitiveField(fieldDef) ||
      getFieldReadPermission(fieldDef) !== undefined ||
      isTransientField(fieldDef)
    ) {
      throw new Error(
        `Field "${this.fieldName}" on "${this.objectRef}" is sensitive, ` +
          `read-permission-gated, or transient; usage data for it is ` +
          `count-only and it cannot carry a suggestion`,
      );
    }

    if (this.kind === 'default') {
      if (this.proposedValue === null) {
        throw new Error(
          "FieldPolicySuggestion of kind 'default' requires a proposedValue",
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(this.proposedValue);
      } catch (error) {
        throw new Error(
          `FieldPolicySuggestion.proposedValue is not valid JSON: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
      assertDefaultValueMatchesFieldType(
        this.objectRef,
        this.fieldName,
        fieldDef,
        parsed,
      );
    } else if (this.proposedValue !== null) {
      throw new Error(
        "FieldPolicySuggestion of kind 'promote' must not carry a proposedValue",
      );
    }
  }

  /**
   * Tenant write boundary (the FieldPolicy posture): inside a non-bypass
   * tenant context a caller may only touch its own tenant's suggestions —
   * checked against BOTH the in-memory scope and, for persisted rows, the
   * PERSISTED tenant (a foreign row cannot be re-scoped into the caller's
   * tenant). Trusted execution (no context / bypass) is exempt — that is what
   * lets the scheduled generation job and platform flows operate.
   */
  private async assertRowOwnedByAmbientContext(
    operation: 'save' | 'delete',
  ): Promise<void> {
    const context = getCurrentTenant();
    if (!context || isSuperAdminBypass()) {
      return;
    }
    if (this.tenantId !== context.tenantId) {
      throw new TenantIsolationError(
        `Tenant isolation violation in FieldPolicySuggestion.${operation}: ` +
          `context tenant is '${context.tenantId}' but the row belongs to ` +
          `'${this.tenantId}'`,
        {
          tenantId: context.tenantId,
          attemptedTenantId: this.tenantId ?? undefined,
        },
      );
    }
    if (this.id) {
      const persisted = await this.db.get(this.tableName, { id: this.id });
      if (persisted) {
        const row = persisted as Record<string, unknown>;
        const persistedTenant =
          row.tenantId ?? row.tenant_id ?? this.tenantId ?? null;
        if (
          persistedTenant !== null &&
          String(persistedTenant) !== context.tenantId
        ) {
          throw new TenantIsolationError(
            `Tenant isolation violation in FieldPolicySuggestion.` +
              `${operation}: the persisted row belongs to ` +
              `'${String(persistedTenant)}'`,
            {
              tenantId: context.tenantId,
              attemptedTenantId: String(persistedTenant),
            },
          );
        }
      }
    }
  }
}

function toIsoOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
