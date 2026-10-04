import { createLogger } from '@happyvertical/logger';
import {
  isEmbeddedDatabase,
  isPostgresDatabase,
  withEmbeddedWriteTransaction,
} from '@happyvertical/smrt-core';
import { getTenantId, withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  type HrActor,
  HrError,
  type HrEvent,
  type HrServiceOptions,
} from './types.js';

const logger = createLogger({ level: 'info' });

/** Collects events inside a transaction; they are delivered after it commits. */
export type HrEventQueue = (event: HrEvent) => void;

/**
 * Shared plumbing for the HR services: a trusted tenant/profile actor, scoped
 * reads, serialized transactional writes, and after-commit event delivery.
 * Applications authorize the actor before constructing a service. Reads and
 * writes reject conflicting ambient tenancy.
 */
export abstract class HrService {
  protected readonly actor: Readonly<HrActor>;
  private readonly onEvent: HrServiceOptions['onEvent'];

  constructor(
    protected readonly db: DatabaseInterface,
    actor: HrActor,
    options: HrServiceOptions = {},
  ) {
    if (!actor?.tenantId?.trim() || !actor?.profileId?.trim())
      throw new HrError(
        'HR_ACTOR_INVALID',
        'HR services require a trusted tenant/profile actor.',
      );
    this.actor = Object.freeze({
      tenantId: this.identity(actor.tenantId),
      profileId: this.identity(actor.profileId),
    });
    this.onEvent = options.onEvent;
  }

  /** Normalize an id; PostgreSQL stores identities as UUIDs. */
  protected identity(value: string): string {
    if (!isPostgresDatabase(this.db)) return value;
    const hex = value.replace(/[{}-]/g, '').toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(hex))
      throw new HrError(
        'HR_INVALID',
        'PostgreSQL HR identities must be UUIDs.',
      );
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  /**
   * A required id from caller input, trimmed and normalized.
   *
   * @throws HrError `HR_INVALID` when it is not text or is blank
   */
  protected id(fieldName: string, value: unknown): string {
    if (typeof value !== 'string' || !value.trim())
      throw new HrError('HR_INVALID', `${fieldName} is required.`);
    return this.identity(value.trim());
  }

  /** An optional id from caller input: null or undefined is null. */
  protected optionalId(fieldName: string, value: unknown): string | null {
    return value === null || value === undefined
      ? null
      : this.id(fieldName, value);
  }

  /** Run a read inside the actor's tenant. */
  protected scope<T>(run: () => Promise<T>): Promise<T> {
    const active = getTenantId();
    if (active && this.identity(active) !== this.actor.tenantId)
      throw new HrError(
        'HR_TENANT_MISMATCH',
        'HR actor differs from active tenant.',
      );
    return withTenant({ tenantId: this.actor.tenantId }, run);
  }

  /**
   * Run a mutation in one transaction, serialized per tenant, then deliver the
   * events it queued. Nothing is delivered when the transaction fails.
   */
  protected async transact<T>(
    run: (db: DatabaseInterface, queue: HrEventQueue) => Promise<T>,
  ): Promise<T> {
    const events: HrEvent[] = [];
    const result = await this.scope(() =>
      withEmbeddedWriteTransaction(
        this.db,
        isEmbeddedDatabase(this.db),
        async (db) => {
          events.length = 0;
          if (isPostgresDatabase(db))
            await db.query(
              'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
              JSON.stringify(['smrt.human-resources', this.actor.tenantId]),
            );
          return run(db, (event) => events.push(event));
        },
        true,
      ),
    );
    for (const event of events) await this.emit(event);
    return result;
  }

  private async emit(event: HrEvent): Promise<void> {
    if (!this.onEvent) return;
    try {
      await this.onEvent(event);
    } catch (error) {
      logger.error(
        `[smrt-human-resources] onEvent handler failed for ${event.type}`,
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
  }
}
