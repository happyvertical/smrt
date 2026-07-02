/**
 * Idempotent sync-apply batch processing (#1759).
 *
 * The single shared write contract for the web offline outbox (#1762) and the
 * KMP mobile write queue (#1739): an ordered batch of client-authored
 * mutations carrying client-generated row UUIDs, applied FIFO through the
 * host's full stack (authentication, tenant isolation, interceptors, writable
 * policy), returning per-item results (`applied` / `conflict` / `rejected`).
 *
 * This module is transport-agnostic: the runtime REST generator
 * (`generators/rest.ts`) and the generated SvelteKit route
 * (`vite-plugin/sync-apply-route.ts`) both delegate here, supplying a
 * {@link SyncApplyHost} that adapts their own collection resolution,
 * authorization, and writable-policy machinery. Keeping the logic here keeps
 * the two generators byte-minimal and the contract single-sourced.
 *
 * Contract documentation: docs/content/architecture/sync-apply-contract.md
 *
 * ## Why replay is idempotent
 *
 * - Row identity is the client-generated UUID (validated server-side), and the
 *   ORM upserts on id (#1472), so re-creating an existing row converges on the
 *   same row instead of duplicating it.
 * - Before writing, each create/update is compared against the current row;
 *   when the row already reflects the item's payload the write is skipped and
 *   reported `applied` (a no-op re-apply). This is what makes N replays of an
 *   identical batch yield byte-identical database state (no `updated_at`
 *   churn) AND identical per-item results, without a server-side idempotency
 *   ledger.
 * - Deletes of rows that are already gone report `applied` consistently.
 *
 * ## Conflict policy v1 (server-authoritative LWW, updated-at guard)
 *
 * A write whose `baseUpdatedAt` is older than the server row's `updated_at`
 * is the LOSING write: it is **skipped** (the newer server state wins) and the
 * item is reported `conflict` with the server's current `updatedAt` so the
 * client can rebase. Skipping (rather than clobbering) was chosen because it
 * never destroys newer data, and it is replay-stable: a replayed conflicting
 * item reports `conflict` again against unchanged state. Field-level merge is
 * explicitly out of scope for v1.
 */

import { ValidationError } from '../errors.js';

/**
 * URL segments of the generated batch apply endpoint, relative to the API
 * base path: `POST {basePath}/sync/apply`. The `sync` segment is reserved —
 * a collection named `sync` cannot expose an item route named `apply`.
 */
export const SYNC_APPLY_ROUTE_SEGMENTS = ['sync', 'apply'] as const;

/** Maximum items accepted in one batch; larger batches are rejected (400). */
export const MAX_SYNC_APPLY_BATCH_SIZE = 1000;

/**
 * Client-generated row ids must be well-formed UUIDs. Same shape the ORM
 * accepts as an id filter in `SmrtCollection.get()`.
 */
export const SYNC_APPLY_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mutation kinds accepted by the batch apply endpoint. */
export type SyncApplyOp = 'create' | 'update' | 'delete';

const SYNC_APPLY_OPS: readonly SyncApplyOp[] = ['create', 'update', 'delete'];

/** Per-item outcome status. */
export type SyncApplyStatus = 'applied' | 'conflict' | 'rejected';

/** Machine-readable reasons for `rejected` items. */
export type SyncApplyRejectionReason =
  | 'invalid_item'
  | 'invalid_id'
  | 'invalid_payload'
  | 'unknown_object'
  | 'op_not_allowed'
  | 'auth_required'
  | 'forbidden'
  | 'not_found'
  | 'id_conflict'
  | 'write_failed';

/** Machine-readable reasons for `conflict` items. */
export type SyncApplyConflictReason = 'stale_write' | 'create_conflict';

export type SyncApplyReason =
  | SyncApplyRejectionReason
  | SyncApplyConflictReason;

