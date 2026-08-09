import { SmrtCollection, smrt } from '@happyvertical/smrt-core';
import {
  getCurrentTenant,
  isSuperAdminBypass,
  TenantIsolationError,
} from '@happyvertical/smrt-tenancy';
import { assertOperationPermission } from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import { invalidateFieldPolicyCache } from '../cache.js';
import { deterministicFieldsUuid } from '../deterministic-id.js';
import {
  assertDefaultValueMatchesFieldType,
  getFieldReadPermission,
  getObjectFieldMap,
  isPolicyAddressableField,
  isSensitiveField,
  isTransientField,
} from '../field-definitions.js';
import {
  ACTIVE_SUGGESTION_KEY,
  FieldPolicySuggestion,
} from '../models/FieldPolicySuggestion.js';
import { MANAGE_FIELD_POLICY_PERMISSION } from '../permissions.js';
import type {
  AcceptFieldPolicySuggestionResult,
  DismissFieldPolicySuggestionResult,
  PendingFieldPolicySuggestionsResult,
} from '../types.js';

/**
 * Raised when a pending→settled transition loses its race: another caller
 * (accept or dismiss) already settled the suggestion — whether the loss is
 * detected by the compare-and-set or by the load that preceded it, so
 * overlapping decisions get ONE error type regardless of timing.
 *
 * Carries BOTH `httpStatus` and `status` = 409. `httpStatus` is the property
 * core's generated REST error mapping honors (an integer OWN property, checked
 * with `Object.hasOwn`); `status` mirrors the users-style shape this package
 * already uses on `FieldPolicyPermissionError`. NOTE: that mapping arrived with
 * #2049 and is NOT in this branch's core yet, so until #2049 lands ahead of
 * this work the generated routes still surface these as 500s — the property is
 * set now so the 409 becomes real the moment it does.
 */
export class FieldPolicySuggestionConflictError extends Error {
  /** Core's generated-REST status contract (own integer property). */
  readonly httpStatus = 409;
  /** The users-style shape mirrored by this package's authorization errors. */
  readonly status = 409;

  constructor(operation: string, suggestionId: string) {
    super(
      `${operation}: suggestion "${suggestionId}" was already decided by ` +
        `another request (it is no longer pending)`,
    );
    this.name = 'FieldPolicySuggestionConflictError';
  }
}

/** Expected generated-route denial when the suggestion queue lacks a tenant. */
class FieldPolicySuggestionRequestContextError extends TenantIsolationError {
  readonly httpStatus = 403;
  readonly status = 403;

  constructor(message: string, details?: { tenantId?: string }) {
    super(message, details);
    this.name = 'FieldPolicySuggestionRequestContextError';
  }
}

/** Transaction handle shape (mirrors `FieldPolicy`'s identity-change path). */
type SuggestionTransactionHandle = DatabaseInterface & {
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
};

/** Options binding a collection to an open transaction (the sales precedent). */
function transactionBoundOptions(db: DatabaseInterface): {
  db: DatabaseInterface;
  _reuseInitializedDb: boolean;
  _deferRuntimeInitialization: boolean;
} {
  return {
    db,
    // The transaction database is the SAME initialized database on a pinned
    // connection — skip system-table bootstrap and runtime service setup.
    _reuseInitializedDb: true,
    _deferRuntimeInitialization: true,
  };
}

/**
 * Compare-and-set the pending→settled transition: the UPDATE only applies
 * `WHERE status = 'pending'`, so exactly one of a racing accept/dismiss pair
 * can win. Returns whether this caller claimed it.
 *
 * `RETURNING id` (not a row count) is the reliable "did it apply" signal — the
 * DuckDB/JSON adapters report an UPDATE that matched nothing as `rowCount: 1`
 * (the jobs `writeOwnedJob` precedent).
 *
 * Deliberately raw SQL rather than a model save: a conditional transition is
 * not expressible through `save()`, and routing it through the model would
 * re-run PROPOSAL validation — which is exactly what wedges a stale suggestion
 * (its field may since have been removed or become gated). Ownership and the
 * manage permission are asserted by the caller before this runs.
 */
