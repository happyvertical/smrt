import type {
  SmrtClassOptions,
  SmrtObjectOptions,
} from '@happyvertical/smrt-core';

/**
 * Scope tier a {@link FieldPolicy} row belongs to.
 *
 * Resolution precedence is code seed → `app` → `tenant` (hierarchy walk,
 * root → leaf) → `user`. Unlike smrt-features (which ships only
 * `global`/`tenant`), the user tier is implemented end to end here — both
 * defaults and visibility resolve through it.
 */
export type FieldPolicyScopeType = 'app' | 'tenant' | 'user';

/**
 * Visibility tier for a field in generated/consuming form UIs.
 *
 * - `basic`: shown before the advanced disclosure
 * - `advanced`: shown behind the advanced disclosure
 * - `hidden`: not rendered (requires the field to be optional or have a
 *   resolved default — the required-field invariant)
 */
export type FieldPolicyVisibility = 'basic' | 'advanced' | 'hidden';

/**
 * `scopeKey` value for app-scope rows. `scopeKey` exists ONLY so the
 * `conflictColumns` unique index stays total while `tenantId`/`userId` are
 * nullable (nullable columns would allow duplicate NULL rows) — the same
 * trick as `PromptOverride.context`.
 */
export const APP_FIELD_POLICY_SCOPE_KEY = '__app__';

export const FIELD_POLICY_SCOPE_TYPES: readonly FieldPolicyScopeType[] = [
  'app',
  'tenant',
  'user',
];

export const FIELD_POLICY_VISIBILITIES: readonly FieldPolicyVisibility[] = [
  'basic',
  'advanced',
  'hidden',
];

export interface FieldPolicyOptions extends SmrtObjectOptions {
  objectRef?: string;
  fieldName?: string;
  scopeType?: FieldPolicyScopeType;
  tenantId?: string | null;
  userId?: string | null;
  /**
   * ENCODED channel: an already-JSON-encoded default, exactly as the column
   * stores it (`'"Net 30"'`, `'42'`, `'null'`), or `null` to inherit.
   *
   * This is the wire contract: the generated write routes hand the request
   * body straight to the constructor, and the #2049/#2050 gear posts
   * `JSON.stringify(draft.defaultValue)`. It must therefore keep meaning
   * "already encoded" — auto-serializing here would double-encode every gear
   * write.
   *
   * Use {@link FieldPolicyOptions.defaultValueRaw} for a plain value. The two
   * are mutually exclusive: `'"TBD"'` and `'TBD'` are indistinguishable once
   * a single option carries both meanings, so the channel must be explicit
   * rather than sniffed.
   */
  defaultValue?: string | null;
  /**
   * PLAIN channel: any value, always serialized — strings included. The
   * constructor-option twin of {@link FieldPolicy.setDefaultValue}, so
   * `{ defaultValueRaw: 'Net 30' }` stores `'"Net 30"'` rather than the
   * unparseable literal `Net 30`.
   */
  defaultValueRaw?: unknown;
  visibility?: FieldPolicyVisibility | null;
  help?: string | null;
  label?: string | null;
  displayOrder?: number | null;
  locked?: boolean | null;
  updatedBy?: string | null;
}

/**
 * The sparse contribution of one layer (code seed or one stored row).
 *
 * `default` is boxed so an explicit JSON `null` default (meaning "default to
 * null") stays distinguishable from "this layer contributes no default".
 */
export interface FieldPolicyDelta {
  default?: { value: unknown };
  visibility?: FieldPolicyVisibility;
  help?: string;
  label?: string;
  order?: number;
  locked?: boolean;
}

/** One layer's contribution to a field's resolved policy (explain variant). */
export interface FieldPolicyLayerContribution {
  layer: 'code' | 'app' | 'tenant' | 'user';
  /** Chain node id for `tenant` layers (root → leaf order). */
  tenantId?: string;
  /** User id for the `user` layer. */
  userId?: string;
  delta: FieldPolicyDelta;
}

/** Fully merged policy for a single field. */
export interface ResolvedFieldPolicy {
  fieldName: string;
  /** True when any layer resolved a default (including an explicit null). */
  hasDefault: boolean;
  /** Parsed default value; `undefined` when {@link hasDefault} is false. */
  defaultValue: unknown;
  visibility: FieldPolicyVisibility;
  help: string | null;
  label: string | null;
  order: number | null;
  /** Grouping key — code-seed only (`ui.group`), not overridable by rows. */
  group: string | null;
  locked: boolean;
  /** Mirror of the manifest required flag (nullable fields are optional). */
  required: boolean;
  /**
   * True when the resolver forced `basic` visibility because the field is
   * required and no usable default resolved (the resolver-side safety net for
   * the required-field invariant).
   */
  visibilityForced?: boolean;
}

/** Merged policy for every field of one object. */
export interface ResolvedObjectFieldPolicy {
  objectRef: string;
  fields: Record<string, ResolvedFieldPolicy>;
}

/**
 * Explain variant: merged result plus the ordered per-layer contributions for
 * each field, so admin/gear UIs (#2049/#2050) never re-derive precedence.
 * Layers are listed in application order (code, app, tenant chain root → leaf,
 * user) and contain ONLY contributions that survive into the merged result:
 * tenant ancestors discarded by a permission-inheritance break and user rows
 * suppressed by an effective org lock are omitted, so sequentially replaying
 * the listed deltas reproduces the merged policy.
 */
export interface ExplainedObjectFieldPolicy extends ResolvedObjectFieldPolicy {
  layers: Record<string, FieldPolicyLayerContribution[]>;
}

