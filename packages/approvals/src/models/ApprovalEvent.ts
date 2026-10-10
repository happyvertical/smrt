/**
 * ApprovalEvent: the append-only ledger of an approval request.
 *
 * Events are the source of truth for who did what: every transition inserts
 * exactly one event in the same transaction as its guarded UPDATE. The
 * generated surface is read-only, `save()` only ever inserts, and `delete()`
 * is refused. `(requestId, sequence)` is unique (one event per request
 * version) and `(requestId, voteKey)` is unique (one decision per actor).
 *
 * @packageDocumentation
 */

import {
  field,
  foreignKey,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  ApprovalError,
  type ApprovalEventType,
  type ApprovalPrincipalType,
} from '../types.js';
import { ApprovalRequest } from './ApprovalRequest.js';

/** Constructor options for {@link ApprovalEvent}. */
export interface ApprovalEventOptions extends SmrtObjectOptions {
  tenantId?: string;
  requestId?: string;
  type?: ApprovalEventType;
  actorId?: string;
  actorType?: ApprovalPrincipalType;
  reason?: string;
  subjectRevisionHash?: string;
  sequence?: number;
  voteKey?: string | null;
  occurredAt?: Date | null;
}

/** One immutable entry in an approval request's history. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'approval_events',
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: false,
  indexes: [
    {
      name: 'approval_events_request_sequence_key',
      columns: ['requestId', 'sequence'],
      unique: true,
    },
    {
      name: 'approval_events_request_vote_key',
      columns: ['requestId', 'voteKey'],
      unique: true,
    },
    {
      name: 'approval_events_tenant_occurred_idx',
      columns: ['tenantId', 'occurredAt'],
    },
  ],
})
export class ApprovalEvent extends SmrtObject {
  /** Owning tenant; always the request's tenant. */
  @tenantId()
  tenantId: string = '';

  /**
   * The request this event belongs to. DuckDB executes an UPDATE of an
   * indexed column on a referenced row as delete plus insert, so a physical
   * FK there would refuse every transition of a request that has events;
   * the constraint is physical on PostgreSQL and SQLite only. Requests are
   * never deleted, so no engine can orphan an event.
   */
  @foreignKey(ApprovalRequest, {
    required: true,
    readonly: true,
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
    constraint: { engines: ['postgres', 'sqlite'] },
  })
  requestId: string = '';

  /** What happened. */
  @field({ type: 'text', required: true, readonly: true })
  type: ApprovalEventType = 'created';

  /** Principal id of the actor. */
  @field({ type: 'text', required: true, readonly: true })
  actorId: string = '';

  /** Principal type of the actor. */
  @field({ type: 'text', readonly: true })
  actorType: ApprovalPrincipalType = 'human';

  /** Free-text reason (rejection note, cancellation reason, and so on). */
  @field({ type: 'text', readonly: true })
  reason: string = '';

  /** The subject revision the request was bound to when this happened. */
  @field({ type: 'text', readonly: true })
  subjectRevisionHash: string = '';

  /** The request `version` this event produced; unique per request. */
  @field({ type: 'integer', readonly: true })
  sequence: number = 0;

  /**
   * The deciding actor's id on decision events, `null` otherwise; unique per
   * request so one actor decides at most once.
   */
  @field({ type: 'text', nullable: true, readonly: true })
  voteKey: string | null = null;

  /** When the event happened. */
  @field({ type: 'datetime', readonly: true })
  occurredAt: Date | null = null;

  constructor(options: ApprovalEventOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.requestId !== undefined) this.requestId = options.requestId;
    if (options.type !== undefined) this.type = options.type;
    if (options.actorId !== undefined) this.actorId = options.actorId;
    if (options.actorType !== undefined) this.actorType = options.actorType;
    if (options.reason !== undefined) this.reason = options.reason;
    if (options.subjectRevisionHash !== undefined)
      this.subjectRevisionHash = options.subjectRevisionHash;
    if (options.sequence !== undefined) this.sequence = options.sequence;
    if (options.voteKey !== undefined) this.voteKey = options.voteKey;
    if (options.occurredAt !== undefined) this.occurredAt = options.occurredAt;
  }

  /**
   * Append the event. An event is written once and never updated.
   *
   * @throws {ApprovalError} `APPROVAL_FORBIDDEN` for a persisted event.
   */
  override async save(): Promise<this> {
    if (this.isPersisted) {
      throw new ApprovalError(
        'APPROVAL_FORBIDDEN',
        `ApprovalEvent ${this.id} is append-only and cannot be updated.`,
      );
    }
    if (!this.occurredAt) this.occurredAt = new Date();
    this.requireInsertOnSave();
    return await super.save();
  }

  /**
   * Events are append-only.
   *
   * @throws {ApprovalError} always.
   */
  override async delete(): Promise<void> {
    throw new ApprovalError(
      'APPROVAL_FORBIDDEN',
      `ApprovalEvent ${this.id} is append-only and cannot be deleted.`,
    );
  }
}
