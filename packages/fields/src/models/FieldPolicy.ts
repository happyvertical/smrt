import {
  crossPackageRef,
  field,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import {
  getCurrentTenant,
  isSuperAdminBypass,
  TenantIsolationError,
  tenantId,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { invalidateFieldPolicyCache } from '../cache.js';
import {
  assertDefaultValueMatchesFieldType,
  getFieldReadPermission,
  getObjectFieldMap,
  isRequiredField,
  isSensitiveField,
  isTransientField,
  isUsableRequiredDefault,
  type RegisteredFieldInfo,
} from '../field-definitions.js';
import {
  APP_FIELD_POLICY_SCOPE_KEY,
  FIELD_POLICY_SCOPE_TYPES,
  FIELD_POLICY_VISIBILITIES,
  type FieldPolicyOptions,
  type FieldPolicyScopeType,
  type FieldPolicyVisibility,
  type ResolvedFieldPolicy,
} from '../types.js';

type FieldPolicyIdentity = {
  objectRef: string;
  fieldName: string;
  scopeType: string;
  scopeKey: string;
  tenantId: string | null;
  userId: string | null;
};

type FieldPolicyTransactionHandle = DatabaseInterface & {
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
};

/**
 * Sparse, layered field policy override (epic #2045, issue #2047).
 *
 * One row personalizes a subset of `{defaultValue, visibility, help, label,
 * displayOrder, locked}` for a single `(objectRef, fieldName)` at one scope
 * tier. A NULL column means "inherit from the lower layer" (code seed → app →
 * tenant → user), so resetting a customization is a row DELETE — later
 * lower-layer changes then flow through (sparse-delta rationale, #1770).
 *
 * Rows are validated at write time against the live `ObjectRegistry` (the
 * manifest is the definition registry): unknown objects/fields are rejected,
 * defaults are type-checked, and the security rail (`sensitive` /
 * `readPermission` / `transient`) refuses stored defaults outright.
 */
// The generated surfaces expose NO read verbs anywhere: list/get on this
// non-@TenantScoped model would enumerate every tenant's and user's policy
// rows to any authenticated principal, and the generated CLI invokes methods
// over HTTP so CLI reads would be equally exposed (and unreachable once the
// API closes them — the build-time cli↔api coherence gate enforces that).
// Reads go through the context-scoped batch resolver
// (FieldPolicyCollection.resolveBatch) and the server-side resolver/explain
// APIs.
@smrt({
  tableName: '_smrt_field_policies',
  conflictColumns: ['object_ref', 'field_name', 'scope_type', 'scope_key'],
  api: { include: ['create', 'update', 'delete'] },
  cli: {
    include: ['create', 'update', 'delete'],
    exclude: ['getDefaultValue', 'setDefaultValue'],
  },
  mcp: { include: [] },
})
export class FieldPolicy extends SmrtObject {
  /** Qualified class name of the target object (`@package/name:ClassName`). */
  @field({ required: true })
  objectRef: string = '';

  /** Field name on the target object (validated against the registry). */
  @field({ required: true })
  fieldName: string = '';

  /** Scope tier this row belongs to ('app' | 'tenant' | 'user'). */
  @field({ required: true })
  scopeType: FieldPolicyScopeType = 'app';

  /** Owning tenant for tenant-scope rows; NULL otherwise (native UUID on PG). */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** Owning user for user-scope rows; NULL otherwise. */
  @crossPackageRef('@happyvertical/smrt-users:User', { nullable: true })
  userId: string | null = null;

  /**
   * Computed uniqueness key (`userId ?? tenantId ?? '__app__'`), set in
   * `save()`. Used ONLY by `conflictColumns` so the unique index stays total
   * while `tenantId`/`userId` are nullable — mirrors `PromptOverride.context`.
   * Never read it for scoping logic; `scopeType` + the typed columns own that.
   */
  @field({ type: 'text', required: true })
  scopeKey: string = '';

  /** JSON-encoded default value; NULL = inherit. JSON `null` = "default to null". */
  @field({ type: 'text', nullable: true })
  defaultValue: string | null = null;

  /** Visibility override ('basic' | 'advanced' | 'hidden'); NULL = inherit. */
  @field({ type: 'text', nullable: true })
  visibility: FieldPolicyVisibility | null = null;

  /** Help text override; NULL = inherit (code seed: field description). */
  @field({ type: 'text', nullable: true })
  help: string | null = null;

  /** Label override; NULL = inherit (consumers derive from the field name). */
  @field({ type: 'text', nullable: true })
  label: string | null = null;

  /**
   * Sort-order override; NULL = inherit (code seed: `ui.order`). Named
   * `displayOrder` because a column literally named `order` is an SQL keyword
   * the runtime INSERT path does not quote; resolved output exposes `order`.
   */
  @field({ type: 'integer', nullable: true })
  displayOrder: number | null = null;

  /**
   * Org lock (app/tenant rows only): when the effective lock is true, the
   * user tier may not override this field. NULL = inherit (code seed:
   * `ui.locked`); org rows may set `false` to explicitly unlock.
   */
  @field({ type: 'boolean', nullable: true })
  locked: boolean | null = null;

  /** Audit attribution for #2050 ("who changed what"); not validated. */
  @crossPackageRef('@happyvertical/smrt-users:User', { nullable: true })
  updatedBy: string | null = null;

  constructor(options: FieldPolicyOptions = {}) {
    super(options);

    if (options.objectRef !== undefined) this.objectRef = options.objectRef;
    if (options.fieldName !== undefined) this.fieldName = options.fieldName;
    if (options.scopeType !== undefined) this.scopeType = options.scopeType;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.userId !== undefined) this.userId = options.userId;
    if (options.defaultValue !== undefined) {
      if (
        typeof options.defaultValue === 'string' ||
        options.defaultValue === null
      ) {
        this.defaultValue = options.defaultValue;
      } else {
        this.defaultValue = JSON.stringify(options.defaultValue);
      }
    }
    if (options.visibility !== undefined) this.visibility = options.visibility;
    if (options.help !== undefined) this.help = options.help;
    if (options.label !== undefined) this.label = options.label;
    if (options.displayOrder !== undefined) {
      this.displayOrder = options.displayOrder;
    }
    if (options.locked !== undefined) this.locked = options.locked;
    if (options.updatedBy !== undefined) this.updatedBy = options.updatedBy;
  }

  /** Parse the stored JSON default. `undefined` = no stored default (inherit). */
  getDefaultValue(): unknown {
    if (this.defaultValue === null || this.defaultValue === undefined) {
      return undefined;
    }
    try {
      return JSON.parse(this.defaultValue);
    } catch {
      return undefined;
    }
  }

  /** Serialize a default value; `undefined` clears the override (inherit). */
  setDefaultValue(value: unknown): void {
    this.defaultValue = value === undefined ? null : JSON.stringify(value);
  }

  override async save(): Promise<this> {
    // Runs BEFORE the persisted-identity lookup: that lookup falls back to
    // the natural key, which includes the scope key derived from these
    // columns.
    this.attributeScopeToAmbientContext();
    const previousIdentity = await this.getPersistedIdentity();
    // The caller must own the row AS PERSISTED before any mutation is
    // accepted — otherwise a foreign row could be re-scoped into the caller's
    // own tenant/user (and the identity-change path below would then delete
    // the original foreign row).
    if (previousIdentity) {
      this.assertScopeOwnedByAmbientContext(previousIdentity, 'save');
    }
    // Audit attribution (#2050): inside an ambient context the SERVER stamps
    // who wrote the row — a client-supplied `updatedBy` is overwritten, so
    // attribution cannot be spoofed through the generated write routes. A
    // context without a user id attributes to null; trusted context-less
    // flows keep whatever explicit attribution they set.
    const ambientContext = getCurrentTenant();
    if (ambientContext) {
      this.updatedBy = ambientContext.userId ?? null;
    }
    this.normalizeDefaultValueForPersistence();
    await this.validateFieldPolicy();
    // scopeKey makes the conflict-column tuple total even though tenantId and
    // userId are nullable (nullable columns would allow duplicate NULL rows).
    this.scopeKey = this.computeScopeKey();

    const identityChanged =
      previousIdentity &&
      (previousIdentity.objectRef !== this.objectRef ||
        previousIdentity.fieldName !== this.fieldName ||
        previousIdentity.scopeType !== this.scopeType ||
        previousIdentity.scopeKey !== this.scopeKey);

    const result =
      identityChanged && previousIdentity
        ? await this.saveAfterIdentityChange()
        : await super.save();

    if (identityChanged && previousIdentity) {
      invalidateFieldPolicyCache(previousIdentity.objectRef, this.db);
    }
    invalidateFieldPolicyCache(this.objectRef, this.db);
    return result;
  }

  private async saveAfterIdentityChange(): Promise<this> {
    if (typeof this.db.beginTransaction === 'function') {
      return this.saveAfterIdentityChangeInTransaction();
    }

    return this.saveAfterIdentityChangeWithDeferredDelete();
  }

  private async saveAfterIdentityChangeInTransaction(): Promise<this> {
    const originalDb = this._db;
    const originalOptionsDb = this.options.db;
    const tx = (await this.db.beginTransaction?.()) as
      | FieldPolicyTransactionHandle
      | undefined;

    if (!tx) {
      return this.saveAfterIdentityChangeWithDeferredDelete();
    }

    try {
      this._db = tx;
      this.options.db = tx;
      await super.delete();
      const result = await super.save();
      await tx.commit();
      return result;
    } catch (error) {
      try {
        await tx.rollback();
      } catch {
        // Preserve the original save error; rollback failures are secondary.
      }
      throw error;
    } finally {
      this._db = originalDb;
      this.options.db = originalOptionsDb;
    }
  }

  private async saveAfterIdentityChangeWithDeferredDelete(): Promise<this> {
    const previousId = this.id;
    if (!previousId) {
      return super.save();
    }

    const replacementId = crypto.randomUUID();
    let replacementSaved = false;
    this.id = replacementId;

    try {
      const result = await super.save();
      replacementSaved = true;
      await this.db.delete(this.tableName, { id: previousId });
      return result;
    } catch (error) {
      if (replacementSaved) {
        try {
          await this.db.delete(this.tableName, { id: replacementId });
        } catch {
          // Best effort cleanup keeps the original row as the source of truth.
        }
      }

      this.id = previousId;
      throw error;
    }
  }

  override async delete(): Promise<void> {
    // Authorize against the PERSISTED row, not in-memory state: the generated
    // DELETE route (and any caller holding a foreign row id) must not remove
    // app rows or another tenant's/user's rows from inside a tenant context.
    const persisted = await this.getPersistedIdentity();
    if (persisted) {
      this.assertScopeOwnedByAmbientContext(persisted, 'delete');
    }
    const objectRef = persisted?.objectRef ?? this.objectRef;
    await super.delete();
    invalidateFieldPolicyCache(objectRef, this.db);
    if (this.objectRef && this.objectRef !== objectRef) {
      invalidateFieldPolicyCache(this.objectRef, this.db);
    }
  }

  private async validateFieldPolicy(): Promise<void> {
    if (!this.objectRef || this.objectRef.trim() === '') {
      throw new Error('FieldPolicy.objectRef is required');
    }
    if (!this.fieldName || this.fieldName.trim() === '') {
      throw new Error('FieldPolicy.fieldName is required');
    }
    if (!FIELD_POLICY_SCOPE_TYPES.includes(this.scopeType)) {
      throw new Error(
        `FieldPolicy.scopeType must be one of ` +
          `${FIELD_POLICY_SCOPE_TYPES.join(', ')}; got "${this.scopeType}"`,
      );
    }
    if (
      this.visibility !== null &&
      !FIELD_POLICY_VISIBILITIES.includes(this.visibility)
    ) {
      throw new Error(
        `FieldPolicy.visibility must be null or one of ` +
          `${FIELD_POLICY_VISIBILITIES.join(', ')}; got "${this.visibility}"`,
      );
    }
    if (
      this.displayOrder !== null &&
      (typeof this.displayOrder !== 'number' ||
        !Number.isInteger(this.displayOrder))
    ) {
      throw new Error('FieldPolicy.displayOrder must be null or an integer');
    }

    this.validateScopeConsistency();
    this.validateTenantContextBoundary();

    const fields = await getObjectFieldMap(this.objectRef);
    const fieldDef = fields.get(this.fieldName);
    if (!fieldDef) {
      throw new Error(
        `Unknown field "${this.fieldName}" on "${this.objectRef}"`,
      );
    }
    if (fieldDef._meta?.__smrtSystemField === true) {
      throw new Error(
        `Field "${this.fieldName}" on "${this.objectRef}" is a framework ` +
          `system field and is not policy-addressable`,
      );
    }
    if (fieldDef.type === 'oneToMany' || fieldDef.type === 'manyToMany') {
      throw new Error(
        `Field "${this.fieldName}" on "${this.objectRef}" is a relationship ` +
          `pseudo-field and is not policy-addressable`,
      );
    }
    // The resolver excludes STI meta storage fields, so accepting a row here
    // would persist policy that silently never applies.
    if (fieldDef.type === 'meta') {
      throw new Error(
        `Field "${this.fieldName}" on "${this.objectRef}" is STI meta ` +
          `storage and is not policy-addressable`,
      );
    }

    if (this.locked !== null && this.scopeType === 'user') {
      throw new Error(
        'FieldPolicy.locked may only be set on org rows (app or tenant scope)',
      );
    }

    if (this.defaultValue !== null) {
      this.validateDefaultAgainstSecurityRail(fieldDef);
      const parsed = this.parseDefaultValueOrThrow();
      assertDefaultValueMatchesFieldType(
        this.objectRef,
        this.fieldName,
        fieldDef,
        parsed,
      );
    }

    // Required-field invariant (write side): demoting a required field to
    // advanced/hidden needs a usable resolved default — either this row's own
    // default or one resolved by the org tiers (code → app → tenant chain,
    // INCLUDING cascading ancestor-tenant defaults). The resolver enforces
    // the same rule again at read time (safety net) because a DIFFERENT row's
    // later deletion can invalidate what held here.
    const demotesRequiredField =
      (this.visibility === 'advanced' || this.visibility === 'hidden') &&
      isRequiredField(fieldDef);
    const ownDefault =
      demotesRequiredField && this.defaultValue !== null
        ? { value: this.parseDefaultValueOrThrow() }
        : undefined;
    const needsOrgDefault =
      demotesRequiredField && !isUsableRequiredDefault(ownDefault);
    const needsLockCheck = this.scopeType === 'user';

    if (needsOrgDefault || needsLockCheck) {
      const orgPolicy = await this.resolveOrgTierFieldPolicy();

      if (needsOrgDefault) {
        const orgDefault = orgPolicy?.hasDefault
          ? { value: orgPolicy.defaultValue }
          : undefined;
        if (!isUsableRequiredDefault(orgDefault)) {
          throw new Error(
            `Cannot set visibility "${this.visibility}" for required field ` +
              `"${this.objectRef}.${this.fieldName}": no resolved default ` +
              `exists at or below this layer`,
          );
        }
      }

      // Org lock enforcement (write side): the effective lock includes
      // cascading ancestor-tenant locks, not just the direct tenant row. The
      // resolver additionally skips the user layer at read time whenever the
      // org tiers resolve locked, so stale user rows cannot bypass a lock.
      if (needsLockCheck && orgPolicy?.locked) {
        throw new Error(
          `Field "${this.objectRef}.${this.fieldName}" is locked by org ` +
            `policy; user-scope overrides are not allowed`,
        );
      }
    }
  }

  /**
   * Effective org-tier (code → app → tenant hierarchy) policy for this row's
   * field, computed by the RESOLVER so write-time checks share the one
   * precedence implementation — including ancestor-tenant cascades via the
   * default hierarchy loader. The chain tenant is the row's own tenant for
   * tenant-scope rows, the ambient context tenant for user-scope rows, and
   * none for app-scope rows (their only lower layer is the code seed).
   *
   * On updates the resolver sees this row's PERSISTED version (there is no
   * self-exclusion), so a save that removes the only default while demoting
   * can pass here; the resolver-side safety net stays authoritative at read
   * time.
   */
  private async resolveOrgTierFieldPolicy(): Promise<
    ResolvedFieldPolicy | undefined
  > {
    const tenantIdForChain =
      this.scopeType === 'tenant'
        ? this.tenantId
        : this.scopeType === 'user'
          ? (getCurrentTenant()?.tenantId ?? null)
          : null;

    // Dynamic import: the resolver statically imports the collection, which
    // statically imports this model.
    const { resolveFieldPolicy } = await import('../field-policy-resolver.js');
    const resolved = await resolveFieldPolicy(this.objectRef, {
      tenantId: tenantIdForChain,
      db: this.options.db ?? this.options.persistence,
    });
    return resolved.fields[this.fieldName];
  }

  /**
   * Exactly-one-owner scope shape: app rows carry neither id, tenant rows
   * carry only `tenantId`, user rows carry only `userId` (the user tier is
   * keyed by user alone so preferences follow the user across tenants).
   */
  private validateScopeConsistency(): void {
    if (this.scopeType === 'app') {
      if (this.tenantId !== null || this.userId !== null) {
        throw new Error(
          'App-scope field policy rows must have tenantId and userId null',
        );
      }
      return;
    }
    if (this.scopeType === 'tenant') {
      if (!this.tenantId || this.userId !== null) {
        throw new Error(
          'Tenant-scope field policy rows must set tenantId and leave userId null',
        );
      }
      return;
    }
    if (!this.userId || this.tenantId !== null) {
      throw new Error(
        'User-scope field policy rows must set userId and leave tenantId null',
      );
    }
  }

  /** `userId ?? tenantId ?? '__app__'` — the `conflictColumns` scope key. */
  private computeScopeKey(): string {
    return this.userId ?? this.tenantId ?? APP_FIELD_POLICY_SCOPE_KEY;
  }

  /**
   * Derive a scope-owner column the transport could not carry (#2047).
   *
   * Core's mass-assignment guard treats `tenantId` as server-managed and
   * strips it from EVERY generated create/update body, and `FieldPolicy` is
   * deliberately not `@TenantScoped`, so the tenancy interceptor never
   * repopulates it. A `POST {scopeType:'tenant', tenantId}` therefore always
   * reached `validateScopeConsistency` with `tenantId === null`, making the
   * org tier write-dead over every generated surface — the model, as the
   * single validation authority for these rows, fills it in instead.
   *
   * This grants nothing: `assertScopeOwnedByAmbientContext` already requires
   * a non-bypass caller's tenant/user rows to name exactly the ambient
   * tenant/user, so the derived value is the ONLY value that could ever have
   * been accepted. An explicit value is never overwritten (a super-admin
   * bypass caller keeps naming other scopes), and with no ambient context
   * nothing is derived — scope-shape validation rejects the row as before.
   * Consequence: a bypass caller writing ANOTHER tenant's row must pass
   * `tenantId` through a server-side model call, because the generated routes
   * still strip it.
   */
  private attributeScopeToAmbientContext(): void {
    const context = getCurrentTenant();
    if (!context) {
      return;
    }
    if (this.scopeType === 'tenant' && this.tenantId === null) {
      this.tenantId = context.tenantId;
    }
    if (this.scopeType === 'user' && this.userId === null) {
      this.userId = context.userId ?? null;
    }
  }

  /**
   * Fail-closed write boundary against the ambient tenant context, applied to
   * the NEW scope on save and to the PERSISTED scope on save/delete of an
   * existing row.
   *
   * With NO ambient identity at all (no tenant context entered — e.g. a
   * runtime API deployment whose auth middleware never enters the tenancy
   * ALS), only app-scope rows are accepted: tenant- and user-scope rows are
   * unattributable without a context, so they are rejected outright rather
   * than allowed by default. Inside a non-bypass context, a caller may only
   * touch rows for its own tenant, and user rows only for its own user id —
   * a context that carries NO user id may not touch the user tier at all.
   * App-wide rows then require super-admin bypass (or a context-less/system
   * caller).
   *
   * Package rule: a missing identity component DENIES, it never skips.
   */
  private assertScopeOwnedByAmbientContext(
    scope: {
      scopeType: string;
      tenantId: string | null;
      userId: string | null;
    },
    operation: 'save' | 'delete',
  ): void {
    const context = getCurrentTenant();

    if (!context) {
      if (scope.scopeType === 'tenant' || scope.scopeType === 'user') {
        throw new TenantIsolationError(
          `${scope.scopeType === 'tenant' ? 'Tenant' : 'User'}-scope field ` +
            `policy ${operation}s require an ambient tenant context (or ` +
            `super-admin bypass); without one the caller identity is ` +
            `unattributable`,
        );
      }
      return;
    }

    if (isSuperAdminBypass()) {
      return;
    }

    if (scope.scopeType === 'app') {
      throw new TenantIsolationError(
        `App-scope field policy ${operation}s are not allowed inside a ` +
          'tenant context (use a system context or super-admin bypass)',
        { tenantId: context.tenantId },
      );
    }

    if (scope.scopeType === 'tenant' && scope.tenantId !== context.tenantId) {
      throw new TenantIsolationError(
        `Tenant isolation violation in FieldPolicy.${operation}: context ` +
          `tenant is '${context.tenantId}' but the row belongs to ` +
          `'${scope.tenantId}'`,
        {
          tenantId: context.tenantId,
          attemptedTenantId: scope.tenantId ?? undefined,
        },
      );
    }

    if (scope.scopeType === 'user') {
      // A MISSING identity component denies, never skips. Tenancy adapters
      // populate `permissions` while leaving `userId` undefined whenever no
      // `resolveUserId` hook is configured (API-key auth, service principals,
      // background jobs, a bare `withTenant({ tenantId })`), and user rows
      // carry `tenantId: null` by design — so skipping the check here would
      // let any such caller create, re-scope, or delete ANY user's rows in
      // ANY tenant, with the generated PUT echoing the row back as a read
      // primitive.
      if (context.userId === undefined) {
        throw new TenantIsolationError(
          `User-scope field policy ${operation}s require an ambient context ` +
            `that carries a user id; this context cannot attribute a ` +
            `user-scope write`,
          { tenantId: context.tenantId },
        );
      }
      if (scope.userId !== context.userId) {
        throw new TenantIsolationError(
          `Tenant isolation violation in FieldPolicy.${operation}: context ` +
            `user is '${context.userId}' but the row belongs to ` +
            `'${scope.userId}'`,
          { tenantId: context.tenantId },
        );
      }
    }
  }

  private validateTenantContextBoundary(): void {
    this.assertScopeOwnedByAmbientContext(
      {
        scopeType: this.scopeType,
        tenantId: this.tenantId,
        userId: this.userId,
      },
      'save',
    );
  }

  private validateDefaultAgainstSecurityRail(
    fieldDef: RegisteredFieldInfo,
  ): void {
    if (isTransientField(fieldDef)) {
      throw new Error(
        `Cannot store a default for transient field ` +
          `"${this.objectRef}.${this.fieldName}"`,
      );
    }
    if (isSensitiveField(fieldDef)) {
      throw new Error(
        `Cannot store a default for sensitive field ` +
          `"${this.objectRef}.${this.fieldName}"`,
      );
    }
    const readPermission = getFieldReadPermission(fieldDef);
    if (readPermission) {
      throw new Error(
        `Cannot store a default for read-permission-gated field ` +
          `"${this.objectRef}.${this.fieldName}" (requires "${readPermission}")`,
      );
    }
  }

  private parseDefaultValueOrThrow(): unknown {
    try {
      return JSON.parse(this.defaultValue as string);
    } catch (error) {
      throw new Error(
        `FieldPolicy default for "${this.objectRef}.${this.fieldName}" is ` +
          `not valid JSON: ${
            error instanceof Error ? error.message : String(error)
          }`,
      );
    }
  }

  /**
   * The persisted row this save/delete would replace, looked up by primary
   * key and — when that misses — by the NATURAL key.
   *
   * The natural-key fallback is load-bearing for authorization: every
   * generated create arrives with a freshly minted UUID, so a primary-key
   * lookup always misses, yet the `conflictColumns` upsert still overwrites
   * whatever row already occupies `(objectRef, fieldName, scopeType,
   * scopeKey)`. Authorizing on the primary key alone therefore skipped the
   * persisted-scope guard on exactly the path that can replace an existing
   * row's contents.
   */
  private async getPersistedIdentity(): Promise<FieldPolicyIdentity | null> {
    const existing =
      (await this.getPersistedRowById()) ??
      (await this.getPersistedRowByNaturalKey());
    if (!existing) {
      return null;
    }

    const row = existing;
    const read = (camel: string, snake: string, fallback: string): string => {
      if (row[camel] !== undefined && row[camel] !== null) {
        return String(row[camel]);
      }
      if (row[snake] !== undefined && row[snake] !== null) {
        return String(row[snake]);
      }
      return fallback;
    };
    const readNullable = (camel: string, snake: string): string | null => {
      const value = row[camel] !== undefined ? row[camel] : row[snake];
      return value === undefined || value === null ? null : String(value);
    };

    return {
      objectRef: read('objectRef', 'object_ref', this.objectRef),
      fieldName: read('fieldName', 'field_name', this.fieldName),
      scopeType: read('scopeType', 'scope_type', this.scopeType),
      scopeKey: read('scopeKey', 'scope_key', this.scopeKey),
      tenantId: readNullable('tenantId', 'tenant_id'),
      userId: readNullable('userId', 'user_id'),
    };
  }

  private async getPersistedRowById(): Promise<Record<string, unknown> | null> {
    if (!this.id) {
      return null;
    }
    const row = await this.db.get(this.tableName, { id: this.id });
    return (row as Record<string, unknown> | undefined) ?? null;
  }

  /**
   * The row occupying this row's `conflictColumns` tuple, if any. Column
   * names are the physical snake_case ones: this reads the driver directly
   * rather than through a collection (the model has no collection handle).
   */
  private async getPersistedRowByNaturalKey(): Promise<Record<
    string,
    unknown
  > | null> {
    if (!this.objectRef || !this.fieldName) {
      return null;
    }
    const row = await this.db.get(this.tableName, {
      object_ref: this.objectRef,
      field_name: this.fieldName,
      scope_type: this.scopeType,
      scope_key: this.computeScopeKey(),
    });
    return (row as Record<string, unknown> | undefined) ?? null;
  }

  private normalizeDefaultValueForPersistence(): void {
    const raw = this.defaultValue as unknown;

    if (raw === null || raw === undefined) {
      this.defaultValue = null;
      return;
    }

    if (typeof raw === 'string') {
      this.defaultValue = raw;
      return;
    }

    // Non-string writes (e.g. a plain value assigned directly) serialize so
    // the column always stores a JSON string.
    this.defaultValue = JSON.stringify(raw);
  }
}
