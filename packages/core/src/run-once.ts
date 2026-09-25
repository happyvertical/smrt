/**
 * Idempotency seam: run an action exactly once per submission (#3080).
 *
 * Every consumer with a form, a retried request, or a double-tapped button
 * needs the same guard: a claim row, inserted `_insertOnly` against a UNIQUE
 * column in the SAME transaction as the work it guards, so a retry either
 * runs the work once or replays the first attempt's stored result. This
 * module is that primitive. It is DB/transaction-level — it takes a
 * `DatabaseInterface`, not a `SmrtObject`/`SmrtCollection` — so it works
 * outside SvelteKit and outside the ORM: any caller with a database handle
 * and a JSON-serializable work result can use it.
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
 * `@happyvertical/sql`'s single-connection adapters (SQLite, DuckDB, JSON)
 * serialize `transaction()` calls on one connection: a second, concurrent
 * `runOnce()` call does not begin its own transaction until the first one
 * ends. PostgreSQL pools, but a plain `INSERT` colliding with another
 * transaction's uncommitted row of the same PRIMARY KEY blocks until that
 * transaction resolves, then either fails (committed — the row exists) or
 * succeeds (rolled back — no row). Either way, two concurrent callers with
 * the same key never both run `work()`: exactly one does, and the loser's
 * `INSERT` fails with a classified `unique_violation`
 * (`./db-errors.ts#isUniqueViolationError`), at which point it reads the now-
 * committed claim row back and replays its stored result.
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
 * - the row cannot be read back at all after a reported conflict —
 *   `RunOnceClaimError.outcomeUnknown()`. Also normally unreachable on a
 *   single connection; kept for adapters/drivers where a conflict and a
 *   subsequent read are not guaranteed to observe the same committed state.
 *
 * Both errors carry `claimKey` and are safe to retry with the SAME token and
 * content; `runOnce()` never retries them itself.
 *
 * @module
 */

import { createHash } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { isUniqueViolationError } from './db-errors.js';
import { RunOnceClaimError } from './errors.js';
import { stableStringify } from './knowledge-graph.js';

/** The insert-only claim table backing {@link runOnce}. See `./system/schema.ts`. */
export const RUN_ONCE_CLAIMS_TABLE = '_smrt_run_once_claims';

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
   * The content being written, in any JSON-serializable shape. Only its
   * digest is persisted — never the raw value.
   */
  content: unknown;
}

interface RunOnceClaimRow {
  claim_key: string;
  status: string;
  result: string | null;
}

/**
 * Deterministic content digest: sha256 of sorted-key JSON.
 *
 * Property order never changes the digest, so callers do not need to worry
 * about object construction order producing two different claims for what is
 * semantically the same submission.
 */
export function digestRunOnceContent(content: unknown): string {
  return createHash('sha256').update(stableStringify(content)).digest('hex');
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
    try {
      await tx.insert(RUN_ONCE_CLAIMS_TABLE, {
        claim_key: claimKey,
        tenant_id: tenantId,
        actor,
        content_digest: contentDigest,
        status: 'in_progress',
        result: null,
        created_at: new Date(),
      });
    } catch (error) {
      if (!isUniqueViolationError(error)) {
        throw error;
      }
      const existing = (await tx.get(RUN_ONCE_CLAIMS_TABLE, {
        claim_key: claimKey,
        tenant_id: tenantId,
      })) as RunOnceClaimRow | null;
      return resolveExistingRunOnceClaim<T>(existing, claimKey);
    }

    const result = await work(tx);
    await tx.update(
      RUN_ONCE_CLAIMS_TABLE,
      { claim_key: claimKey },
      {
        status: 'completed',
        result: JSON.stringify(result ?? null),
        completed_at: new Date(),
      },
    );
    return result;
  });
}
