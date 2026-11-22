/**
 * Durable ledger for dispatch-delivered agent invocations.
 *
 * A worker reached through the DispatchBus `agent.invoke.*` signal does paid
 * work (provider calls). A dispatch row can be delivered more than once: an
 * operator `retry()`, a lease reclaim after a crash, or two processors that
 * both obtained the same row. The ledger guarantees that one dispatch row
 * starts paid work at most once:
 *
 * - one ledger row per dispatch row, keyed by a unique index on `dispatch_id`
 *   alone (the dispatch id is globally unique, so no tenant is in the key);
 * - the reservation is committed on the base database handle before the
 *   worker's principal context (which may open an RLS transaction) starts;
 * - a result is recorded before its completion is published, and the
 *   publication is marked afterwards, so a redelivery republishes a recorded
 *   result instead of rerunning the worker;
 * - a reservation with no recorded result is never rerun: a redelivery marks it
 *   `uncertain` and publishes an `AGENT_INVOCATION_UNCERTAIN` completion, and
 *   an operator reconciles from the ledger.
 *
 * Schema comes from the normal `smrt db:migrate` path; at runtime only the
 * table's existence is checked, and a missing table fails closed with
 * {@link AgentInvocationLedgerMissingError}.
 *
 * @module
 */

import { randomUUID } from 'node:crypto';
import {
  field,
  type SmrtClassOptions,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';

/** Table that holds one ledger row per dispatch-delivered invocation. */
export const AGENT_INVOCATION_TABLE = '_smrt_agent_invocations';

/** Error code thrown when the invocation ledger table has not been migrated. */
export const AGENT_INVOCATION_LEDGER_MISSING =
  'AGENT_INVOCATION_LEDGER_MISSING';

/**
 * Completion error published when a redelivered invocation had been reserved
 * but never recorded a result: the worker may or may not have done its paid
 * work, so it is not rerun.
 */
export const AGENT_INVOCATION_UNCERTAIN = 'AGENT_INVOCATION_UNCERTAIN';

/**
 * Ledger state of one invocation.
 *
 * - `reserved`: the reservation committed; the worker may be running or may
 *   have stopped without recording a result.
 * - `result_recorded`: the worker's completion is stored; publication pending.
 * - `published`: the completion dispatch was emitted.
 * - `uncertain`: a redelivery found a reservation with no result; the worker is
 *   not rerun and an operator reconciles from the ledger.
 */
export type AgentInvocationState =
  | 'reserved'
  | 'result_recorded'
  | 'published'
  | 'uncertain';

/**
 * One dispatch-delivered agent invocation. Internal bookkeeping: never served
 * over REST, CLI or MCP. Written only through raw statements in this module so
 * every transition is a single conditional statement.
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: '_smrt_agent_invocations',
  api: false,
  cli: false,
  mcp: false,
})
export class AgentInvocation extends SmrtObject {
  /** Tenant from the delegation envelope (access control only, not the key). */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** The `_smrt_dispatch.id` this invocation was delivered by. */
  @field({
    type: 'text',
    required: true,
    unique: true,
    requiredFor: 'idempotency',
  })
  dispatchId: string = '';

  /** Correlation id of the delegation envelope. */
  @field({ type: 'text', nullable: true })
  correlationId: string | null = null;

  /** Worker agent class the invocation targeted. */
  @field({ type: 'text' })
  agentClass: string = '';

  /** Ledger state; see {@link AgentInvocationState}. */
  @field({ type: 'text' })
  state: AgentInvocationState = 'reserved';

  /**
   * The recorded completion as JSON text. Sensitive: a worker's result may
   * carry anything the worker produced.
   */
  @field({ type: 'text', nullable: true, sensitive: true })
  resultJson: string | null = null;

  /** How many deliveries of the dispatch row reached the ledger. */
  @field({ type: 'integer' })
  attemptsSeen: number = 0;
}

/** Collection for {@link AgentInvocation}; used for the storage check. */
export class AgentInvocationCollection extends SmrtCollection<AgentInvocation> {
  static readonly _itemClass = AgentInvocation;
}

/**
 * Thrown when `_smrt_agent_invocations` does not exist (or no database was
 * supplied), so paid work never runs without the dedupe ledger.
 */
export class AgentInvocationLedgerMissingError extends Error {
  readonly code = AGENT_INVOCATION_LEDGER_MISSING;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AgentInvocationLedgerMissingError';
  }
}

/** A ledger row as read back from the database. */
export interface AgentInvocationRecord {
  id: string;
  dispatchId: string;
  state: AgentInvocationState;
  resultJson: string | null;
}

/** Identity of a new reservation. */
export interface AgentInvocationReservation {
  dispatchId: string;
  tenantId: string | null;
  correlationId: string | null;
  agentClass: string;
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  }
  return [];
}

const STATES: ReadonlySet<string> = new Set([
  'reserved',
  'result_recorded',
  'published',
  'uncertain',
]);

