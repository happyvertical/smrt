/**
 * Idempotency seam: run an action exactly once per submission (#3080).
 *
 * Every consumer with a form, a retried request, or a double-tapped button
 * needs the same guard: a claim row, insert-only against a UNIQUE column
 * (`claim_key`) in the SAME transaction as the work it guards, so a retry
 * either runs the work once or replays the first attempt's stored result.
 * This module is that primitive. It is DB/transaction-level — it takes a
 * `DatabaseInterface`, not a `SmrtObject`/`SmrtCollection` — so it works
 * outside SvelteKit and outside the ORM: any caller with a database handle
 * and a JSON-serializable work result can use it. The claim insert itself
 * is raw SQL (`## Concurrent submissions` below explains why), not the
 * ORM's `SmrtObject`-level `_insertOnly` option.
 *
 * ## Key derivation (not the token alone)
 *
 * The claim key is the sha256 hex digest of the sorted-key-JSON encoding of
 * `[tenantId, actor, token, contentDigest]`, where `contentDigest` is itself
 * the sha256 hex digest of the sorted-key-JSON encoding of `content`
 * ({@link digestRunOnceContent}). Sorted-key JSON ({@link stableStringify},
 * `./knowledge-graph.ts`) makes the digest stable regardless of property
 * insertion order.
 *
 * The token alone is NOT the key. A first attempt at this exact problem
 * (reported against #3080) keyed on the token alone and silently collapsed
 * two genuinely different submissions that happened to reuse one form's
 * token. Folding in the content digest means a retry of the SAME submission
 * (same token, same content) replays; a DIFFERENT submission through the
 * same token (edited content before a resubmit) runs as its own claim.
 * Folding in `tenantId` and `actor` means two tenants or two actors can never
 * collide on the same claim even if a token were somehow shared between them.
 *
 * Neither the raw token nor the raw content is ever persisted — only their
 * digests — so the claims table (`_smrt_run_once_claims`,
 * `./system/schema.ts`) cannot leak submitted business data.
 *
 * ## Atomicity
 *
 * `runOnce()` opens its own `db.transaction()` (or nests under the caller's,
 * per `@happyvertical/sql`'s own SAVEPOINT/`NestedTransactionError` rules —
 * see that package's `DatabaseInterface.transaction` doc) and, inside it:
 *
 * 1. Inserts the claim row (`status: 'in_progress'`).
 * 2. Runs `work(tx)`, passing the SAME transaction-bound handle, so the
 *    caller's writes and the claim insert commit or roll back together.
 * 3. Updates the claim row to `status: 'completed'` with the JSON-serialized
 *    result, still inside the same transaction.
 *
 * If `work()` throws, the callback throws, and `db.transaction()`'s own
 * "commits on success, rolls back on error" contract undoes the claim insert
 * along with whatever `work()` partially wrote — a claim is never stranded
 * `'in_progress'` by a failed attempt, and a retry with the same key can
 * always run again.
 *
 * ## Concurrent submissions
 *
 * The claim insert uses `INSERT ... ON CONFLICT (claim_key) DO NOTHING
 * RETURNING claim_key` (the same portable idiom `_smrt_migrations` already
 * uses in `system/bootstrap.ts`), not a plain `INSERT` caught for a
 * classified `unique_violation`. This matters on PostgreSQL specifically: a
 * statement that raises an error aborts the WHOLE transaction ("current
 * transaction is aborted, commands ignored until end of transaction block"),
 * so a plain `INSERT` failing on the claim key would make every subsequent
 * statement in the same transaction — including the very `SELECT` this
 * function needs to read the winner's stored result back — fail too.
 * `DO NOTHING` never raises: it returns zero rows instead, which this
 * function reads as "lost the race" without ever touching the transaction's
 * error state. SQLite and DuckDB both support the same `ON CONFLICT ... DO
 * NOTHING` / `RETURNING` syntax, so one query works on every adapter.
 *
 * `@happyvertical/sql`'s single-connection adapters (SQLite, DuckDB, JSON)
 * serialize `transaction()` calls on one connection: a second, concurrent
 * `runOnce()` call does not begin its own transaction until the first one
 * ends. PostgreSQL pools, but this `INSERT`'s arbiter still has to check the
 * unique index against another transaction's uncommitted row of the same
 * PRIMARY KEY, and blocks until that transaction resolves, then either
 * no-ops (committed — the row exists) or inserts (rolled back — no row).
 * Either way, two concurrent callers with the same key never both run
 * `work()`: exactly one does, and the loser's `INSERT` returns zero rows —
 * never an error — at which point it reads the now-committed claim row back
 * and replays its stored result.
 *
 * ## Typed answers for a claim that is not (yet) a definite result
 *
 * A `runOnce()` conflict is a *definite* decision — the row exists — but
 * whether it is safe to hand back a result depends on `status`. This mirrors
 * the "refused vs unknown outcome" distinction #2990 drew for AssistantDock
 * actions (`./errors.ts#RunOnceClaimError` carries the two codes):
 *
 * - `status: 'completed'` — replay the stored `result`. No error.
 * - `status` anything else (still `'in_progress'`) — some execution holds
 *   this key right now. `RunOnceClaimError.inFlight()`. Under this module's
 *   own transaction semantics this is normally unreachable through
 *   `runOnce()`-to-`runOnce()` races alone (the losing transaction can only
 *   ever observe a COMMITTED row, and this module only ever commits a row
 *   once it is `'completed'`) — it is reachable if a claim row was inserted
 *   outside this module's own completion discipline, and is kept as a
 *   defined answer rather than an assumption.
 * - the row cannot be read back at all after `DO NOTHING` reported zero
 *   rows inserted — `RunOnceClaimError.outcomeUnknown()`. Also normally
 *   unreachable (the zero-rows case only happens when a committed row
 *   already exists); kept for adapters/drivers where that and a subsequent
 *   read are not guaranteed to observe the same committed state.
 *
 * Both errors carry `claimKey` and are safe to retry with the SAME token and
 * content; `runOnce()` never retries them itself.
 *
 * @module
 */

