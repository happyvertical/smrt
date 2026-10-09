import { randomUUID } from 'node:crypto';
import { SmrtJobCollection } from '@happyvertical/smrt-jobs';
import { requireTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  WebhookDeliveryCollection,
  type WebhookSubscription,
  WebhookSubscriptionCollection,
} from './models.js';
import type { WebhookEventEnvelope } from './types.js';

/** Explicit tenant predicates also protect deployments that have not enabled interceptors. */
export class WebhookStore {
  constructor(
    readonly db: DatabaseInterface,
    readonly runtime: string,
  ) {
    if (!runtime) throw new Error('Webhook runtime is required.');
  }
  async subscriptions() {
    const tenantId = requireTenant().tenantId;
    const collection = await WebhookSubscriptionCollection.create({
      db: this.db,
    });
    const result: WebhookSubscription[] = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await collection.list({
        where: { tenantId },
        orderBy: 'id ASC',
        limit: 1000,
        offset,
      });
      result.push(...page);
      if (page.length < 1000) return result;
    }
  }
  async subscription(id: string) {
    const tenantId = requireTenant().tenantId;
    return (await WebhookSubscriptionCollection.create({ db: this.db })).get({
      id,
      tenantId,
    });
  }
  async delivery(id: string) {
    const tenantId = requireTenant().tenantId;
    return (await WebhookDeliveryCollection.create({ db: this.db })).get({
      id,
      tenantId,
    });
  }
  async deliveries() {
    const tenantId = requireTenant().tenantId;
    return (await WebhookDeliveryCollection.create({ db: this.db })).list({
      where: { tenantId },
      orderBy: 'created_at DESC',
      limit: 100,
    });
  }

  /** The unique outbox identity and jobs enqueue commit or roll back together. */
  async accept(
    subscriptionId: string,
    event: WebhookEventEnvelope,
  ): Promise<string> {
    const tenantId = requireTenant().tenantId;
    if (!(await this.subscription(subscriptionId)))
      throw new Error('Webhook subscription not found.');
    if (!this.db.transaction)
      throw new Error('Webhooks require a transactional database.');
    return this.db.transaction(async (tx) => {
      const id = randomUUID();
      const now = new Date().toISOString();
      const inserted = await tx.query(
        `INSERT INTO _smrt_webhook_deliveries
         (id, slug, context, tenant_id, subscription_id, event_id, payload, status, attempts, generation, created_at, updated_at)
         VALUES (?, ?, '', ?, ?, ?, ?, 'pending', 0, 0, ?, ?)
         ON CONFLICT (tenant_id, subscription_id, event_id) DO NOTHING RETURNING id`,
        id,
        id,
        tenantId,
        subscriptionId,
        event.id,
        JSON.stringify(event),
        now,
        now,
      );
      if (inserted.rows.length) {
        await this.enqueue(tx, tenantId, id);
        return id;
      }
      const existing = await tx.query(
        'SELECT CAST(id AS VARCHAR) AS id FROM _smrt_webhook_deliveries WHERE tenant_id = ? AND subscription_id = ? AND event_id = ?',
        tenantId,
        subscriptionId,
        event.id,
      );
      return (existing.rows[0] as { id: string }).id;
    });
  }
  private async enqueue(
    db: DatabaseInterface,
    tenantId: string,
    deliveryId: string,
    generation = 0,
  ) {
    const jobs = await SmrtJobCollection.create({ db });
    await jobs.enqueueJob({
      tenantId,
      queue: 'webhooks',
      objectType: '@happyvertical/smrt-webhooks:WebhookDeliveryTask',
      objectId: null,
      method: 'deliver',
      args: { runtime: this.runtime, tenantId, deliveryId, generation },
      maxAttempts: 5,
      timeout: 30000,
      retryStrategy: {
        type: 'exponential',
        config: { initialDelay: 1000, multiplier: 2, maxDelay: 300000 },
      },
    });
  }
  /** A bounded lease prevents overlapping jobs; expired leases recover after process death. */
  async claim(id: string, generation = 0): Promise<string | null> {
    const tenantId = requireTenant().tenantId;
    const token = randomUUID();
    const now = new Date();
    const result = await this.db.query(
      `UPDATE _smrt_webhook_deliveries SET lease_token = ?, lease_until = ?, attempts = attempts + 1
       WHERE id = ? AND tenant_id = ? AND generation = ? AND status IN ('pending', 'retrying')
       AND (lease_until IS NULL OR lease_until <= ?) RETURNING id`,
      token,
      new Date(now.getTime() + 20000).toISOString(),
      id,
      tenantId,
      generation,
      now.toISOString(),
    );
    return result.rows.length ? token : null;
  }
  async finish(
    id: string,
    token: string,
    status: string,
    responseStatus: number | null,
    error: string | null,
  ) {
    const tenantId = requireTenant().tenantId;
    const result = await this.db.query(
      `UPDATE _smrt_webhook_deliveries SET status = ?, response_status = ?, error = ?, lease_token = NULL, lease_until = NULL, updated_at = ?
       WHERE id = ? AND tenant_id = ? AND lease_token = ? RETURNING id`,
      status,
      responseStatus,
      error,
      new Date().toISOString(),
      id,
      tenantId,
      token,
    );
    if (!result.rows.length) throw new Error('Webhook delivery lease lost.');
  }
  /** Reconcile exhausted/cancelled jobs, including process death before an attempt starts.
   * Tenant-scoped and lease-aware; safe to call on each admin refresh or operator sweep.
   */
  async reconcile(): Promise<void> {
    const tenantId = requireTenant().tenantId;
    const jobs = await SmrtJobCollection.create({ db: this.db });
    for (let offset = 0; ; offset += 1000) {
      const terminal = await jobs.list({
        where: { tenantId, queue: 'webhooks', status: ['failed', 'cancelled'] },
        orderBy: 'id ASC',
        limit: 1000,
        offset,
      });
      for (const job of terminal) {
        if (
          job.args.runtime !== this.runtime ||
          typeof job.args.deliveryId !== 'string'
        )
          continue;
        await this.db.query(
          `UPDATE _smrt_webhook_deliveries SET status = 'failed', error = 'Webhook job exhausted.', lease_token = NULL, lease_until = NULL
           WHERE id = ? AND tenant_id = ? AND generation = ? AND status IN ('pending', 'retrying') AND (lease_until IS NULL OR lease_until <= ?)`,
          job.args.deliveryId,
          tenantId,
          job.args.generation ?? 0,
          new Date().toISOString(),
        );
      }
      if (terminal.length < 1000) return;
    }
  }

  /** Explicit operator recovery for exhausted jobs. Repeated/concurrent replay is a no-op. */
  async replay(id: string): Promise<boolean> {
    const tenantId = requireTenant().tenantId;
    if (!this.db.transaction)
      throw new Error('Webhooks require a transactional database.');
    return this.db.transaction(async (tx) => {
      const changed = await tx.query(
        `UPDATE _smrt_webhook_deliveries SET status = 'pending', attempts = 0, generation = generation + 1, error = NULL, lease_token = NULL, lease_until = NULL
         WHERE id = ? AND tenant_id = ? AND status = 'failed' RETURNING generation`,
        id,
        tenantId,
      );
      if (!changed.rows.length) return false;
      await this.enqueue(
        tx,
        tenantId,
        id,
        Number((changed.rows[0] as { generation: number }).generation),
      );
      return true;
    });
  }
}