async function claimSuggestionTransition(
  db: DatabaseInterface,
  suggestionId: string,
  patch: {
    status: 'accepted' | 'dismissed';
    activeKey: string;
    decidedAt: Date;
    decidedBy: string | null;
    cooldownUntil: Date | null;
  },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE _smrt_field_policy_suggestions
        SET status = ?,
            active_key = ?,
            decided_at = ?,
            decided_by = ?,
            cooldown_until = ?
      WHERE id = ? AND status = 'pending'
      RETURNING id`,
    patch.status,
    patch.activeKey,
    patch.decidedAt.toISOString(),
    patch.decidedBy,
    patch.cooldownUntil ? patch.cooldownUntil.toISOString() : null,
    suggestionId,
  );
  return (result?.rows?.length ?? 0) > 0;
}

/**
 * Compensating revert for drivers without transactions: put a claimed row back
 * to `pending` after a refused policy write, so the suggestion is never left
 * settled without its policy. The active slot was held across the whole
 * decision, so this restores state the caller still owns.
 */
async function revertSuggestionToPending(
  db: DatabaseInterface,
  suggestionId: string,
): Promise<void> {
  await db.query(
    `UPDATE _smrt_field_policy_suggestions
        SET status = 'pending',
            active_key = ?,
            decided_at = NULL,
            decided_by = NULL,
            cooldown_until = NULL
      WHERE id = ?`,
    ACTIVE_SUGGESTION_KEY,
    suggestionId,
  );
}

/**
 * Release the active slot after an accepted decision is fully durable: the row
 * keys itself by its own id, so a post-cool-down regeneration may take the
 * shared slot again while this settled row remains addressable.
 */
async function settleSuggestionActiveKey(
  db: DatabaseInterface,
  suggestionId: string,
): Promise<void> {
  await db.query(
    `UPDATE _smrt_field_policy_suggestions
        SET active_key = ?
      WHERE id = ?`,
    suggestionId,
    suggestionId,
  );
}

/**
 * Raised when a non-transactional accept could neither complete its policy
 * write NOR undo its claim. Both causes are carried: the row may be sitting
 * `accepted` without a policy, which an operator must reconcile — silently
 * reporting only the policy error would imply the suggestion is still pending.
 */
export class FieldPolicySuggestionCompensationError extends Error {
  readonly httpStatus = 500;
  readonly status = 500;
  readonly revertCause: unknown;

  constructor(suggestionId: string, cause: unknown, revertCause: unknown) {
    super(
      `acceptSuggestion: the policy write for suggestion "${suggestionId}" ` +
        `failed AND reverting it to pending also failed; the suggestion may ` +
        `be left accepted without its policy row and needs reconciliation ` +
        `(policy error: ${cause instanceof Error ? cause.message : String(cause)}; ` +
        `revert error: ${
          revertCause instanceof Error
            ? revertCause.message
            : String(revertCause)
        })`,
      { cause },
    );
    this.name = 'FieldPolicySuggestionCompensationError';
    this.revertCause = revertCause;
  }
}

/**
 * Stable id for the org-scope policy row an acceptance creates, derived from
 * the policy natural key.
 *
 * With a random id, two concurrent acceptances for the same field would each
 * mint a row and the natural-key upsert would resolve them by REPLACING one
 * (dropping its column and dangling its id). A deterministic id turns that into
 * a primary-key collision the loser can detect and fall back from.
 */
export function fieldPolicyRowId(
  tenantId: string,
  objectRef: string,
  fieldName: string,
): Promise<string> {
  return deterministicFieldsUuid([
    'field-policy-row',
    'tenant',
    tenantId,
    objectRef,
    fieldName,
  ]);
}

/**
 * Atomically set ONE column on the tenant-scope policy row for a field, keyed
 * by the policy natural key. Returns the surviving row id, or `null` when no
 * row exists yet.
 *
 * A single statement: concurrent acceptances of a `promote` and a `default`
 * suggestion for the same field touch disjoint columns and cannot drop each
 * other's write. `RETURNING id` (never a row count) is the reliable applied
 * signal — some adapters report a no-match UPDATE as `rowCount: 1`.
 */
async function updatePolicyColumn(
  db: DatabaseInterface,
  target: {
    objectRef: string;
    fieldName: string;
    tenantId: string;
    column: 'visibility' | 'default_value';
    value: string | null;
    decidedBy: string | null;
  },
): Promise<string | null> {
  const result = await db.query(
    `UPDATE _smrt_field_policies
        SET ${target.column} = ?,
            updated_by = ?,
            updated_at = ?
      WHERE object_ref = ?
        AND field_name = ?
        AND scope_type = 'tenant'
        AND tenant_id = ?
      RETURNING id`,
    target.value,
    target.decidedBy,
    new Date().toISOString(),
    target.objectRef,
    target.fieldName,
    target.tenantId,
  );
  const rows = result?.rows ?? [];
  const id = rows[0]?.id;
  return id === undefined || id === null ? null : String(id);
}

/**
 * Re-apply the stored-default security rail at ACCEPTANCE time, through the
 * same shared helpers `FieldPolicy` and `FieldPolicySuggestion` validate with
 * (not a copy of the rules).
 *
 * A suggestion is validated when queued, but a field can turn sensitive,
 * `readPermission`-gated, transient, or change type before anyone accepts it —
 * and the atomic column update deliberately bypasses the model, so the rail is
 * asserted here instead of being silently skipped.
 */
async function assertAcceptedDefaultStillAllowed(
  suggestion: FieldPolicySuggestion,
): Promise<void> {
  const fieldDef = await assertAcceptedPolicyTargetStillAllowed(suggestion);
  if (suggestion.proposedValue === null) {
    throw new Error(
      "FieldPolicySuggestion of kind 'default' requires a proposedValue",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(suggestion.proposedValue);
  } catch (error) {
    throw new Error(
      `FieldPolicySuggestion.proposedValue is not valid JSON: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertDefaultValueMatchesFieldType(
    suggestion.objectRef,
    suggestion.fieldName,
    fieldDef,
    parsed,
  );
}