/**
 * One client-authored mutation in a batch. See the contract doc for field
 * semantics; briefly:
 *
 * - `itemId` — the client's idempotency/correlation handle (the durable queue
 *   row id). Echoed back verbatim; results are also positional.
 * - `object` — the collection route segment the model's CRUD routes use
 *   (e.g. `products`).
 * - `id` — the client-generated row UUID. This is the ONLY channel for a
 *   client-supplied id; payload `id` fields are stripped by the writable
 *   policy exactly as on plain CRUD routes (#1540).
 * - `baseUpdatedAt` — the server `updated_at` the client last saw for this
 *   row; drives the conflict guard on update/delete. Omit to opt out.
 */
export interface SyncApplyItem {
  itemId: string;
  object: string;
  op: SyncApplyOp;
  id: string;
  payload?: Record<string, unknown>;
  baseUpdatedAt?: string;
}

/** Request body of `POST …/sync/apply`. */
export interface SyncApplyBatchRequest {
  items: SyncApplyItem[];
}

/**
 * Per-item result. `results[i]` always corresponds to `items[i]` (positional);
 * `itemId` is echoed for convenience (`null` when the incoming item was too
 * malformed to carry one). `updatedAt` is the server row's `updated_at` after
 * processing — present on applied creates/updates and on conflicts (so clients
 * can rebase), absent on deletes and rejections.
 */
export interface SyncApplyItemResult {
  itemId: string | null;
  id: string | null;
  status: SyncApplyStatus;
  reason?: SyncApplyReason;
  updatedAt?: string;
}

/** Response body of `POST …/sync/apply` (HTTP 200). */
export interface SyncApplyBatchResponse {
  results: SyncApplyItemResult[];
}

/** Batch-level error body (HTTP 400). */
export interface SyncApplyBatchError {
  error: {
    code: 'invalid_batch' | 'batch_too_large';
    message: string;
  };
}

/** Outcome of {@link processSyncApplyBatch}: HTTP status + JSON body. */
export type SyncApplyOutcome =
  | { status: 200; body: SyncApplyBatchResponse }
  | { status: 400; body: SyncApplyBatchError };

/**
 * Minimal structural view of a persisted row as the processor needs it.
 * Matches `SmrtObject` structurally; kept structural so hosts and tests can
 * exercise the processor without importing ORM classes.
 */
export interface SyncApplyRowLike {
  id?: string | null;
  updated_at?: Date | string | null;
  save(): Promise<unknown>;
  delete(): Promise<unknown>;
}

/** Minimal structural view of a collection (matches `SmrtCollection`). */
export interface SyncApplyCollectionLike {
  get(id: string): Promise<SyncApplyRowLike | null>;
  create(options: Record<string, unknown>): Promise<SyncApplyRowLike>;
}

/** Per-item authorization decision from the host. */
export type SyncApplyAuthzDecision = 'ok' | 'auth_required' | 'forbidden';

/**
 * A resolved mutation target: everything the processor needs to apply one
 * item through the host's full stack. Hosts build these from their existing
 * machinery so sync items follow the exact same authorization, action-gating,
 * and mass-assignment rules as the host's plain CRUD routes.
 */
export interface SyncApplyTarget {
  /** Registry/class name, for diagnostics. */
  objectName: string;
  /** Collection whose get/create/save/delete run the full interceptor stack. */
  collection: SyncApplyCollectionLike;
  /** Whether the object's API config exposes this op (mirrors CRUD gating). */
  isOpAllowed(op: SyncApplyOp): boolean;
  /** Per-item authorization (mutating semantics, fail-closed). */
  authorize(
    op: SyncApplyOp,
  ): Promise<SyncApplyAuthzDecision> | SyncApplyAuthzDecision;
  /**
   * Mass-assignment guard (#1540): strip server-managed/readonly/disallowed
   * fields from the item payload. The row UUID is injected from the validated
   * envelope `id` AFTER this runs — never from the body.
   */
  prepare(payload: Record<string, unknown>): Record<string, unknown>;
}

