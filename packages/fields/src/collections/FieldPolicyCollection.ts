import { SmrtCollection, smrt } from '@happyvertical/smrt-core';
import { getCurrentTenant } from '@happyvertical/smrt-tenancy';
import { checkOperationPermission } from '@happyvertical/smrt-users';
import {
  getFieldReadPermission,
  getObjectFieldMap,
  isSensitiveField,
  isTransientField,
  isUsableRequiredDefault,
} from '../field-definitions.js';
import { FieldPolicy } from '../models/FieldPolicy.js';
import {
  MANAGE_FIELD_POLICY_PERMISSION,
  PERSONALIZE_FIELD_POLICY_PERMISSION,
} from '../permissions.js';
import type {
  ExplainedObjectFieldPolicy,
  FieldPolicyBatchResult,
  FieldPolicyEditorRow,
  FieldPolicyEditorStateResult,
  ResolvedObjectFieldPolicy,
} from '../types.js';

/** Upper bound on objectRefs per batch call — bounds registry/db work per request. */
const MAX_BATCH_OBJECT_REFS = 100;

/**
 * Collection surface for {@link FieldPolicy} rows plus the batch resolve
 * action consumed by client bootstrapping (#2048).
 *
 * `resolveBatch` is a custom collection-scoped action (NOT a system route —
 * core's generated system trio is closed): the generated route parses the
 * body, calls the method on the app-configured collection instance (which
 * carries the app database), and serializes the plain result.
 *
 * Exposure note: a decorated collection's config becomes the RUNTIME registry
 * authority for its item class (core merges the collection registration onto
 * the item slot), while build-time generation reads each manifest object's
 * own config. This config therefore mirrors FieldPolicy's API posture —
 * writes open plus the batch action, reads CLOSED (generated list/get would
 * enumerate every tenant's/user's rows) — and closes the runtime CLI/MCP
 * surfaces entirely (the ContentContributions precedent; the cli↔api
 * coherence gate does not admit standard CRUD entries on a collection's
 * `cli.include`). Keep the api include lists in lockstep with FieldPolicy's.
 */
// `conflictColumns` MUST mirror FieldPolicy's. A decorated collection emits
// its OWN schema for the item's table (`_smrt_field_policies`), and without
// the natural key that schema falls back to SmrtObject's default unique
// `(slug, context)` index. Manifest-driven migrations aggregate both schemas
// onto the one physical table, so the stray index would reject legitimate
// layered rows — every policy row has a NULL slug and context, and the app,
// tenant, and user rows for a field are distinct only by the real natural key.
@smrt({
  conflictColumns: ['object_ref', 'field_name', 'scope_type', 'scope_key'],
  api: {
    include: ['create', 'update', 'delete', 'resolveBatch', 'getEditorState'],
    routes: {
      resolveBatch: {
        scope: 'collection',
        method: 'POST',
        path: 'resolve',
      },
      getEditorState: {
        scope: 'collection',
        method: 'POST',
        path: 'editor-state',
      },
    },
  },
  cli: false,
  mcp: false,
})
export class FieldPolicyCollection extends SmrtCollection<FieldPolicy> {
  static readonly _itemClass = FieldPolicy;

  /** All app-scope rows for an object, keyed by field name. */
  async getAppRows(objectRef: string): Promise<Map<string, FieldPolicy>> {
    const rows = await this.list({
      where: { objectRef, scopeType: 'app' },
    });
    const byField = new Map<string, FieldPolicy>();
    for (const row of rows) {
      byField.set(row.fieldName, row);
    }
    return byField;
  }

  /**
   * All tenant-scope rows for an object across a tenant chain, keyed
   * `tenantId → fieldName → row`.
   */
  async getTenantRows(
    objectRef: string,
    tenantIds: string[],
  ): Promise<Map<string, Map<string, FieldPolicy>>> {
    const byTenant = new Map<string, Map<string, FieldPolicy>>();
    if (tenantIds.length === 0) {
      return byTenant;
    }

    const rows = await this.list({
      where: { objectRef, scopeType: 'tenant', 'tenantId in': tenantIds },
    });
    for (const row of rows) {
      if (!row.tenantId) {
        continue;
      }
      let byField = byTenant.get(row.tenantId);
      if (!byField) {
        byField = new Map<string, FieldPolicy>();
        byTenant.set(row.tenantId, byField);
      }
      byField.set(row.fieldName, row);
    }
    return byTenant;
  }

  /** All user-scope rows for an object and user, keyed by field name. */
  async getUserRows(
    objectRef: string,
    userId: string,
  ): Promise<Map<string, FieldPolicy>> {
    const rows = await this.list({
      where: { objectRef, scopeType: 'user', userId },
    });
    const byField = new Map<string, FieldPolicy>();
    for (const row of rows) {
      byField.set(row.fieldName, row);
    }
    return byField;
  }