/** Re-check every policy-addressability rail before an atomic acceptance write. */
async function assertAcceptedPolicyTargetStillAllowed(
  suggestion: FieldPolicySuggestion,
) {
  const fields = await getObjectFieldMap(suggestion.objectRef);
  const fieldDef = fields.get(suggestion.fieldName);
  if (!fieldDef || !isPolicyAddressableField(fieldDef)) {
    throw new Error(
      `Field "${suggestion.fieldName}" on "${suggestion.objectRef}" ` +
        `is not policy-addressable`,
    );
  }
  if (
    isSensitiveField(fieldDef) ||
    getFieldReadPermission(fieldDef) !== undefined ||
    isTransientField(fieldDef)
  ) {
    throw new Error(
      `Cannot apply a policy for "${suggestion.objectRef}.` +
        `${suggestion.fieldName}": the field is sensitive, ` +
        `read-permission-gated, or transient`,
    );
  }
  return fieldDef;
}

/** Default cool-down a dismissal applies (30 days). */
export const DEFAULT_SUGGESTION_COOL_DOWN_MS = 30 * 24 * 60 * 60 * 1000;

/** Bounds for a caller-supplied dismissal cool-down. */
export const MIN_SUGGESTION_COOL_DOWN_MS = 60 * 60 * 1000; // 1 hour
export const MAX_SUGGESTION_COOL_DOWN_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

/** Upper bound on objectRefs accepted by the pending filter. */
const MAX_PENDING_OBJECT_REFS = 100;

/**
 * Collection surface for {@link FieldPolicySuggestion} plus the three
 * manage-gated actions the gear badge / control-panel queue consume (#2051;
 * UI integration is #2050-follow-up territory — this is the minimal seam).
 *
 * All three actions are custom collection-scoped routes (the resolveBatch
 * mechanism — single-segment paths, both transports dispatch). Identity is
 * ambient-context-only and every action requires `fields.policy.manage` (or
 * super-admin bypass) within an ambient tenant: pending suggestions describe
 * org-wide usage, and accept/dismiss are org policy decisions.
 */