/** Minimal tenant node consumed by the hierarchy walk (mirrors smrt-features). */
export interface FieldPolicyTenantNode {
  id: string;
  inheritPermissions: boolean;
  cascadePermissions: boolean;
}

/** Provider returning the root → leaf tenant chain (mirrors smrt-features). */
export interface FieldPolicyTenantHierarchyProvider {
  getChain(tenantId: string): Promise<FieldPolicyTenantNode[]>;
}

/**
 * Loader-function DI seam (NOT a container registration): the resolver calls
 * it lazily and treats `null` as "no hierarchy available" (flat-tenant
 * fallback). The default loader dynamic-imports `@happyvertical/smrt-users`
 * and returns `null` when it is not installed.
 */
export type FieldPolicyTenantHierarchyLoader = (
  options: SmrtClassOptions,
) => Promise<FieldPolicyTenantHierarchyProvider | null>;

export interface ResolveFieldPolicyOptions {
  tenantId?: string | null;
  userId?: string | null;
  /**
   * Database holding `_smrt_field_policies`. Without it, only the code seed
   * resolves (stored layers are skipped) — the smrt-prompts precedent.
   */
  db?: SmrtClassOptions['db'];
  tenantHierarchyLoader?: FieldPolicyTenantHierarchyLoader;
  /**
   * Internal write-validation seam: omit persisted rows while evaluating a
   * proposed replacement. Excluded resolutions bypass the shared cache so a
   * projected result can never poison ordinary reads.
   */
  excludePolicyIds?: ReadonlySet<string>;
}

/**
 * Minimal structural shape of the tenant surface loaded from
 * `@happyvertical/smrt-users` by the default hierarchy loader. Only the
 * permission-cascade fields consumed by the chain walk are modeled.
 */
export interface FieldPolicyUsersTenantRecord {
  id: string;
  inheritPermissions?: boolean;
  cascadePermissions?: boolean;
}

export interface FieldPolicyUsersModule {
  TenantCollection: {
    create(options: SmrtClassOptions): Promise<{
      get(criteria: {
        id: string;
      }): Promise<FieldPolicyUsersTenantRecord | null>;
      getAncestorsFromRoot(
        tenantId: string,
      ): Promise<FieldPolicyUsersTenantRecord[]>;
    }>;
  };
}

/** Result shape of the batch resolve action (`FieldPolicyCollection.resolveBatch`). */
export interface FieldPolicyBatchResult {
  policies: Record<string, ResolvedObjectFieldPolicy>;
}

/** A policy row safe to expose through the context-scoped gear action. */
export interface FieldPolicyEditorRow {
  defaultValue: string | null;
  displayOrder: number | null;
  fieldName: string;
  help: string | null;
  id: string;
  label: string | null;
  locked: boolean | null;
  scopeType: FieldPolicyScopeType;
  tenantId: string | null;
  updatedBy: string | null;
  userId: string | null;
  visibility: FieldPolicyVisibility | null;
}

/** Context-derived authorization state for the field-policy gear. */
export interface FieldPolicyEditorCapabilities {
  manage: boolean;
  personalize: boolean;
}

/**
 * Gear bootstrap response. `policy` is always filtered by the public-field
 * rail; raw rows and explanation layers appear only for scopes the caller is
 * authorized to mutate. Row ids are present for reset/delete operations.
 */
export interface FieldPolicyEditorState {
  capabilities: FieldPolicyEditorCapabilities;
  /**
   * For the caller's personal layer only, whether removing that layer's
   * default still leaves a usable default at code/app/tenant precedence.
   * This intentionally exposes no lower-layer rows or default values.
   */
  personalLowerDefaultUsable: Record<string, boolean>;
  policy: ExplainedObjectFieldPolicy;
  rows: {
    app: FieldPolicyEditorRow[];
    tenant: FieldPolicyEditorRow[];
    user: FieldPolicyEditorRow[];
  };
}

/** A stored organization row with the immutable audit metadata needed by #2050. */
export interface FieldPolicyAuditRow extends FieldPolicyEditorRow {
  objectRef: string;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Why a persisted policy row is no longer usable by the live registry. */
export type FieldPolicyDriftReason =
  | 'unknown-object'
  | 'unknown-field'
  | 'excluded-field';

/** Drift is deliberately identity-only: stale values are never serialized. */
export interface FieldPolicyDriftRow {
  id: string;
  objectRef: string;
  fieldName: string;
  scopeType: FieldPolicyScopeType;
  tenantId: string | null;
  userId: string | null;
  updatedBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  reason: FieldPolicyDriftReason;
  prunable: boolean;
}

/**
 * Tenant-admin catalog read surface. Foreign user rows are represented only
 * by counts; their values and identifiers never leave the collection.
 */
export interface FieldPolicyAuditSnapshot {
  orgRows: FieldPolicyAuditRow[];
  appRows: FieldPolicyAuditRow[];
  inheritedOrgKeys: Record<string, string[]>;
  userOverrideCounts: Record<string, Record<string, number>>;
  driftRows: FieldPolicyDriftRow[];
  policies: Record<string, ExplainedObjectFieldPolicy>;
  caller: {
    tenantId: string | null;
    userId: string | null;
    canManageOrg: boolean;
    canPersonalize: boolean;
  };
}

/** Explicit 403 result used by generated custom-action transports. */
export interface FieldPolicyEditorStateDenied {
  code: 'permission_denied';
  message: string;
  ok: false;
  status: 403;
}

export type FieldPolicyEditorStateResult =
  | FieldPolicyEditorState
  | FieldPolicyEditorStateDenied;

export type { SmrtClassOptions };
