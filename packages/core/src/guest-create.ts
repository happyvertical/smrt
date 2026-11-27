/**
 * Guest creates (#5196, slice E): framework-neutral primitives for letting an
 * unauthenticated caller INSERT one row into an app-opted collection, such as
 * a contact form. Nothing here reads, updates or deletes, and nothing reveals
 * whether a row already existed.
 *
 * - {@link defineGuestCreate} validates the per-collection allowed-field list
 *   at registration and rejects protected, system and sensitive fields.
 * - {@link projectGuestBody} keeps only allowed fields and enforces size caps.
 * - {@link executeGuestCreate} rate-limits (recorded before the write), then
 *   runs a plain `INSERT ... ON CONFLICT DO NOTHING` without `RETURNING`, with
 *   a server-generated id and a server-set tenant id.
 *
 * @module
 */

import { randomUUID } from 'node:crypto';
import {
  type AuditEntry,
  type AuditWriter,
  type CollectionAuditOptions,
  requireAuditOptions,
} from './audit.js';
import { bumpChangeFeed } from './change-feed.js';
import { usesPostgresDialect } from './embedded-write-queue.js';
import { ValidationError } from './errors.js';
import { BoundedSlidingWindowRateLimiter, extractClientIp } from './http.js';
import { getEffectiveFieldsSync } from './registry/inheritance-resolver.js';
import { ObjectRegistry } from './registry.js';

/** Per-collection guest-create configuration supplied by the app. */
export interface GuestCreateConfig {
  /** Body fields a guest may set. Protected and system fields are rejected. */
  allowedFields: string[];
  /** Maximum serialized body size in bytes. Default 16 KiB. */
  maxBodyBytes?: number;
  /** Maximum length of any string value. Default 4,000. */
  maxStringLength?: number;
}

/** A validated, frozen guest-create configuration. */
export interface ResolvedGuestCreateConfig {
  readonly collection: string;
  readonly allowedFields: readonly string[];
  readonly maxBodyBytes: number;
  readonly maxStringLength: number;
}

/** Optional registration-time knobs for {@link defineGuestCreate}. */
export interface DefineGuestCreateOptions {
  /** Extra column names (snake_case or camelCase) that may never be listed. */
  protectedFields?: readonly string[];
  /**
   * The registry key of the model the collection maps to. When given the model
   * MUST be registered (a miss throws, so field checks can never be skipped by
   * a slug that is not a class name) and must be a plain table: no STI and no
   * write-through, whose rows a plain INSERT cannot represent.
   */
  className?: string;
}

export const DEFAULT_GUEST_MAX_BODY_BYTES = 16 * 1024;
export const DEFAULT_GUEST_MAX_STRING_LENGTH = 4_000;

/** Columns a guest can never set, whatever the app lists. */
const ALWAYS_PROTECTED = new Set([
  'id',
  'tenant_id',
  'tenant',
  'owner',
  'owner_id',
  'user_id',
  'created_by',
  'updated_by',
  'created_at',
  'updated_at',
  'deleted_at',
  'profile_id',
  'actor_id',
  'actor_kind',
]);

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function snake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

/** Thrown when a guest body breaks a size cap. */
export class GuestCreateBodyError extends ValidationError {
  constructor(message: string, code: string) {
    super(message, code);
    this.name = 'GuestCreateBodyError';
  }
}

function flagged(field: unknown, key: string): boolean {
  const f = field as
    | (Record<string, unknown> & {
        _meta?: Record<string, unknown>;
        options?: Record<string, unknown>;
      })
    | undefined;
  return (
    f?.[key] === true || f?._meta?.[key] === true || f?.options?.[key] === true
  );
}

/**
 * Validate a guest-create configuration for one collection. Throws on any
 * protected, system, sensitive or unknown field (when the class is registered)
 * so a bad list fails at registration, never at request time.
 */