@smrt({
  // Mirror the item's active-slot natural key. The collection decorator emits
  // another schema for the same table; omitting this would reintroduce the
  // default `(slug, context)` unique index in generated migrations.
  conflictColumns: [
    'object_ref',
    'field_name',
    'tenant_id',
    'kind',
    'active_key',
  ],
  api: {
    include: ['pendingSuggestions', 'acceptSuggestion', 'dismissSuggestion'],
    // Queue reads and decisions are scoped to the authenticated principal's
    // tenant and require fields.policy.manage; request payloads never select
    // that identity.
    principalContext: true,
    routes: {
      pendingSuggestions: {
        scope: 'collection',
        method: 'POST',
        path: 'pending',
      },
      acceptSuggestion: {
        scope: 'collection',
        method: 'POST',
        path: 'accept',
      },
      dismissSuggestion: {
        scope: 'collection',
        method: 'POST',
        path: 'dismiss',
      },
    },
  },
  cli: false,
  mcp: false,
})
export class FieldPolicySuggestionCollection extends SmrtCollection<FieldPolicySuggestion> {
  static readonly _itemClass = FieldPolicySuggestion;

  /**
   * The caller's tenant's PENDING suggestions (optionally filtered to a set
   * of objectRefs), newest first, plus the total for the gear badge.
   */
  async pendingSuggestions(
    options: { objectRefs?: string[] } = {},
  ): Promise<PendingFieldPolicySuggestionsResult> {
    const tenantId = await this.requireManageContext('pendingSuggestions');
    const objectRefs = normalizeObjectRefsFilter(options.objectRefs);

    const where: Record<string, unknown> = { tenantId, status: 'pending' };
    if (objectRefs) {
      where['objectRef in'] = objectRefs;
    }
    const rows = await this.list({ where, orderBy: 'created_at DESC' });

    return {
      suggestions: rows.map((row) => row.toSuggestionData()),
      total: rows.length,
    };
  }