function toRecord(row: Record<string, unknown>): AgentInvocationRecord {
  const state = String(row.state);
  if (!STATES.has(state)) {
    throw new Error(
      `Agent invocation ledger row ${String(row.id)} has unknown state '${state}'`,
    );
  }
  let resultJson: string | null = null;
  if (typeof row.result_json === 'string') {
    resultJson = row.result_json;
  } else if (row.result_json != null) {
    resultJson = JSON.stringify(row.result_json);
  }
  return {
    id: String(row.id),
    dispatchId: String(row.dispatch_id),
    state: state as AgentInvocationState,
    resultJson,
  };
}

/**
 * Statement-level access to the invocation ledger on one base database handle.
 * Every transition is one conditional statement whose `RETURNING` row decides
 * the outcome, so concurrent deliveries cannot both win a transition.
 */
export class AgentInvocationLedger {
  private constructor(private readonly db: DatabaseInterface) {}

  /**
   * Open the ledger on the base handle of `db`, failing closed when the table
   * has not been migrated or no database was given.
   */
  static async open(
    db: SmrtClassOptions['db'] | undefined,
  ): Promise<AgentInvocationLedger> {
    if (!db) {
      throw new AgentInvocationLedgerMissingError(
        'processAgentInvocations requires `db`: dispatch-delivered invocations ' +
          `are deduplicated through ${AGENT_INVOCATION_TABLE}.`,
      );
    }
    const collection = await AgentInvocationCollection.create({ db });
    try {
      await collection.ensureStorageReady();
    } catch (error) {
      if ((error as { code?: unknown })?.code === 'DB_SCHEMA_MISSING') {
        throw new AgentInvocationLedgerMissingError(
          `Table '${AGENT_INVOCATION_TABLE}' does not exist. Run 'smrt db:migrate' ` +
            'before processing agent invocations.',
          { cause: error },
        );
      }
      throw error;
    }
    return new AgentInvocationLedger(collection.db as DatabaseInterface);
  }

  /**
   * Reserve the invocation for `dispatchId`. Returns the new ledger row id
   * when this call created the reservation (the caller owns it and may start
   * paid work), or `null` when a ledger row already existed.
   */
  async reserve(
    reservation: AgentInvocationReservation,
  ): Promise<string | null> {
    const now = new Date().toISOString();
    const id = randomUUID();
    const result = await this.db.query(
      `INSERT INTO ${AGENT_INVOCATION_TABLE}
         (id, slug, context, created_at, updated_at, tenant_id, dispatch_id,
          correlation_id, agent_class, state, result_json, attempts_seen)
       VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, 'reserved', NULL, 1)
       ON CONFLICT (dispatch_id) DO NOTHING
       RETURNING id`,
      id,
      `agent-invocation-${id}`,
      now,
      now,
      reservation.tenantId,
      reservation.dispatchId,
      reservation.correlationId,
      reservation.agentClass,
    );
    return rowsOf(result).length === 1 ? id : null;
  }

  /** Count a redelivery and return the current ledger row. */
  async observeRedelivery(
    dispatchId: string,
  ): Promise<AgentInvocationRecord | null> {
    const result = await this.db.query(
      `UPDATE ${AGENT_INVOCATION_TABLE}
          SET attempts_seen = COALESCE(attempts_seen, 0) + 1, updated_at = ?
        WHERE dispatch_id = ?
        RETURNING id, dispatch_id, state, result_json`,
      new Date().toISOString(),
      dispatchId,
    );
    const row = rowsOf(result)[0];
    return row ? toRecord(row) : null;
  }

  /**
   * Record the owner's completion. Only the reservation owner (by ledger row
   * id) records, and only from `reserved` or `uncertain`.
   */
  async recordResult(id: string, resultJson: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE ${AGENT_INVOCATION_TABLE}
          SET state = 'result_recorded', result_json = ?, updated_at = ?
        WHERE id = ? AND state IN ('reserved', 'uncertain')
        RETURNING id`,
      resultJson,
      new Date().toISOString(),
      id,
    );
    return rowsOf(result).length === 1;
  }

  /** Mark a recorded result as published. */
  async markPublished(dispatchId: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE ${AGENT_INVOCATION_TABLE}
          SET state = 'published', updated_at = ?
        WHERE dispatch_id = ? AND state = 'result_recorded'
        RETURNING id`,
      new Date().toISOString(),
      dispatchId,
    );
    return rowsOf(result).length === 1;
  }

  /** Move a reservation that has no result to `uncertain`. */
  async markUncertain(dispatchId: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE ${AGENT_INVOCATION_TABLE}
          SET state = 'uncertain', updated_at = ?
        WHERE dispatch_id = ? AND state = 'reserved'
        RETURNING id`,
      new Date().toISOString(),
      dispatchId,
    );
    return rowsOf(result).length === 1;
  }

  /** Read the ledger row for `dispatchId`. */
  async get(dispatchId: string): Promise<AgentInvocationRecord | null> {
    const result = await this.db.query(
      `SELECT id, dispatch_id, state, result_json
         FROM ${AGENT_INVOCATION_TABLE} WHERE dispatch_id = ? LIMIT 1`,
      dispatchId,
    );
    const row = rowsOf(result)[0];
    return row ? toRecord(row) : null;
  }
}