  /**
   * Resolve merged field policy for a set of objectRefs for the CURRENT
   * caller, gated for public consumption.
   *
   * Caller identity comes exclusively from the ambient tenant context
   * (established by the app's auth hook, e.g. smrt-users' session context) —
   * the request body cannot select another tenant or user (fail closed).
   * Server-side consumers wanting explicit identities call
   * `resolveFieldPolicy()` directly instead.
   *
   * Field gating mirrors the REST serializer's derivation (`sensitive` /
   * `readPermission` read from both the top level and `_meta`): sensitive and
   * read-permission-gated fields are ABSENT from the response for every
   * caller (the generated action route cannot convey per-caller grants to
   * this method, so gated fields fail closed), and transient fields are
   * stripped for parity with generated client field definitions.
   */
  async resolveBatch(
    options: { objectRefs?: string[] } = {},
  ): Promise<FieldPolicyBatchResult> {
    const rawRefs = options.objectRefs;
    if (!Array.isArray(rawRefs) || rawRefs.length === 0) {
      throw new Error(
        'resolveBatch requires a non-empty "objectRefs" string array',
      );
    }
    if (rawRefs.some((ref) => typeof ref !== 'string' || ref.trim() === '')) {
      throw new Error('resolveBatch objectRefs must be non-empty strings');
    }
    const objectRefs = [...new Set(rawRefs)];
    if (objectRefs.length > MAX_BATCH_OBJECT_REFS) {
      throw new Error(
        `resolveBatch accepts at most ${MAX_BATCH_OBJECT_REFS} objectRefs ` +
          `per call (got ${objectRefs.length})`,
      );
    }

    const context = getCurrentTenant();
    const tenantId = context?.tenantId ?? null;
    const userId = context?.userId ?? null;

    // Dynamic import breaks the module cycle with the resolver (which imports
    // this collection statically for its row reads).
    const { resolveFieldPolicy } = await import('../field-policy-resolver.js');

    const policies: Record<string, ResolvedObjectFieldPolicy> = {};
    for (const objectRef of objectRefs) {
      const resolved = await resolveFieldPolicy(objectRef, {
        tenantId,
        userId,
        db: this.db,
      });
      policies[objectRef] = await this.gateResolvedForPublicResponse(resolved);
    }

    return { policies };
  }

  /**
   * Context-derived bootstrap data for the policy gear. This is deliberately
   * a collection action instead of reopening list/get: a caller can inspect
   * only their safe effective policy and rows/layers they are permitted to
   * edit, never arbitrary tenant or user policy rows.
   */
  async getEditorState(
    options: { objectRef?: string } = {},
  ): Promise<FieldPolicyEditorStateResult> {
    const objectRef = options.objectRef;
    if (typeof objectRef !== 'string' || objectRef.trim() === '') {
      throw new Error('getEditorState requires a non-empty "objectRef" string');
    }

    const context = getCurrentTenant();
    const permissionOptions = {
      collection: 'fields.policy',
      db: this.db,
      tenantId: context?.tenantId ?? null,
      userId: context?.userId ?? null,
      permissionSet: context?.permissions,
      onDeny: 'return' as const,
    };
    const manage = await checkOperationPermission({
      ...permissionOptions,
      action: MANAGE_FIELD_POLICY_PERMISSION.split('.').at(-1) ?? 'manage',
    });
    const personalize = await checkOperationPermission({
      ...permissionOptions,
      action:
        PERSONALIZE_FIELD_POLICY_PERMISSION.split('.').at(-1) ?? 'personalize',
    });

    // A permission alone cannot make a personal layer usable: service/API-key
    // contexts without a user identity must never receive a personal tab (or
    // an affirmative capability they cannot safely act on).
    const personalizeAllowed =
      personalize.allowed &&
      typeof context?.userId === 'string' &&
      context.userId.length > 0;

    if (!manage.allowed && !personalizeAllowed) {
      // The runtime custom-action transport maps explicit failures to their
      // requested non-2xx status. Returning one avoids its generic catch-all
      // turning an authorization denial into a misleading 500.
      return {
        code: 'permission_denied',
        message: `Permission denied for '${personalize.permission ?? MANAGE_FIELD_POLICY_PERMISSION}'.`,
        ok: false,
        status: 403,
      };
    }

    const { resolveFieldPolicyExplained } = await import(
      '../field-policy-resolver.js'
    );
    const resolved = await resolveFieldPolicyExplained(objectRef, {
      tenantId: context?.tenantId ?? null,
      userId: context?.userId ?? null,
      db: this.db,
    });
    const policy = await this.gateExplainedForEditorResponse(resolved, {
      manage: manage.allowed,
      personalize: personalizeAllowed,
    });
    const fieldNames = new Set(Object.keys(policy.fields));
    // A personal editor must be able to preserve the required-field invariant
    // when it clears its own default, but a personalize-only caller cannot
    // receive app/tenant rows or explanation layers. Return only the boolean
    // answer for code/app/tenant resolution; never the contributing rows or
    // their default values.
    const personalLowerDefaultUsable = personalizeAllowed
      ? await this.getPersonalLowerDefaultUsability(
          objectRef,
          context?.tenantId ?? null,
          fieldNames,
        )
      : {};

    const appRows = manage.allowed
      ? this.toEditorRows(await this.getAppRows(objectRef), fieldNames)
      : [];
    const tenantRows =
      manage.allowed && context?.tenantId
        ? this.toEditorRows(
            (await this.getTenantRows(objectRef, [context.tenantId])).get(
              context.tenantId,
            ) ?? new Map(),
            fieldNames,
          )
        : [];
    const userRows =
      personalizeAllowed && context?.userId
        ? this.toEditorRows(
            await this.getUserRows(objectRef, context.userId),
            fieldNames,
          )
        : [];

    return {
      capabilities: {
        manage: manage.allowed,
        personalize: personalizeAllowed,
      },
      personalLowerDefaultUsable,
      policy,
      rows: { app: appRows, tenant: tenantRows, user: userRows },
    };
  }