  /**
   * Accept a pending suggestion: CLAIM the pending→accepted transition, then
   * write the corresponding org-scope `FieldPolicy` row THROUGH NORMAL
   * VALIDATION (registry check, type check, security rail, required-field
   * invariant, ownership boundary, and the #2049 permission split — the
   * ambient caller must hold `fields.policy.manage`, which this action also
   * asserts up front).
   *
   * An existing tenant row for the same `(objectRef, fieldName)` is UPDATED
   * (read-modify-write), preserving its other sparse columns — never
   * duplicated through the natural-key upsert.
   *
   * Concurrency: the claim is a compare-and-set on `status` (the jobs
   * `writeOwnedJob` precedent — a guarded UPDATE with `RETURNING id`), so an
   * overlapping accept/dismiss pair cannot both win; the loser throws
   * {@link FieldPolicySuggestionConflictError} (409). Claim and policy write
   * run in ONE transaction when the driver supports it, so a rejected policy
   * write can never leave the suggestion settled without its policy (and vice
   * versa). Drivers without transactions get an explicit compensating revert.
   */
  async acceptSuggestion(
    options: { id?: string } = {},
  ): Promise<AcceptFieldPolicySuggestionResult> {
    const tenantId = await this.requireManageContext('acceptSuggestion');
    const suggestion = await this.loadOwnedPendingSuggestion(
      'acceptSuggestion',
      options.id,
      tenantId,
    );
    const suggestionId = String(suggestion.id);
    const decidedBy = getCurrentTenant()?.userId ?? null;
    const decidedAt = new Date();

    const claim = {
      status: 'accepted' as const,
      activeKey: suggestionId,
      decidedAt,
      decidedBy,
      cooldownUntil: null,
    };

    const tx = await this.beginTransactionIfSupported();
    if (tx) {
      let policyRowId: string;
      try {
        const claimed = await claimSuggestionTransition(
          tx,
          suggestionId,
          claim,
        );
        if (!claimed) {
          throw new FieldPolicySuggestionConflictError(
            'acceptSuggestion',
            suggestionId,
          );
        }
        policyRowId = await this.applyAcceptedPolicy(
          tx,
          suggestion,
          tenantId,
          decidedBy,
        );
        await tx.commit();
      } catch (error) {
        try {
          await tx.rollback();
        } catch {
          // Preserve the original failure; rollback errors are secondary.
        }
        throw error;
      }
      // The policy save inside the transaction invalidated the resolver cache
      // under the TRANSACTION handle's namespace, which is not the app db's —
      // so the committed change would otherwise stay invisible for the cache
      // TTL. Re-invalidate against this collection's db now that it is durable.
      invalidateFieldPolicyCache(suggestion.objectRef, this.db);
      suggestion.status = 'accepted';
      suggestion.decidedAt = decidedAt;
      suggestion.decidedBy = decidedBy;
      return { suggestion: suggestion.toSuggestionData(), policyRowId };
    }

    // No transaction support (e.g. a transaction VIEW, which exposes
    // `transaction` but not `beginTransaction`). Claim in TWO steps so the
    // identity's active slot is never free while the decision is in flight:
    //
    //   1. flip `status` to accepted but KEEP `activeKey = 'active'` — the
    //      compare-and-set still makes exactly one decision win, while the
    //      unique index keeps holding the slot, so generation running in this
    //      window cannot insert a fresh pending suggestion that would then
    //      collide with the compensation (and be resolved against the stale
    //      pre-acceptance policy);
    //   2. only AFTER the policy write succeeds, settle the key to the row's
    //      id, releasing the slot for a future post-cool-down regeneration.
    //
    // A refused policy write therefore reverts into a slot nothing else can
    // have taken. Generation's suppression keys off the slot (not `status`)
    // precisely so step 1 suppresses it.
    const claimed = await claimSuggestionTransition(this.db, suggestionId, {
      ...claim,
      activeKey: ACTIVE_SUGGESTION_KEY,
    });
    if (!claimed) {
      throw new FieldPolicySuggestionConflictError(
        'acceptSuggestion',
        suggestionId,
      );
    }
    let policyRowId: string;
    try {
      policyRowId = await this.applyAcceptedPolicy(
        this.db,
        suggestion,
        tenantId,
        decidedBy,
      );
    } catch (error) {
      // Compensate back to pending. The slot was held throughout, so a
      // collision here is not an expected race — it means the row was mutated
      // underneath us and the compensation did NOT restore it. Surface that
      // instead of swallowing it: the caller must not be told the suggestion
      // is still pending when it may be stuck accepted-without-policy.
      try {
        await revertSuggestionToPending(this.db, suggestionId);
      } catch (revertError) {
        throw new FieldPolicySuggestionCompensationError(
          suggestionId,
          error,
          revertError,
        );
      }
      throw error;
    }

    // Release the slot now that the policy is durable.
    await settleSuggestionActiveKey(this.db, suggestionId);
    // The atomic column update bypasses the model, so it does not invalidate
    // the resolver cache the way `FieldPolicy.save()` does — do it here so org
    // forms shift immediately on this path too.
    invalidateFieldPolicyCache(suggestion.objectRef, this.db);

    suggestion.status = 'accepted';
    suggestion.decidedAt = decidedAt;
    suggestion.decidedBy = decidedBy;
    return { suggestion: suggestion.toSuggestionData(), policyRowId };
  }

  /**
   * Dismiss a pending suggestion: set status + a cool-down until which the
   * generation job will NOT regenerate the same
   * `(objectRef, fieldName, tenantId, kind)` suggestion.
   *
   * Validates OWNERSHIP and PENDING STATUS ONLY — deliberately NOT continued
   * proposal eligibility. A queued suggestion whose field has since been
   * removed, turned sensitive/`readPermission`-gated/transient, or retyped is
   * exactly the row an operator most needs to clear; re-running proposal
   * validation on the way out would reject the dismissal and, because pending
   * rows are never pruned, wedge it in the queue forever. The claim is the same
   * compare-and-set as accept, so it also bypasses the model's proposal
   * validation by construction.
   */
  async dismissSuggestion(
    options: { id?: string; coolDownMs?: number } = {},
  ): Promise<DismissFieldPolicySuggestionResult> {
    const tenantId = await this.requireManageContext('dismissSuggestion');
    const suggestion = await this.loadOwnedPendingSuggestion(
      'dismissSuggestion',
      options.id,
      tenantId,
    );
    const suggestionId = String(suggestion.id);
    const coolDownMs = normalizeCoolDownMs(options.coolDownMs);
    const decidedAt = new Date();
    const decidedBy = getCurrentTenant()?.userId ?? null;
    const cooldownUntil = new Date(decidedAt.getTime() + coolDownMs);

    const claimed = await claimSuggestionTransition(this.db, suggestionId, {
      status: 'dismissed',
      activeKey: suggestionId,
      decidedAt,
      decidedBy,
      cooldownUntil,
    });
    if (!claimed) {
      throw new FieldPolicySuggestionConflictError(
        'dismissSuggestion',
        suggestionId,
      );
    }

    suggestion.status = 'dismissed';
    suggestion.cooldownUntil = cooldownUntil;
    suggestion.decidedAt = decidedAt;
    suggestion.decidedBy = decidedBy;
    return { suggestion: suggestion.toSuggestionData() };
  }

