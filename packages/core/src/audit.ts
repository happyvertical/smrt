import type { DatabaseInterface } from '@happyvertical/sql';
import type { SmrtObject } from './object.js';
import type { SmrtObjectConstructor } from './registry/types.js';
import { ObjectRegistry } from './registry.js';
import { toSnakeCase } from './utils/naming.js';

/**
 * Reserved actor id the guest marker is recorded under. It is not a user row
 * and carries no per-tenant identity. It is accepted only through the typed
 * `{ callerKind: 'guest' }` variant; a caller-supplied string equal to it is
 * rejected by `requireAuditOptions`.
 */
export const GUEST_AUDIT_ACTOR = 'smrt:guest';

export type AuditCallerKind = 'user' | 'guest';

/**
 * Identities minted by {@link guestCreateAuditContext}. `requireAuditOptions`
 * accepts the guest marker only from one of these, so an arbitrary caller
 * cannot claim the reserved actor with a bare `{ callerKind: 'guest' }`.
 */
const guestCreateIdentities = new WeakSet<object>();

/**
 * The one audit identity the guest create pipeline passes. Not exported from
 * the package entry: only code inside core can mint it.
 */
export function guestCreateAuditContext(): GuestAuditContext {
  const identity: GuestAuditContext = Object.freeze({ callerKind: 'guest' });
  guestCreateIdentities.add(identity);
  return identity;
}

interface AuditContextBase {
  reason?: string;
  source?: 'web' | 'cli' | 'ci' | 'webhook' | 'mcp';
  onBehalfOfId?: string | null;
}

/** An authenticated user; identity comes from trusted server context. */
export interface UserAuditContext extends AuditContextBase {
  actorId: string;
  callerKind?: 'user';
}

/** The unauthenticated guest principal: no user row, no actor string. */
export interface GuestAuditContext extends AuditContextBase {
  callerKind: 'guest';
  actorId?: undefined;
}

/** Caller identity comes from trusted server context, never a request body. */
export type AuditContext = UserAuditContext | GuestAuditContext;

export interface AuditChange {
  before: unknown;
  after: unknown;
}

export interface AuditEntry extends AuditContextBase {
  /** Resolved actor; `GUEST_AUDIT_ACTOR` when `callerKind` is `'guest'`. */
  actorId: string;
  /** Absent means `user`. */
  callerKind?: AuditCallerKind;
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

export type CollectionAuditOptions = AuditContext & {
  writer: AuditWriter;
};

/** A validated audit configuration with the actor resolved. */
export type ResolvedAuditOptions = AuditContextBase & {
  writer: AuditWriter;
  actorId: string;
  callerKind: AuditCallerKind;
};

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
): ResolvedAuditOptions {
  const defaults = options ?? getActiveAuditOptions();
  const message =
    'Audited mutation requires a writer and an authenticated actorId';
  if (!defaults || typeof defaults.writer !== 'function') {
    throw new Error(message);
  }
  // An explicit context actor or kind replaces the default's whole identity.
  const identity =
    context && (context.callerKind !== undefined || 'actorId' in context)
      ? context
      : defaults;
  const { writer: _writer, ...rest } = { ...defaults, ...context };
  const base = rest as AuditContextBase;
  if (identity.callerKind === 'guest') {
    if (identity.actorId !== undefined) throw new Error(message);
    // Only the guest create pipeline's own identity carries the marker.
    if (!guestCreateIdentities.has(identity)) throw new Error(message);
    return {
      ...base,
      writer: defaults.writer,
      actorId: GUEST_AUDIT_ACTOR,
      callerKind: 'guest',
    };
  }
  const actorId = identity.actorId;
  if (identity.callerKind !== undefined && identity.callerKind !== 'user') {
    throw new Error(message);
  }
  if (
    typeof actorId !== 'string' ||
    !actorId.trim() ||
    actorId.trim() === GUEST_AUDIT_ACTOR
  ) {
    throw new Error(message);
  }
  return {
    ...base,
    writer: defaults.writer,
    actorId,
    callerKind: 'user',
  };
}

export async function writeAudit(
  instance: SmrtObject,
  action: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  options: ResolvedAuditOptions,
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
      callerKind: options.callerKind,
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