/** Host adapter handed to {@link processSyncApplyBatch}. */
export interface SyncApplyHost {
  /**
   * Resolve an item's `object` segment to a target, or `null` when unknown.
   * Called once per item so per-item auth context stays accurate.
   */
  resolveTarget(
    objectSegment: string,
  ): Promise<SyncApplyTarget | null> | SyncApplyTarget | null;
}

/**
 * Writable-policy helper shared with the generated SvelteKit sync route: the
 * same stripping rules as the generated CRUD handlers (#1540) — server-managed
 * fields, `_`-prefixed keys, `@field({ readonly: true })` fields, and (when
 * configured) intersection with the `api.writable` allowlist.
 */
export function applySyncWritablePolicy(
  data: unknown,
  policy: {
    readonlyFields?: readonly string[];
    writableAllowlist?: readonly string[] | null;
  } = {},
): Record<string, unknown> {
  if (!data || typeof data !== 'object') {
    return {};
  }

  const serverManaged = new Set([
    'id',
    'tenantId',
    'tenant_id',
    'createdAt',
    'created_at',
    'updatedAt',
    'updated_at',
  ]);
  const readonly = new Set(policy.readonlyFields ?? []);
  const writable = policy.writableAllowlist ?? null;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith('_')) continue;
    if (serverManaged.has(key)) continue;
    if (readonly.has(key)) continue;
    if (writable && !writable.includes(key)) continue;
    result[key] = value;
  }
  return result;
}

/**
 * Batch-level validation. Returns the raw items array or a 400-shaped error.
 */
export function parseSyncApplyBatch(
  body: unknown,
): { items: unknown[] } | SyncApplyBatchError {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    !Array.isArray((body as { items?: unknown }).items)
  ) {
    return {
      error: {
        code: 'invalid_batch',
        message: 'Request body must be an object with an "items" array',
      },
    };
  }

  const items = (body as { items: unknown[] }).items;
  if (items.length > MAX_SYNC_APPLY_BATCH_SIZE) {
    return {
      error: {
        code: 'batch_too_large',
        message: `Batch exceeds the maximum of ${MAX_SYNC_APPLY_BATCH_SIZE} items`,
      },
    };
  }

  return { items };
}

interface ValidatedItem {
  ok: true;
  item: SyncApplyItem;
}

interface InvalidItem {
  ok: false;
  result: SyncApplyItemResult;
}

/**
 * Per-item shape validation. Never throws; malformed items become `rejected`
 * results so one bad item cannot fail the batch.
 */
export function validateSyncApplyItem(raw: unknown): ValidatedItem | InvalidItem {
  const record =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;

  const itemId =
    record && typeof record.itemId === 'string' && record.itemId.length > 0
      ? record.itemId
      : null;
  const id = record && typeof record.id === 'string' ? record.id : null;

  const reject = (reason: SyncApplyRejectionReason): InvalidItem => ({
    ok: false,
    result: { itemId, id, status: 'rejected', reason },
  });

  if (!record || !itemId) {
    return reject('invalid_item');
  }

  const op = record.op;
  if (typeof op !== 'string' || !SYNC_APPLY_OPS.includes(op as SyncApplyOp)) {
    return reject('invalid_item');
  }

  const object = record.object;
  if (typeof object !== 'string' || object.length === 0) {
    return reject('invalid_item');
  }

  const baseUpdatedAt = record.baseUpdatedAt;
  if (baseUpdatedAt !== undefined) {
    if (
      typeof baseUpdatedAt !== 'string' ||
      Number.isNaN(Date.parse(baseUpdatedAt))
    ) {
      return reject('invalid_item');
    }
  }

  // Client UUID validation: the row id must be a well-formed UUID.
  if (!id || !SYNC_APPLY_UUID_PATTERN.test(id)) {
    return reject('invalid_id');
  }

  const payload = record.payload;
  if (op === 'create' || op === 'update') {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return reject('invalid_payload');
    }
  }

  return {
    ok: true,
    item: {
      itemId,
      object,
      op: op as SyncApplyOp,
      id,
      payload: payload as Record<string, unknown> | undefined,
      baseUpdatedAt: baseUpdatedAt as string | undefined,
    },
  };
}