  /**
   * Write the org-scope policy column an accepted suggestion implies, bound to
   * `db` so it participates in the caller's transaction.
   *
   * A `promote` and a `default` suggestion for the SAME field share one sparse
   * `FieldPolicy` row but own DIFFERENT columns, and both may be accepted
   * concurrently. A read-modify-save of the whole row therefore loses updates:
   * each acceptance reads the row (or its absence) before the other's save
   * lands, and the later full-row write erases the sibling's column — and, via
   * the natural-key upsert, can even replace the row id, dangling the earlier
   * caller's `policyRowId`. (Distinct from the suggestion-row race fixed
   * earlier: that one guards the pending→settled transition; this one is on the
   * shared policy row.) So this NEVER writes a whole row over an existing one:
   *
   * 1. An ATOMIC partial UPDATE sets only this acceptance's column, keyed by
   *    the policy natural key and `RETURNING id` — one statement, so no
   *    interleaving can drop the sibling's column, and the returned id is
   *    always the surviving row.
   * 2. Only when no row exists yet does it CREATE through the model, so full
   *    validation (registry, type check, security rail, required-field
   *    invariant, ownership + permission split) runs on the row that is
   *    actually inserted. The row carries a DETERMINISTIC id under strict
   *    insert, so two concurrent creates cannot each mint a row: the loser
   *    collides and falls back to step 1, applying only its own column.
   *
   * The update path skips the model, so BOTH kinds re-check live target
   * addressability through the shared helpers (a field can turn sensitive,
   * gated, transient, or disappear between queueing and acceptance). Defaults
   * additionally re-check their value/type rail; a promotion to `basic` has no
   * value payload, and the required-field invariant restricts only
   * advanced/hidden. Org locks constrain the user tier, not org rows.
   */
  private async applyAcceptedPolicy(
    db: DatabaseInterface,
    suggestion: FieldPolicySuggestion,
    tenantId: string,
    decidedBy: string | null,
  ): Promise<string> {
    if (suggestion.kind === 'default') {
      await assertAcceptedDefaultStillAllowed(suggestion);
    } else {
      await assertAcceptedPolicyTargetStillAllowed(suggestion);
    }

    const target = {
      objectRef: suggestion.objectRef,
      fieldName: suggestion.fieldName,
      tenantId,
      column:
        suggestion.kind === 'promote'
          ? ('visibility' as const)
          : ('default_value' as const),
      value: suggestion.kind === 'promote' ? 'basic' : suggestion.proposedValue,
      decidedBy,
    };

    const updatedId = await updatePolicyColumn(db, target);
    if (updatedId) {
      return updatedId;
    }

    // Dynamic import breaks the module cycle risk with the policy model
    // family (mirrors the resolver/collection seams in this package).
    const { FieldPolicyCollection } = await import(
      './FieldPolicyCollection.js'
    );
    const policies = await FieldPolicyCollection.create(
      transactionBoundOptions(db),
    );
    const deterministicId = await fieldPolicyRowId(
      tenantId,
      suggestion.objectRef,
      suggestion.fieldName,
    );

    try {
      const created = await policies.create({
        id: deterministicId,
        objectRef: suggestion.objectRef,
        fieldName: suggestion.fieldName,
        scopeType: 'tenant',
        tenantId,
        ...(suggestion.kind === 'promote'
          ? { visibility: 'basic' as const }
          : { defaultValue: suggestion.proposedValue }),
        updatedBy: decidedBy,
        // Strict insert: a concurrent acceptance that already created the row
        // must NOT be adopted-and-overwritten (that is the lost update).
        _insertOnly: true,
      });
      return String(created.id);
    } catch (error) {
      // Someone created the row between the update and the insert. Apply just
      // this acceptance's column to the surviving row.
      const racedId = await updatePolicyColumn(db, target);
      if (racedId) {
        return racedId;
      }
      throw error;
    }
  }