export function defineGuestCreate(
  collection: string,
  config: GuestCreateConfig,
  options: DefineGuestCreateOptions = {},
): ResolvedGuestCreateConfig {
  if (!collection || !IDENTIFIER.test(collection)) {
    throw new ValidationError(
      `guest create: invalid collection name "${collection}"`,
      'GUEST_CREATE_INVALID_COLLECTION',
    );
  }
  const list = config?.allowedFields;
  if (!Array.isArray(list) || list.length === 0) {
    throw new ValidationError(
      `guest create for "${collection}": allowedFields must be a non-empty array`,
      'GUEST_CREATE_NO_FIELDS',
    );
  }
  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_GUEST_MAX_BODY_BYTES;
  const maxStringLength =
    config.maxStringLength ?? DEFAULT_GUEST_MAX_STRING_LENGTH;
  for (const [label, value] of [
    ['maxBodyBytes', maxBodyBytes],
    ['maxStringLength', maxStringLength],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new ValidationError(
        `guest create for "${collection}": ${label} must be a positive integer`,
        'GUEST_CREATE_INVALID_LIMIT',
      );
    }
  }

  const protectedNames = new Set(ALWAYS_PROTECTED);
  for (const extra of options.protectedFields ?? [])
    protectedNames.add(snake(extra));

  const registered = ObjectRegistry.getClass(options.className ?? collection);
  if (options.className !== undefined && !registered) {
    throw new ValidationError(
      `guest create for "${collection}": model "${options.className}" is not registered`,
      'GUEST_CREATE_UNREGISTERED_MODEL',
    );
  }
  let registryFields: Map<string, unknown> | undefined;
  if (registered) {
    const key = registered.qualifiedName ?? registered.name;
    if (
      ObjectRegistry.getTableStrategy(key) === 'sti' ||
      (registered.config as { writeThrough?: unknown } | undefined)
        ?.writeThrough !== undefined
    ) {
      throw new ValidationError(
        `guest create: collection "${collection}" uses STI or write-through`,
        'GUEST_CREATE_UNSUPPORTED_MODEL',
      );
    }
    const tenantColumn = ObjectRegistry.getOwnershipTenantColumn(key);
    if (tenantColumn) protectedNames.add(tenantColumn);
    if (
      (registered.config as { sensitive?: unknown } | undefined)?.sensitive ===
      true
    ) {
      throw new ValidationError(
        `guest create: collection "${collection}" is sensitive`,
        'GUEST_CREATE_SENSITIVE_COLLECTION',
      );
    }
    registryFields = getEffectiveFieldsSync(registered);
  }

  const seen = new Set<string>();
  const fields: string[] = [];
  for (const name of list) {
    if (typeof name !== 'string' || !IDENTIFIER.test(name)) {
      throw new ValidationError(
        `guest create for "${collection}": invalid field name ${JSON.stringify(name)}`,
        'GUEST_CREATE_INVALID_FIELD',
      );
    }
    const column = snake(name);
    if (protectedNames.has(column)) {
      throw new ValidationError(
        `guest create for "${collection}": field "${name}" is protected and cannot be guest-writable`,
        'GUEST_CREATE_PROTECTED_FIELD',
        { collection, field: name },
      );
    }
    if (registryFields) {
      const field = registryFields.get(name);
      if (!field) {
        throw new ValidationError(
          `guest create for "${collection}": unknown field "${name}"`,
          'GUEST_CREATE_UNKNOWN_FIELD',
          { collection, field: name },
        );
      }
      if (
        flagged(field, 'sensitive') ||
        flagged(field, 'system') ||
        flagged(field, 'readonly') ||
        flagged(field, 'readOnly')
      ) {
        throw new ValidationError(
          `guest create for "${collection}": field "${name}" is sensitive, system or read-only`,
          'GUEST_CREATE_PROTECTED_FIELD',
          { collection, field: name },
        );
      }
    }
    if (seen.has(column)) continue;
    seen.add(column);
    fields.push(name);
  }
  return Object.freeze({
    collection,
    allowedFields: Object.freeze(fields),
    maxBodyBytes,
    maxStringLength,
  });
}

/**
 * Keep only the allowed fields of `body`, with primitive values. Unknown
 * fields, nested values, and anything naming `id` or the tenant column are
 * dropped; an over-size body or string throws {@link GuestCreateBodyError}.
 */