import { createHash } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { RunOnceClaimError } from './errors.js';
import { stableStringify } from './knowledge-graph.js';
import { RUN_ONCE_CLAIMS_TABLE } from './system/schema.js';

export { RUN_ONCE_CLAIMS_TABLE };

/** Input identifying one submission for {@link runOnce}. */
export interface RunOnceParams {
  /** Transaction-capable database handle. May itself already be inside a transaction. */
  db: DatabaseInterface;
  /** Tenant scope. Part of the claim key: claims never cross tenants. */
  tenantId: string;
  /** The submitting principal. Part of the claim key: claims never cross actors. */
  actor: string;
  /** The per-form/per-submission token minted by the caller (e.g. a hidden form field). */
  token: string;
  /**
   * The content being written: plain JSON data, or a `FormData` (digested by
   * its ordered entries; see {@link digestRunOnceContent}). Only its
   * digest is persisted — never the raw value.
   */
  content: unknown;
}

interface RunOnceClaimRow {
  claim_key: string;
  status: string;
  result: string | null;
}

/** Key tagging a normalized `FormData` inside the FormData hash domain. */
const FORM_DATA_TAG = '\u0000FormData';

/**
 * Prefix of the hash input for content containing a `FormData`. Sorted-key
 * JSON always starts with a JSON token, never `\u0001`, so FormData digests
 * can never equal a plain-JSON digest, and plain-JSON digests stay exactly
 * what #3080 stored.
 */
const FORM_DATA_DOMAIN = '\u0001run-once-formdata-v1\n';

/** A captured `FormData`: its ordered entries, already normalized. */
class NormalizedFormData {
  constructor(readonly entries: Array<[string, unknown]>) {}
}

interface NormalizeState {
  sawFormData: boolean;
}

/** Marks a value JSON omits from an object (and writes as `null` in an array). */
const OMIT: unique symbol = Symbol('run-once-omit');