function toEpochMillis(value: Date | string | null | undefined): number | null {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? null : time;
  }
  if (typeof value === 'string') {
    const time = Date.parse(value);
    return Number.isNaN(time) ? null : time;
  }
  return null;
}

/**
 * Updated-at conflict guard: true when the client's base is strictly older
 * than the server row's `updated_at`. No base (client opted out) or no
 * comparable server timestamp → not stale.
 */
export function isStaleWrite(
  baseUpdatedAt: string | undefined,
  serverUpdatedAt: Date | string | null | undefined,
): boolean {
  const base = toEpochMillis(baseUpdatedAt ?? null);
  if (base === null) return false;
  const server = toEpochMillis(serverUpdatedAt);
  if (server === null) return false;
  return base < server;
}

function normalizeForComparison(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value;
}

function valuesEquivalent(rowValue: unknown, payloadValue: unknown): boolean {
  // Datetime fields hydrate as Date; clients send ISO strings (or epoch ms).
  if (rowValue instanceof Date) {
    const candidate =
      typeof payloadValue === 'string' || typeof payloadValue === 'number'
        ? new Date(payloadValue).getTime()
        : payloadValue instanceof Date
          ? payloadValue.getTime()
          : Number.NaN;
    return !Number.isNaN(candidate) && candidate === rowValue.getTime();
  }

  if (rowValue === null || rowValue === undefined) {
    return payloadValue === null || payloadValue === undefined;
  }

  if (typeof rowValue !== 'object' && typeof payloadValue !== 'object') {
    return rowValue === payloadValue;
  }

  try {
    return (
      JSON.stringify(normalizeForComparison(rowValue)) ===
      JSON.stringify(normalizeForComparison(payloadValue))
    );
  } catch {
    return false;
  }
}

/**
 * No-op detection: true when the row already reflects every (policy-stripped)
 * payload field. Payload keys that are not properties of the hydrated row are
 * ignored — they would never persist, so they must not defeat idempotent
 * replay. This check is what keeps replayed batches from churning
 * `updated_at` (and keeps their per-item results identical).
 */
export function payloadMatchesRow(
  payload: Record<string, unknown>,
  row: SyncApplyRowLike,
): boolean {
  const record = row as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(payload)) {
    if (!(key in record)) continue;
    if (!valuesEquivalent(record[key], value)) return false;
  }
  return true;
}

function rowUpdatedAtIso(row: SyncApplyRowLike): string | undefined {
  const value = row.updated_at;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const epoch = Date.parse(value);
    return Number.isNaN(epoch) ? value : new Date(epoch).toISOString();
  }
  return undefined;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof ValidationError &&
    error.code === 'VALIDATION_UNIQUE_CONSTRAINT'
  );
}

