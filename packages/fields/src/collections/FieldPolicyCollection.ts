import { SmrtCollection, smrt } from '@happyvertical/smrt-core';
import { getCurrentTenant } from '@happyvertical/smrt-tenancy';
import {
  getFieldReadPermission,
  getObjectFieldMap,
  isSensitiveField,
  isTransientField,
} from '../field-definitions.js';
import { FieldPolicy } from '../models/FieldPolicy.js';
import type {
  FieldPolicyBatchResult,
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
@smrt({
  api: {
    include: ['create', 'update', 'delete', 'resolveBatch'],
    routes: {
      resolveBatch: {
        scope: 'collection',
        method: 'POST',
        path: 'resolve',
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
}