/**
 * Reduce `content` to plain JSON data before hashing, following JSON
 * serialization exactly — `toJSON(key)` is called with the property name or
 * array index (so a `Date` digests as its ISO string), and `undefined`,
 * function and symbol values are omitted from objects and written as `null` in
 * arrays — with two differences:
 *
 * - A native `FormData` has no own enumerable properties, so JSON reduces
 *   every form to `{}` and would collapse distinct submissions (#3136). It
 *   becomes its ordered entry list instead — repeated fields and their order
 *   are significant — and a `File`/`Blob` entry digests by name, type and
 *   size, never its bytes.
 * - Values JSON would silently misrepresent (`Map`, `Set`, `RegExp`, any other
 *   non-plain object without `toJSON()`) or cannot serialize (`bigint`) are
 *   rejected, not hashed as `{}`.
 */
function normalizeRunOnceContent(
  input: unknown,
  state: NormalizeState,
  key: string,
): unknown {
  let value = input;
  if (
    value !== null &&
    (typeof value === 'object' || typeof value === 'bigint') &&
    typeof (value as { toJSON?: unknown }).toJSON === 'function'
  ) {
    value = (value as { toJSON: (key: string) => unknown }).toJSON(key);
  }
  if (value === null) return null;
  switch (typeof value) {
    case 'undefined':
    case 'function':
    case 'symbol':
      return OMIT;
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'bigint':
      throw new TypeError(
        'runOnce content cannot contain a bigint; pass plain JSON data',
      );
  }
  if (typeof FormData !== 'undefined' && value instanceof FormData) {
    state.sawFormData = true;
    const entries: Array<[string, unknown]> = [];
    // `forEach`, not `entries()`: consumers type-check core's source against
    // DOM libs without `DOM.Iterable`, where FormData is not iterable.
    value.forEach((entry, name) => {
      entries.push([name, normalizeRunOnceContent(entry, state, name)]);
    });
    return new NormalizedFormData(entries);
  }
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    return {
      name: (value as Blob & { name?: string }).name ?? null,
      size: value.size,
      type: value.type,
    };
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      const normalized = normalizeRunOnceContent(item, state, String(index));
      return normalized === OMIT ? null : normalized;
    });
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    const name =
      (value as { constructor?: { name?: string } }).constructor?.name ||
      'non-plain object';
    throw new TypeError(
      `runOnce content cannot contain a ${name}; convert it to plain JSON data`,
    );
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const [member, memberValue] of Object.entries(value as object)) {
    const normalized = normalizeRunOnceContent(memberValue, state, member);
    if (normalized !== OMIT) result[member] = normalized;
  }
  return result;
}

/**
 * Map a normalized tree containing {@link NormalizedFormData} into the
 * FormData hash domain: each form becomes `{ [FORM_DATA_TAG]: entries }`, and
 * user keys starting with NUL are escaped (NUL doubled) so no plain object can
 * forge the tag. Works on the captured tree, so no getter or `toJSON()` on the
 * caller's content runs twice.
 */
function toFormDataDomain(value: unknown): unknown {
  if (value instanceof NormalizedFormData) {
    return {
      [FORM_DATA_TAG]: value.entries.map(([key, entry]) => [
        key,
        toFormDataDomain(entry),
      ]),
    };
  }
  if (Array.isArray(value)) return value.map(toFormDataDomain);
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, member] of Object.entries(value)) {
      result[key.startsWith('\u0000') ? `\u0000${key}` : key] =
        toFormDataDomain(member);
    }
    return result;
  }
  return value;
}

/**
 * Deterministic content digest: sha256 of sorted-key JSON.
 *
 * Property order never changes the digest, so callers do not need to worry
 * about object construction order producing two different claims for what is
 * semantically the same submission. Content is normalized exactly once (see
 * {@link normalizeRunOnceContent}): `toJSON()` values such as `Date` digest as
 * what they serialize to, a `FormData` digests as its ordered entries in a
 * separate hash domain, and values JSON would reduce to `{}` (`Map`, `Set`,
 * `RegExp`, …) are rejected.
 *
 * @throws {TypeError} when `content` contains a value with no faithful JSON form.
 */
