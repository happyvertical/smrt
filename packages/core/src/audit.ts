import type { DatabaseInterface } from '@happyvertical/sql';
import type { SmrtObject } from './object.js';
import type { SmrtObjectConstructor } from './registry/types.js';
import { ObjectRegistry } from './registry.js';
import { toSnakeCase } from './utils/naming.js';

/** Caller identity comes from trusted server context, never a request body. */
export interface AuditContext {
  actorId: string;
  reason?: string;
  source?: 'web' | 'cli' | 'ci' | 'webhook' | 'mcp';
  onBehalfOfId?: string | null;
}

export interface AuditChange {
  before: unknown;
  after: unknown;
}

export interface AuditEntry extends AuditContext {
  action: string;
  resourceType: string;
  resourceId: string;
  tenantId: string | null;
  changes: Record<string, AuditChange>;
}

/** Writers MUST use this exact transaction handle and propagate failures. */
export type AuditWriter = (
  entry: AuditEntry,
  db: DatabaseInterface,
) => Promise<void>;

export interface CollectionAuditOptions extends AuditContext {
  writer: AuditWriter;
}

const CONTEXT = Symbol.for('smrt.audit.context');

/** Dependency-inverted lookup; the Node-only context module owns async scope. */
export function getActiveAuditOptions(): CollectionAuditOptions | undefined {
  const resolver = (globalThis as unknown as Record<symbol, unknown>)[CONTEXT];
  return typeof resolver === 'function' ? resolver() : undefined;
}

export function isAudited(instance: SmrtObject): boolean {
  const registered = ObjectRegistry.getClassByConstructor(
    instance.constructor as SmrtObjectConstructor,
  );
  const name =
    registered?.qualifiedName || registered?.name || instance.constructor.name;
  return [name, ...ObjectRegistry.getInheritanceChain(name)].some(
    (key) => ObjectRegistry.getConfig(key).audit === true,
  );
}

/** Snapshot the public projection: credentials and permission-gated fields are omitted. */
export function auditSnapshot(instance: SmrtObject): Record<string, unknown> {
  const snapshot = JSON.parse(
    JSON.stringify(instance.toPublicJSON()),
  ) as Record<string, unknown>;
  delete snapshot.created_at;
  delete snapshot.updated_at;
  return snapshot;
}

export function auditChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, AuditChange> {
  const changes: Record<string, AuditChange> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      changes[key] = { before: before[key] ?? null, after: after[key] ?? null };
    }
  }
  return changes;
}

export function requireAuditOptions(
  options: CollectionAuditOptions | undefined,
  context?: Partial<AuditContext>,
): CollectionAuditOptions {
  const defaults = options ?? getActiveAuditOptions();
  const resolved = defaults && { ...defaults, ...context };
  if (
    !resolved ||
    typeof resolved.writer !== 'function' ||
    !resolved.actorId?.trim()
  ) {
    throw new Error(
      'Audited mutation requires a writer and an authenticated actorId',
    );
  }
  return resolved;
}

export async function writeAudit(
  instance: SmrtObject,
  action: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  options: CollectionAuditOptions,
): Promise<void> {
  const registered = ObjectRegistry.getClassByConstructor(
    instance.constructor as SmrtObjectConstructor,
  );
  const resourceType =
    registered?.qualifiedName || registered?.name || instance.constructor.name;
  const runtimeColumns =
    ObjectRegistry.getRuntimeOwnershipColumns(resourceType);
  if (runtimeColumns.size > 1) {
    throw new Error('Audited mutation has ambiguous runtime tenant ownership');
  }
  const tenantColumn =
    runtimeColumns.size === 1
      ? runtimeColumns.values().next().value
      : ObjectRegistry.getOwnershipTenantColumn(resourceType);
  const fields = await ObjectRegistry.getAllFields(resourceType);
  const tenantField = tenantColumn
    ? [...fields.keys()].find((key) => toSnakeCase(key) === tenantColumn)
    : undefined;
  const tenantId = tenantField
    ? (instance as unknown as Record<string, unknown>)[tenantField]
    : null;
  await options.writer(
    {
      actorId: options.actorId,
      reason: options.reason,
      source: options.source,
      onBehalfOfId: options.onBehalfOfId,
      action,
      resourceType,
      resourceId: instance.id as string,
      tenantId: typeof tenantId === 'string' ? tenantId : null,
      changes: auditChanges(before, after),
    },
    instance.db,
  );
}
