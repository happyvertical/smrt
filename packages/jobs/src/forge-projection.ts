// Self-register this package's manifest for consumers importing this module
// directly. See __smrt-register__.ts (issue #1132).
import './__smrt-register__.js';

import { randomUUID } from 'node:crypto';
import {
  detectEngine,
  field,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import {
  requireTenant,
  TenantScoped,
  tenantId,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { redactErrorForPersistence } from './error-redaction.js';

const MAX_OBSERVATION_VERSION = 2_147_483_647;

type DatabaseWithConfig = DatabaseInterface & {
  config?: {
    type?: string;
    url?: string;
  };
  type?: string;
};

export type ForgeDeliveryStatus =
  | 'pending'
  | 'leased'
  | 'retry'
  | 'completed'
  | 'dead_letter';

/**
 * A provider-neutral observation emitted by a forge delivery adapter.
 *
 * `version` is a monotonically increasing provider/domain revision for one
 * `(projection, subjectKey)` pair. Projectors never infer issue semantics from
 * pull requests; applications choose both the projection and subject identity.
 */
export interface ForgeObservation<T = unknown> {
  projection: string;
  subjectKey: string;
  version: number;
  value: T;
}

export interface ForgeProjectionContext {
  /** Transaction-scoped database. Projection writes must use this handle. */
  db: DatabaseInterface;
  tenantId: string;
  deliveryId: string;
}

export interface ForgeProjector<T = unknown> {
  /**
   * Normalize a provider delivery into a tracker-independent observation.
   * Return null when the delivery is intentionally ignored.
   */
  observe(delivery: ForgeDelivery): Promise<ForgeObservation<T> | null>;
  /**
   * Apply the observation. The callback and checkpoint/delivery updates share
   * one database transaction.
   */
  project(
    observation: ForgeObservation<T>,
    context: ForgeProjectionContext,
  ): Promise<void>;
}

export type ForgeProjectionAuditEvent =
  | {
      type: 'delivery.accepted' | 'delivery.duplicate';
      tenantId: string;
      deliveryId: string;
      provider: string;
    }
  | {
      type:
        | 'delivery.leased'
        | 'delivery.completed'
        | 'delivery.retry_scheduled'
        | 'delivery.dead_lettered'
        | 'delivery.replayed'
        | 'observation.stale';
      tenantId: string;
      deliveryId: string;
      attempt: number;
    };

export type ForgeProjectionAuditHook = (
  event: ForgeProjectionAuditEvent,
) => void | Promise<void>;

@smrt({
  tableName: '_smrt_forge_deliveries',
  conflictColumns: ['tenant_id', 'provider', 'delivery_id'],
  api: false,
  cli: false,
  mcp: false,
})
@TenantScoped({ mode: 'required' })
export class ForgeDelivery extends SmrtObject {
  @tenantId()
  tenantId: string = '';

  @field({ type: 'text', required: true })
  provider: string = '';

  @field({ type: 'text', required: true })
  deliveryId: string = '';

  @field({ type: 'text', nullable: true })
  installationKey: string | null = null;

  @field({ type: 'text', nullable: true })
  repositoryKey: string | null = null;

  @field({ type: 'text', required: true })
  eventName: string = '';

  @field({ type: 'json' })
  payload: Record<string, unknown> = {};

  @field({ type: 'text', required: true, default: 'pending' })
  status: ForgeDeliveryStatus = 'pending';

  @field({ type: 'integer', required: true, default: 0 })
  attempts: number = 0;

  @field({ type: 'integer', required: true, default: 5 })
  maxAttempts: number = 5;

  @field({ type: 'datetime', required: true })
  receivedAt: Date = new Date();

  @field({ type: 'datetime', required: true })
  nextAttemptAt: Date = new Date();

  @field({ type: 'text', nullable: true })
  leaseOwner: string | null = null;

  @field({ type: 'text', nullable: true })
  leaseToken: string | null = null;

  @field({ type: 'datetime', nullable: true })
  leaseExpiresAt: Date | null = null;

  @field({ type: 'text', nullable: true })
  lastError: string | null = null;

  @field({ type: 'datetime', nullable: true })
  completedAt: Date | null = null;

  @field({ type: 'integer', required: true, default: 0 })
  replayCount: number = 0;
}

@smrt({
  tableName: '_smrt_forge_projection_checkpoints',
  conflictColumns: ['tenant_id', 'projection', 'subject_key'],
  api: false,
  cli: false,
  mcp: false,
})
@TenantScoped({ mode: 'required' })
export class ForgeProjectionCheckpoint extends SmrtObject {
  @tenantId()
  tenantId: string = '';

  @field({ type: 'text', required: true })
  projection: string = '';

  @field({ type: 'text', required: true })
  subjectKey: string = '';

  // The current portable field contract persists this as a signed 32-bit
  // integer. `assertObservation()` enforces the matching public range.
  @field({ type: 'integer', required: true })
  observationVersion: number = 0;

  @field({ type: 'text', required: true })
  deliveryId: string = '';

  @field({ type: 'datetime', required: true })
  observedAt: Date = new Date();
}

export interface AcceptForgeDeliveryInput {
  provider: string;
  deliveryId: string;
  installationKey?: string | null;
  repositoryKey?: string | null;
  eventName: string;
  payload: Record<string, unknown>;
  maxAttempts?: number;
  receivedAt?: Date;
}

export interface AcceptedForgeDelivery {
  delivery: ForgeDelivery;
  accepted: boolean;
}

export interface ClaimForgeDeliveryOptions {
  workerId: string;
  leaseMs: number;
  now?: Date;
}

/**
 * Durable provider delivery inbox.
 *
 * All tenant-facing operations require ambient tenant context. `claimReady`
 * is the sole cross-tenant worker scan and returns the captured tenant so the
 * runtime can restore it before normalization or projection.
 */
export class ForgeDeliveryCollection extends SmrtCollection<ForgeDelivery> {
  static readonly _itemClass = ForgeDelivery;

  async accept(
    input: AcceptForgeDeliveryInput,
    audit?: ForgeProjectionAuditHook,
  ): Promise<AcceptedForgeDelivery> {
    const tenant = requireTenant().tenantId;
    assertNonEmpty('provider', input.provider);
    assertNonEmpty('deliveryId', input.deliveryId);
    assertNonEmpty('eventName', input.eventName);

    const now = input.receivedAt ?? new Date();
    const id = randomUUID();
    const inserted = await this.db.query(
      `INSERT INTO _smrt_forge_deliveries (
         id, slug, context, tenant_id, provider, delivery_id, installation_key,
         repository_key, event_name, payload, status, attempts, max_attempts,
         received_at, next_attempt_at, replay_count, created_at, updated_at
       ) VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, 0, ?, ?)
       ON CONFLICT (tenant_id, provider, delivery_id) DO NOTHING
       RETURNING id`,
      id,
      `${input.provider}-${input.deliveryId}`.slice(0, 255),
      tenant,
      input.provider,
      input.deliveryId,
      input.installationKey ?? null,
      input.repositoryKey ?? null,
      input.eventName,
      JSON.stringify(input.payload),
      clampMaxAttempts(input.maxAttempts ?? 5),
      now.toISOString(),
      now.toISOString(),
      now.toISOString(),
      now.toISOString(),
    );
    const accepted = inserted.rows.length === 1;
    const row = await this.query(
      `SELECT * FROM _smrt_forge_deliveries
        WHERE tenant_id = ? AND provider = ? AND delivery_id = ?
        LIMIT 1`,
      [tenant, input.provider, input.deliveryId],
    );
    const delivery = row[0];
    if (!delivery) throw new Error('Forge delivery insert could not be read');
    await audit?.({
      type: accepted ? 'delivery.accepted' : 'delivery.duplicate',
      tenantId: tenant,
      deliveryId: delivery.deliveryId,
      provider: delivery.provider,
    });
    return { delivery, accepted };
  }

  async claimReady(
    options: ClaimForgeDeliveryOptions,
    audit?: ForgeProjectionAuditHook,
  ): Promise<ForgeDelivery | null> {
    assertFinitePositive('leaseMs', options.leaseMs);
    const now = options.now ?? new Date();
    const nowIso = now.toISOString();
    const token = randomUUID();
    const lockClause =
      getDatabaseEngine(this.db) === 'postgres'
        ? ' FOR UPDATE SKIP LOCKED'
        : '';

    // An expired final attempt cannot be safely re-run. Move it to the
    // operator-recoverable terminal state before selecting another candidate.
    await this.query(
      `UPDATE _smrt_forge_deliveries
          SET status = 'dead_letter',
              lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              last_error = 'worker lease expired',
              updated_at = ?
        WHERE status = 'leased'
          AND lease_expires_at < ?
          AND attempts >= max_attempts`,
      [nowIso, nowIso],
      { allowRawOnTenantScoped: true },
    );

    const claimed = await this.query(
      `UPDATE _smrt_forge_deliveries
          SET status = 'leased',
              attempts = attempts + 1,
              lease_owner = ?,
              lease_token = ?,
              lease_expires_at = ?,
              updated_at = ?
        WHERE id IN (
          SELECT id
            FROM _smrt_forge_deliveries
           WHERE attempts < max_attempts
             AND (
               (status IN ('pending', 'retry') AND next_attempt_at <= ?)
               OR (status = 'leased' AND lease_expires_at < ?)
           )
           ORDER BY next_attempt_at ASC, received_at ASC, created_at ASC, id ASC
           LIMIT 1${lockClause}
        )
          AND (
            (status IN ('pending', 'retry') AND next_attempt_at <= ?)
            OR (status = 'leased' AND lease_expires_at < ?)
          )
        RETURNING *`,
      [
        options.workerId,
        token,
        new Date(now.getTime() + options.leaseMs).toISOString(),
        nowIso,
        nowIso,
        nowIso,
        nowIso,
        nowIso,
      ],
      { allowRawOnTenantScoped: true },
    );
    const delivery = claimed[0] ?? null;
    if (delivery) {
      await withTenant({ tenantId: delivery.tenantId }, async () => {
        try {
          await audit?.({
            type: 'delivery.leased',
            tenantId: delivery.tenantId,
            deliveryId: delivery.deliveryId,
            attempt: delivery.attempts,
          });
        } catch {
          // The durable lease already committed. Observability failures must
          // not strand it or consume an attempt before its projector runs.
        }
      });
    }
    return delivery;
  }

  async replay(id: string, audit?: ForgeProjectionAuditHook): Promise<boolean> {
    const tenant = requireTenant().tenantId;
    const now = new Date().toISOString();
    const result = await this.db.query(
      `UPDATE _smrt_forge_deliveries
          SET status = 'pending',
              attempts = 0,
              next_attempt_at = ?,
              lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              last_error = NULL,
              completed_at = NULL,
              replay_count = replay_count + 1,
              updated_at = ?
        WHERE id = ?
          AND tenant_id = ?
          AND status = 'dead_letter'
        RETURNING delivery_id, replay_count`,
      now,
      now,
      id,
      tenant,
    );
    const replayed = result.rows.length === 1;
    if (replayed) {
      const row = result.rows[0] as {
        delivery_id: string;
        replay_count: number;
      };
      await audit?.({
        type: 'delivery.replayed',
        tenantId: tenant,
        deliveryId: row.delivery_id,
        attempt: Number(row.replay_count),
      });
    }
    return replayed;
  }
}

export interface ForgeProjectionRuntimeOptions {
  db: DatabaseInterface;
  workerId: string;
  leaseMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  audit?: ForgeProjectionAuditHook;
}

/**
 * Claims and projects one delivery at a time.
 *
 * The ownership assertion, application projection, monotonic checkpoint and
 * inbox completion are one transaction. The initial no-op UPDATE takes a row
 * write lock, preventing an expired lease from being reclaimed while a valid
 * projection transaction is still in progress.
 */
export class ForgeProjectionRuntime {
  readonly db: DatabaseInterface;
  readonly workerId: string;
  readonly leaseMs: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  readonly audit?: ForgeProjectionAuditHook;

  constructor(options: ForgeProjectionRuntimeOptions) {
    this.db = options.db;
    this.workerId = options.workerId;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.retryBaseMs = options.retryBaseMs ?? 1_000;
    this.retryMaxMs = options.retryMaxMs ?? 300_000;
    assertFinitePositive('leaseMs', this.leaseMs);
    assertFiniteNonNegative('retryBaseMs', this.retryBaseMs);
    assertFiniteNonNegative('retryMaxMs', this.retryMaxMs);
    this.audit = options.audit;
  }

  async processNext(
    projector: ForgeProjector,
    options: { now?: Date } = {},
  ): Promise<ForgeDelivery | null> {
    const inbox = await ForgeDeliveryCollection.create({ db: this.db });
    const delivery = await inbox.claimReady(
      {
        workerId: this.workerId,
        leaseMs: this.leaseMs,
        now: options.now,
      },
      this.audit,
    );
    if (!delivery) return null;

    await withTenant({ tenantId: delivery.tenantId }, async () => {
      try {
        const observation = await projector.observe(delivery);
        await this.commitOwned(delivery, observation, projector, options.now);
      } catch (error) {
        await this.failOwned(delivery, error, options.now);
      }
    });
    return delivery;
  }

  private async commitOwned(
    delivery: ForgeDelivery,
    observation: ForgeObservation | null,
    projector: ForgeProjector,
    now = new Date(),
  ): Promise<void> {
    if (!this.db.transaction) {
      throw new Error(
        'Forge projection requires a database adapter with transaction()',
      );
    }
    const nowIso = now.toISOString();
    let stale = false;
    await this.db.transaction(async (tx) => {
      const ownership = await tx.query(
        `UPDATE _smrt_forge_deliveries
            SET updated_at = updated_at
          WHERE id = ? AND tenant_id = ? AND status = 'leased'
            AND lease_token = ?
            AND lease_expires_at >= ?
          RETURNING id`,
        delivery.id,
        delivery.tenantId,
        delivery.leaseToken,
        nowIso,
      );
      if (ownership.rows.length !== 1) {
        throw new Error('Forge delivery lease ownership was lost');
      }

      if (observation) {
        assertObservation(observation);
        // Reserve the subject version before invoking application code. This
        // write serializes concurrent first-observation and update races; a
        // stale contender gets no RETURNING row and never applies side effects.
        const reserved = await tx.query(
          `INSERT INTO _smrt_forge_projection_checkpoints (
             id, slug, context, tenant_id, projection, subject_key,
             observation_version, delivery_id, observed_at, created_at,
             updated_at
           ) VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (tenant_id, projection, subject_key) DO UPDATE SET
             observation_version = excluded.observation_version,
             delivery_id = excluded.delivery_id,
             observed_at = excluded.observed_at,
             updated_at = excluded.updated_at
           WHERE _smrt_forge_projection_checkpoints.observation_version
             < excluded.observation_version
           RETURNING id`,
          randomUUID(),
          `${observation.projection}-${observation.subjectKey}`.slice(0, 255),
          delivery.tenantId,
          observation.projection,
          observation.subjectKey,
          observation.version,
          delivery.deliveryId,
          nowIso,
          nowIso,
          nowIso,
        );
        stale = reserved.rows.length === 0;
        if (!stale) {
          await projector.project(observation, {
            db: tx,
            tenantId: delivery.tenantId,
            deliveryId: delivery.deliveryId,
          });
        }
      }

      const completed = await tx.query(
        `UPDATE _smrt_forge_deliveries
            SET status = 'completed',
                completed_at = ?,
                lease_owner = NULL,
                lease_token = NULL,
                lease_expires_at = NULL,
                last_error = NULL,
                updated_at = ?
          WHERE id = ? AND tenant_id = ? AND status = 'leased'
            AND lease_token = ?
            AND lease_expires_at >= ?
          RETURNING id`,
        nowIso,
        nowIso,
        delivery.id,
        delivery.tenantId,
        delivery.leaseToken,
        nowIso,
      );
      if (completed.rows.length !== 1) {
        throw new Error('Forge delivery completion lost lease ownership');
      }
    });
    await this.audit?.({
      type: stale ? 'observation.stale' : 'delivery.completed',
      tenantId: delivery.tenantId,
      deliveryId: delivery.deliveryId,
      attempt: delivery.attempts,
    });
  }

  private async failOwned(
    delivery: ForgeDelivery,
    error: unknown,
    now = new Date(),
  ): Promise<void> {
    const terminal = delivery.attempts >= delivery.maxAttempts;
    const delay = Math.min(
      this.retryMaxMs,
      this.retryBaseMs * 2 ** Math.max(0, delivery.attempts - 1),
    );
    const result = await this.db.query(
      `UPDATE _smrt_forge_deliveries
          SET status = ?,
              next_attempt_at = ?,
              lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              last_error = ?,
              updated_at = ?
        WHERE id = ? AND tenant_id = ? AND status = 'leased'
          AND lease_token = ?
          AND lease_expires_at >= ?
        RETURNING id`,
      terminal ? 'dead_letter' : 'retry',
      new Date(now.getTime() + delay).toISOString(),
      redactErrorForPersistence(error),
      now.toISOString(),
      delivery.id,
      delivery.tenantId,
      delivery.leaseToken,
      now.toISOString(),
    );
    if (result.rows.length === 1) {
      await this.audit?.({
        type: terminal ? 'delivery.dead_lettered' : 'delivery.retry_scheduled',
        tenantId: delivery.tenantId,
        deliveryId: delivery.deliveryId,
        attempt: delivery.attempts,
      });
    }
  }
}

function assertNonEmpty(name: string, value: string): void {
  if (value.trim().length === 0) throw new Error(`${name} must not be empty`);
}

function assertFinitePositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a finite positive number`);
  }
}

function assertFiniteNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative number`);
  }
}

function assertObservation(observation: ForgeObservation): void {
  assertNonEmpty('observation.projection', observation.projection);
  assertNonEmpty('observation.subjectKey', observation.subjectKey);
  if (
    !Number.isSafeInteger(observation.version) ||
    observation.version < 0 ||
    observation.version > MAX_OBSERVATION_VERSION
  ) {
    throw new Error(
      `observation.version must be an integer from 0 to ${MAX_OBSERVATION_VERSION}`,
    );
  }
}

function getDatabaseEngine(
  db: DatabaseInterface,
): ReturnType<typeof detectEngine> {
  const dbWithConfig = db as DatabaseWithConfig;
  return detectEngine(
    db.url || dbWithConfig.config?.url || '',
    dbWithConfig.type || dbWithConfig.config?.type,
  );
}

function clampMaxAttempts(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('maxAttempts must be a positive safe integer');
  }
  return Math.min(value, 100);
}