export function digestRunOnceContent(content: unknown): string {
  const state: NormalizeState = { sawFormData: false };
  const captured = normalizeRunOnceContent(content, state, '');
  // JSON.stringify of a top-level omitted value is `undefined`; #3080 hashed it as null.
  const normalized = captured === OMIT ? null : captured;
  const input = state.sawFormData
    ? FORM_DATA_DOMAIN + stableStringify(toFormDataDomain(normalized))
    : stableStringify(normalized);
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Derive the {@link runOnce} claim key.
 *
 * NOT the token alone — see the module doc for why that collapses distinct
 * submissions. Folds in `tenantId`, `actor`, the raw `token`, and the
 * content digest, all through sorted-key JSON before hashing.
 */
export function deriveRunOnceClaimKey(params: {
  tenantId: string;
  actor: string;
  token: string;
  contentDigest: string;
}): string {
  const canonical = stableStringify([
    params.tenantId,
    params.actor,
    params.token,
    params.contentDigest,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Resolve an existing claim row into either a replayable result or a typed
 * error. Pulled out of {@link runOnce} as a pure function so both branches
 * (`completed` vs. anything else vs. unreadable) are directly unit-testable
 * without forcing a genuine database race.
 */
export function resolveExistingRunOnceClaim<T>(
  existing: RunOnceClaimRow | null,
  claimKey: string,
): T {
  if (!existing) {
    throw RunOnceClaimError.outcomeUnknown(claimKey);
  }
  if (existing.status !== 'completed') {
    throw RunOnceClaimError.inFlight(claimKey);
  }
  return JSON.parse(existing.result ?? 'null') as T;
}

/**
 * Run `work` exactly once per submission.
 *
 * ```ts
 * const purchaseOrderId = await runOnce(
 *   { db, tenantId, actor, token, content: formData },
 *   async (tx) => createPurchaseOrder(tx, formData),
 * );
 * ```
 *
 * Resolves to `work`'s return value on both a fresh run and a replay of a
 * prior completed run — the caller cannot tell the difference from the
 * return value alone (by design: both are "your submission is durably
 * applied"). Rejects with `RunOnceClaimError` (`./errors.ts`) when the claim
 * cannot be resolved to a definite result right now; see the module doc for
 * the `RUN_ONCE_IN_FLIGHT` / `RUN_ONCE_OUTCOME_UNKNOWN` distinction. Any
 * other rejection (including one from `work` itself) propagates unchanged,
 * and the claim is rolled back with the transaction so a retry can run again.
 */
export async function runOnce<T>(
  params: RunOnceParams,
  work: (tx: DatabaseInterface) => Promise<T>,
): Promise<T> {
  const { db, tenantId, actor, token, content } = params;
  if (!db.transaction) {
    throw new Error(
      'runOnce: the supplied database does not support transaction()',
    );
  }

  const contentDigest = digestRunOnceContent(content);
  const claimKey = deriveRunOnceClaimKey({
    tenantId,
    actor,
    token,
    contentDigest,
  });

  return db.transaction(async (tx) => {
    // `ON CONFLICT ... DO NOTHING` never raises — see the module doc for why
    // a plain INSERT-and-catch aborts the whole transaction on PostgreSQL,
    // taking the recovery SELECT below down with it. `RETURNING claim_key`
    // comes back with one row when this call won the claim, zero when it
    // lost it — that is the only signal this function needs.
    const won = await tx.single`
      INSERT INTO _smrt_run_once_claims
        (claim_key, tenant_id, actor, content_digest, status, result, created_at)
      VALUES
        (${claimKey}, ${tenantId}, ${actor}, ${contentDigest}, ${'in_progress'}, ${null}, ${new Date()})
      ON CONFLICT (claim_key) DO NOTHING
      RETURNING claim_key
    `;

    if (!won) {
      const existing = (await tx.get(RUN_ONCE_CLAIMS_TABLE, {
        claim_key: claimKey,
        tenant_id: tenantId,
      })) as RunOnceClaimRow | null;
      return resolveExistingRunOnceClaim<T>(existing, claimKey);
    }

    const result = await work(tx);
    await tx.update(
      RUN_ONCE_CLAIMS_TABLE,
      { claim_key: claimKey, tenant_id: tenantId },
      {
        status: 'completed',
        result: JSON.stringify(result ?? null),
        completed_at: new Date(),
      },
    );
    return result;
  });
}