  /**
   * A driver transaction handle, or `null` when the driver has none (the
   * `FieldPolicy.saveAfterIdentityChange` probe, same shape).
   */
  private async beginTransactionIfSupported(): Promise<SuggestionTransactionHandle | null> {
    if (typeof this.db.beginTransaction !== 'function') {
      return null;
    }
    const tx = (await this.db.beginTransaction()) as
      | SuggestionTransactionHandle
      | undefined;
    return tx ?? null;
  }

  /**
   * Ambient manage gate shared by the three actions: an ambient tenant
   * context is required (no context ⇒ no identity ⇒ fail closed — the
   * suggestion queue is never an anonymous surface), and the caller must hold
   * `fields.policy.manage` unless running under super-admin bypass.
   */
  private async requireManageContext(action: string): Promise<string> {
    const context = getCurrentTenant();
    if (!context?.tenantId) {
      throw new FieldPolicySuggestionRequestContextError(
        `${action} requires an ambient tenant context (fail closed): the ` +
          'suggestion queue is scoped to the caller tenant',
      );
    }
    if (!isSuperAdminBypass()) {
      await assertOperationPermission({
        collection: 'fields.policy',
        action: MANAGE_FIELD_POLICY_PERMISSION.split('.').at(-1) ?? 'manage',
        db: this.db,
        tenantId: context.tenantId,
        userId: context.userId ?? null,
        permissionSet: context.permissions,
      });
    }
    return context.tenantId;
  }

  private async loadOwnedPendingSuggestion(
    action: string,
    id: string | undefined,
    tenantId: string,
  ): Promise<FieldPolicySuggestion> {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error(`${action} requires a suggestion "id" string`);
    }
    const suggestion = await this.get(id);
    if (!suggestion) {
      throw new Error(`${action}: no suggestion found for id "${id}"`);
    }
    if (suggestion.tenantId !== tenantId) {
      throw new TenantIsolationError(
        `Tenant isolation violation in ${action}: the suggestion belongs to ` +
          `another tenant`,
        {
          tenantId,
          attemptedTenantId: suggestion.tenantId ?? undefined,
        },
      );
    }
    if (suggestion.status !== 'pending') {
      // The SAME conflict the compare-and-set raises: whether a competing
      // decision landed before this request read the row or after, the caller
      // sees one error type (and one status) instead of a different failure
      // per interleaving.
      throw new FieldPolicySuggestionConflictError(action, id);
    }
    return suggestion;
  }
}

function normalizeObjectRefsFilter(
  rawRefs: string[] | undefined,
): string[] | null {
  if (rawRefs === undefined) {
    return null;
  }
  if (!Array.isArray(rawRefs) || rawRefs.length === 0) {
    throw new Error(
      'pendingSuggestions "objectRefs" must be a non-empty string array when provided',
    );
  }
  if (rawRefs.some((ref) => typeof ref !== 'string' || ref.trim() === '')) {
    throw new Error('pendingSuggestions objectRefs must be non-empty strings');
  }
  const objectRefs = [...new Set(rawRefs)];
  if (objectRefs.length > MAX_PENDING_OBJECT_REFS) {
    throw new Error(
      `pendingSuggestions accepts at most ${MAX_PENDING_OBJECT_REFS} ` +
        `objectRefs per call (got ${objectRefs.length})`,
    );
  }
  return objectRefs;
}

function normalizeCoolDownMs(raw: number | undefined): number {
  if (raw === undefined) {
    return DEFAULT_SUGGESTION_COOL_DOWN_MS;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new Error('dismissSuggestion coolDownMs must be a finite number');
  }
  return Math.min(
    Math.max(raw, MIN_SUGGESTION_COOL_DOWN_MS),
    MAX_SUGGESTION_COOL_DOWN_MS,
  );
}