async function applyValidatedItem(
  item: SyncApplyItem,
  target: SyncApplyTarget,
): Promise<SyncApplyItemResult> {
  const base = { itemId: item.itemId, id: item.id } as const;

  // Authorization first (mirrors CRUD: the auth middleware runs before the
  // per-action 405 gate), then action gating.
  const decision = await target.authorize(item.op);
  if (decision !== 'ok') {
    return { ...base, status: 'rejected', reason: decision };
  }

  if (!target.isOpAllowed(item.op)) {
    return { ...base, status: 'rejected', reason: 'op_not_allowed' };
  }

  // Payload passes through the host's writable policy; the row UUID comes
  // from the validated envelope `id`, never from the body — the #1540
  // mass-assignment guard stays intact on this path too.
  const data =
    item.op === 'delete' ? {} : target.prepare(item.payload ?? {});

  // Tenant isolation: collection.get runs the interceptor stack, so rows
  // outside the caller's tenant are simply not visible here.
  const row = await target.collection.get(item.id);

  switch (item.op) {
    case 'create': {
      if (row) {
        if (payloadMatchesRow(data, row)) {
          // Idempotent replay of an already-applied create.
          return { ...base, status: 'applied', updatedAt: rowUpdatedAtIso(row) };
        }
        // The id exists with different content — the server state wins (LWW
        // skip) and the client is told to rebase.
        return {
          ...base,
          status: 'conflict',
          reason: 'create_conflict',
          updatedAt: rowUpdatedAtIso(row),
        };
      }

      try {
        const created = await target.collection.create({
          ...data,
          id: item.id,
        });
        return {
          ...base,
          status: 'applied',
          updatedAt: rowUpdatedAtIso(created),
        };
      } catch (error) {
        // A unique-constraint failure here means the id (or natural key)
        // belongs to a row this caller cannot see (e.g. another tenant's) or
        // a concurrent writer won the race. Never clobber it.
        if (isUniqueConstraintError(error)) {
          return { ...base, status: 'rejected', reason: 'id_conflict' };
        }
        throw error;
      }
    }

    case 'update': {
      if (!row) {
        return { ...base, status: 'rejected', reason: 'not_found' };
      }
      if (payloadMatchesRow(data, row)) {
        // Idempotent replay of an already-applied update (checked before the
        // stale guard: our own earlier apply advanced `updated_at`).
        return { ...base, status: 'applied', updatedAt: rowUpdatedAtIso(row) };
      }
      if (isStaleWrite(item.baseUpdatedAt, row.updated_at)) {
        return {
          ...base,
          status: 'conflict',
          reason: 'stale_write',
          updatedAt: rowUpdatedAtIso(row),
        };
      }
      Object.assign(row, data);
      await row.save();
      return { ...base, status: 'applied', updatedAt: rowUpdatedAtIso(row) };
    }

    case 'delete': {
      if (!row) {
        // Idempotent delete: already gone (or never visible) — reported
        // consistently on every replay.
        return { ...base, status: 'applied' };
      }
      if (isStaleWrite(item.baseUpdatedAt, row.updated_at)) {
        return {
          ...base,
          status: 'conflict',
          reason: 'stale_write',
          updatedAt: rowUpdatedAtIso(row),
        };
      }
      await row.delete();
      return { ...base, status: 'applied' };
    }
  }
}

async function processOneItem(
  raw: unknown,
  host: SyncApplyHost,
): Promise<SyncApplyItemResult> {
  const validated = validateSyncApplyItem(raw);
  if (!validated.ok) {
    return validated.result;
  }

  const item = validated.item;
  try {
    const target = await host.resolveTarget(item.object);
    if (!target) {
      return {
        itemId: item.itemId,
        id: item.id,
        status: 'rejected',
        reason: 'unknown_object',
      };
    }
    return await applyValidatedItem(item, target);
  } catch {
    // One item's failure must never fail the batch.
    return {
      itemId: item.itemId,
      id: item.id,
      status: 'rejected',
      reason: 'write_failed',
    };
  }
}

/**
 * Process a sync-apply batch: validate the envelope, then apply items FIFO
 * (strictly in order, awaiting each — items may depend on earlier items in
 * the same batch). Always resolves; item-level failures surface as `rejected`
 * results and only envelope-level problems produce a 400.
 */
export async function processSyncApplyBatch(
  body: unknown,
  host: SyncApplyHost,
): Promise<SyncApplyOutcome> {
  const parsed = parseSyncApplyBatch(body);
  if ('error' in parsed) {
    return { status: 400, body: parsed };
  }

  const results: SyncApplyItemResult[] = [];
  for (const raw of parsed.items) {
    // Sequential on purpose: FIFO within the batch is part of the contract.
    results.push(await processOneItem(raw, host));
  }

  return { status: 200, body: { results } };
}