export function projectGuestBody(
  body: unknown,
  config: ResolvedGuestCreateConfig,
): Record<string, string | number | boolean | null> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new GuestCreateBodyError(
      'guest create body must be an object',
      'GUEST_CREATE_BAD_BODY',
    );
  }
  let bytes: number;
  try {
    bytes = new TextEncoder().encode(JSON.stringify(body)).length;
  } catch {
    throw new GuestCreateBodyError(
      'guest create body is not serializable',
      'GUEST_CREATE_BAD_BODY',
    );
  }
  if (bytes > config.maxBodyBytes) {
    throw new GuestCreateBodyError(
      'guest create body is too large',
      'GUEST_CREATE_BODY_TOO_LARGE',
    );
  }
  const out: Record<string, string | number | boolean | null> = {};
  for (const name of config.allowedFields) {
    if (!Object.hasOwn(body, name)) continue;
    const value = (body as Record<string, unknown>)[name];
    if (typeof value === 'string') {
      if (value.length > config.maxStringLength) {
        throw new GuestCreateBodyError(
          `guest create field "${name}" is too long`,
          'GUEST_CREATE_STRING_TOO_LONG',
        );
      }
      out[name] = value;
    } else if (typeof value === 'boolean' || value === null) {
      out[name] = value;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[name] = value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Client keys
// ---------------------------------------------------------------------------

function expandIpv6(address: string): number[] | null {
  let text = address.split('%')[0].toLowerCase();
  const v4 = text.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const parts = [v4[2], v4[3], v4[4], v4[5]].map(Number);
    if (parts.some((p) => p > 255)) return null;
    text = `${v4[1]}${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [
    ...head,
    ...Array(halves.length === 2 ? missing : 0).fill('0'),
    ...tail,
  ];
  const out = groups.map((g) =>
    /^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN,
  );
  return out.length === 8 && out.every((n) => !Number.isNaN(n)) ? out : null;
}

/** Normalise an IP to its rate-limit identity: IPv6 collapses to its /64. */
export function normalizeClientIdentity(ip: string): string {
  if (!ip.includes(':')) return ip.toLowerCase();
  const groups = expandIpv6(ip);
  if (!groups) return ip.toLowerCase();
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(':')}::/64`;
}

/**
 * Per-client identity for guest rate limits: the client IP resolved with an
 * explicit trusted-hop count (never an implicit one), IPv6 reduced to its /64.
 */
export function clientKeyFor(
  request: Request,
  trustedHops: number | boolean,
  socketRemoteAddress?: string,
): string {
  return normalizeClientIdentity(
    extractClientIp(request, socketRemoteAddress, trustedHops),
  );
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

export interface GuestCreateLimiterOptions {
  /** Creates per client per window. Default 5. */
  perClient?: number;
  /** Creates per tenant per window. Default 60. */
  perTenant?: number;
  /** Window in ms. Default 60,000. */
  windowMs?: number;
  /** Max distinct keys per limiter. Default 10,000. */
  maxEntries?: number;
}

/** The pair of limiters a guest create is charged against. */
export interface GuestCreateLimiter {
  readonly client: BoundedSlidingWindowRateLimiter;
  readonly tenant: BoundedSlidingWindowRateLimiter;
}

/** Build the per-client and per-tenant limiters (full table denies new keys). */
export function createGuestCreateLimiter(
  options: GuestCreateLimiterOptions = {},
): GuestCreateLimiter {
  const windowMs = options.windowMs ?? 60_000;
  const maxEntries = options.maxEntries ?? 10_000;
  return {
    client: new BoundedSlidingWindowRateLimiter({
      maxEvents: options.perClient ?? 5,
      windowMs,
      maxEntries,
      denyWhenFull: true,
    }),
    tenant: new BoundedSlidingWindowRateLimiter({
      maxEvents: options.perTenant ?? 60,
      windowMs,
      maxEntries,
      denyWhenFull: true,
    }),
  };
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

/** Minimal database surface needed for the insert. */
export interface GuestCreateDb {
  query(sql: string, ...values: unknown[]): Promise<unknown>;
  /**
   * Nested transaction (a savepoint inside the request transaction). Required:
   * the insert and its audit row commit or roll back together, and the
   * request transaction alone cannot give that (a handler that turns a
   * failure into a response still lets the request transaction commit).
   */
  transaction?<T>(callback: (tx: GuestCreateDb) => Promise<T>): Promise<T>;
}

/** The audit sink a guest create writes through (never optional). */
export interface GuestCreateAudit {
  /** The app's audit writer (profiles `createAuditWriter()`). */
  writer: AuditWriter;
  /** Registry name recorded as the audited resource type. */
  resourceType: string;
}

export interface ExecuteGuestCreateInput {
  db: GuestCreateDb;
  /** Physical table name (validated as a plain identifier). */
  table: string;
  tenantId: string;
  body: unknown;
  config: ResolvedGuestCreateConfig;
  limiter: GuestCreateLimiter;
  /** Output of {@link clientKeyFor}. */
  clientKey: string;
  /** Audit sink; the create fails when it cannot be written. */
  audit: GuestCreateAudit;
  /** Tenant column. Default `tenant_id`. */
  tenantColumn?: string;
  /** Trusted server-side column values (e.g. timestamps); never from the body. */
  serverValues?: Record<string, string | number | boolean | null>;
  /**
   * Column defaults for fields the caller did not send ({@link guestRowDefaults});
   * the projected body overrides them, server-owned columns override both.
   */
  defaults?: Record<string, string | number | boolean | null>;
  /**
   * Record the insert in the change feed (default true). Off only for a
   * hand-built table that is not observable.
   */
  changeFeed?: boolean;
  /**
   * Also write the framework's own columns (`slug`, `context`, `created_at`,
   * `updated_at`) a SMRT table carries. Off for a hand-built table.
   */
  smrtColumns?: boolean;
  /** Clock override for tests. */
  nowMs?: number;
}

/** Result: identical for a fresh insert and a unique conflict; no row, no id. */
export type GuestCreateResult =
  | { status: 'created'; retryAfterSeconds: 0 }
  | { status: 'rate_limited'; retryAfterSeconds: number };

function quote(identifier: string): string {
  if (!IDENTIFIER.test(identifier)) {
    throw new ValidationError(
      `guest create: invalid identifier "${identifier}"`,
      'GUEST_CREATE_INVALID_IDENTIFIER',
    );
  }
  return `"${identifier}"`;
}

/**
 * Charge the rate limits, then insert one row. The limit check and record are
 * synchronous (no await between them), so concurrent requests cannot both pass
 * the last slot, and the event is recorded before the write whether or not the
 * write later conflicts.
 */
export async function executeGuestCreate(
  input: ExecuteGuestCreateInput,
): Promise<GuestCreateResult> {
  const { config, limiter, tenantId } = input;
  if (!tenantId) {
    throw new ValidationError(
      'guest create requires a resolved tenant',
      'GUEST_CREATE_NO_TENANT',
    );
  }
  const tenantColumn = input.tenantColumn ?? 'tenant_id';
  const projected = projectGuestBody(input.body, config);

  const now = input.nowMs ?? Date.now();
  const clientKey = `${tenantId}:${input.clientKey}`;
  const waits = [
    limiter.tenant.check(tenantId, now),
    limiter.client.check(clientKey, now),
  ].filter((n): n is number => n !== null);
  if (waits.length > 0) {
    return { status: 'rate_limited', retryAfterSeconds: Math.max(...waits) };
  }
  limiter.tenant.record(tenantId, now);
  limiter.client.record(clientKey, now);

  const values: Record<string, unknown> = { ...(input.defaults ?? {}) };
  for (const [name, value] of Object.entries(projected)) {
    values[snake(name)] = value;
  }
  for (const [name, value] of Object.entries(input.serverValues ?? {})) {
    values[snake(name)] = value;
  }
  // Server-owned columns always win, whatever else was supplied.
  values.id = randomUUID();
  values[tenantColumn] = tenantId;
  if (input.smrtColumns) {
    const stamp = new Date(now).toISOString();
    values.slug = values.id;
    values.context ??= '';
    values.created_at = stamp;
    values.updated_at = stamp;
  }

  const id = values.id as string;

  const columns = Object.keys(values);
  const postgres = usesPostgresDialect(input.db as never);
  const placeholders = columns.map((_, i) => (postgres ? `$${i + 1}` : '?'));
  const sql = `INSERT INTO ${quote(input.table)} (${columns
    .map(quote)
    .join(', ')}) VALUES (${placeholders.join(', ')}) ON CONFLICT DO NOTHING`;

  // Resolve the audit identity before touching the database: only the typed
  // guest variant yields the reserved marker.
  const resolved = requireAuditOptions(
    {
      writer: input.audit.writer,
      callerKind: 'guest',
    } as CollectionAuditOptions,
    { callerKind: 'guest' },
  );
  const changes: AuditEntry['changes'] = {};
  for (const [name, value] of Object.entries(projected)) {
    changes[name] = { before: null, after: value };
  }

  if (typeof input.db.transaction !== 'function') {
    throw new ValidationError(
      'guest create requires a database that supports nested transactions',
      'GUEST_CREATE_NO_TRANSACTION',
    );
  }
  // One savepoint around the insert AND its audit row: a failed audit write
  // rolls the insert back, whatever the request does with the error.
  await input.db.transaction(async (tx) => {
    const result = await tx.query(sql, ...columns.map((c) => values[c]));
    // No audit row when nothing was inserted (a conflict). When the driver
    // does not report a count, the row is audited: never skip on unknown.
    const rowCount = (result as { rowCount?: unknown } | null)?.rowCount;
    if (rowCount === 0) return;
    // A raw insert never reaches the ORM's change-feed hook; without this a
    // staff read answered from the table-version ETag would keep returning
    // 304 and never show the new row. Same savepoint: it commits or rolls
    // back with the insert.
    if (input.changeFeed !== false) {
      await bumpChangeFeed(tx as never, {
        table: input.table,
        rowId: id,
        operation: 'create',
        tenantId,
      });
    }
    await resolved.writer(
      {
        actorId: resolved.actorId,
        callerKind: 'guest',
        source: 'web',
        action: 'create',
        resourceType: input.audit.resourceType,
        resourceId: id,
        tenantId,
        changes,
      },
      tx as never,
    );
  });
  return { status: 'created', retryAfterSeconds: 0 };
}

const BASE_COLUMNS = new Set([
  'id',
  'slug',
  'context',
  'created_at',
  'updated_at',
]);

/**
 * Column defaults a plain INSERT must supply for the model: the values an
 * ordinary save would write for a row the caller did not populate (`''` for
 * unset text, JSON defaults, `null` for unset foreign keys). Only persisted
 * schema columns are returned; nothing here comes from a request.
 */
export function guestRowDefaults(
  model: string,
): Record<string, string | number | boolean | null> {
  const registered = ObjectRegistry.getClass(model);
  if (!registered) {
    throw new ValidationError(
      `guest create: model "${model}" is not registered`,
      'GUEST_CREATE_UNREGISTERED_MODEL',
    );
  }
  const Ctor = registered.constructor as unknown as new (
    options?: unknown,
  ) => { toJSON(): Record<string, unknown> };
  const json = new Ctor({}).toJSON();
  const fields = getEffectiveFieldsSync(registered) as Map<
    string,
    {
      type?: string;
      transient?: boolean;
      _meta?: { transient?: boolean };
    }
  >;
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(json)) {
    const column = key.startsWith('_') ? key : snake(key);
    if (BASE_COLUMNS.has(column)) continue;
    const field = fields.get(key);
    if (!field) continue;
    if (
      field.transient ||
      field._meta?.transient ||
      field.type === 'oneToMany' ||
      field.type === 'manyToMany'
    ) {
      continue;
    }
    if (value === undefined) continue;
    if (field.type === 'foreignKey' && value === '') {
      out[column] = null;
    } else if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null
    ) {
      out[column] = value;
    } else if (value instanceof Date) {
      out[column] = value.toISOString();
    } else {
      out[column] = JSON.stringify(value);
    }
  }
  return out;
}