  /**
   * Compute the non-disclosing fallback signal used only by personal drafts.
   * Passing no user id resolves exactly code/app/tenant precedence, including
   * the real tenant hierarchy, while keeping every lower-layer value server
   * side. The public map is limited to fields already admitted by the editor
   * response's security rail.
   */
  private async getPersonalLowerDefaultUsability(
    objectRef: string,
    tenantId: string | null,
    fieldNames: ReadonlySet<string>,
  ): Promise<Record<string, boolean>> {
    const { resolveFieldPolicy } = await import('../field-policy-resolver.js');
    const lowerPolicy = await resolveFieldPolicy(objectRef, {
      tenantId,
      db: this.db,
    });
    return Object.fromEntries(
      Array.from(fieldNames, (fieldName) => {
        const field = lowerPolicy.fields[fieldName];
        return [
          fieldName,
          isUsableRequiredDefault(
            field?.hasDefault ? { value: field.defaultValue } : undefined,
          ),
        ];
      }),
    );
  }

  private async gateResolvedForPublicResponse(
    resolved: ResolvedObjectFieldPolicy,
  ): Promise<ResolvedObjectFieldPolicy> {
    const fieldMap = await getObjectFieldMap(resolved.objectRef);
    const fields: ResolvedObjectFieldPolicy['fields'] = {};

    for (const [fieldName, policy] of Object.entries(resolved.fields)) {
      const fieldDef = fieldMap.get(fieldName);
      if (!fieldDef) {
        continue;
      }
      if (
        isSensitiveField(fieldDef) ||
        getFieldReadPermission(fieldDef) !== undefined ||
        isTransientField(fieldDef)
      ) {
        continue;
      }
      fields[fieldName] = policy;
    }

    return { objectRef: resolved.objectRef, fields };
  }

  private async gateExplainedForEditorResponse(
    resolved: ExplainedObjectFieldPolicy,
    capabilities: { manage: boolean; personalize: boolean },
  ): Promise<ExplainedObjectFieldPolicy> {
    const fieldMap = await getObjectFieldMap(resolved.objectRef);
    const fields: ExplainedObjectFieldPolicy['fields'] = {};
    const layers: ExplainedObjectFieldPolicy['layers'] = {};

    for (const [fieldName, policy] of Object.entries(resolved.fields)) {
      const fieldDef = fieldMap.get(fieldName);
      if (
        !fieldDef ||
        isSensitiveField(fieldDef) ||
        getFieldReadPermission(fieldDef) !== undefined ||
        isTransientField(fieldDef)
      ) {
        continue;
      }

      fields[fieldName] = policy;
      layers[fieldName] = (resolved.layers[fieldName] ?? []).filter(
        (layer) =>
          (capabilities.manage &&
            (layer.layer === 'app' || layer.layer === 'tenant')) ||
          (capabilities.personalize && layer.layer === 'user'),
      );
    }

    return { objectRef: resolved.objectRef, fields, layers };
  }

  private toEditorRows(
    rows: Map<string, FieldPolicy>,
    allowedFieldNames: ReadonlySet<string>,
  ): FieldPolicyEditorRow[] {
    return Array.from(rows.values())
      .filter((row) => allowedFieldNames.has(row.fieldName))
      .map((row) => ({
        defaultValue: row.defaultValue,
        displayOrder: row.displayOrder,
        fieldName: row.fieldName,
        help: row.help,
        id: String(row.id),
        label: row.label,
        locked: row.locked,
        scopeType: row.scopeType,
        tenantId: row.tenantId,
        updatedBy: row.updatedBy,
        userId: row.userId,
        visibility: row.visibility,
      }))
      .sort((left, right) => left.fieldName.localeCompare(right.fieldName));
  }
}
