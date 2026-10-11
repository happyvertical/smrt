import { randomUUID } from 'node:crypto';
import { getChangesSince } from '@happyvertical/smrt-core';
import { requireTenant } from '@happyvertical/smrt-tenancy';
import type { WebhookDispatcher } from './dispatcher.js';

export class WebhookHistoryExpiredError extends Error {
  constructor(readonly resumeCursor: number) {
    super(
      'Webhook change history expired; reconcile source state before resetting the cursor.',
    );
  }
}

/** Durable, replayable lifecycle publication from SMRT's committed change feed.
 * Host scheduling calls poll() in each authenticated tenant context. The mapping
 * is an explicit physical-table allowlist; shared STI tables represent the base model.
 */
export class WebhookChangeFeed {
  constructor(
    private readonly dispatcher: WebhookDispatcher,
    private readonly models: Readonly<Record<string, string>>,
  ) {
    if (
      !Object.keys(models).length ||
      Object.keys(models).some((table) => table.startsWith('_smrt_')) ||
      Object.values(models).some((model) => !model)
    )
      throw new Error('Explicit application model tables are required.');
  }
  /** Cursor only advances after all matched changes have durable outbox/jobs.
   * A crash or partial failure replays the same stable identities on the next poll.
   * History pruning fails loudly: the host must reconcile source state before reset.
   */
  async poll(): Promise<{ cursor: number; published: number }> {
    const tenantId = requireTenant().tenantId;
    const { db, runtime } = this.dispatcher.store;
    const now = new Date().toISOString();
    const id = randomUUID();
    await db.query(
      `INSERT INTO _smrt_webhook_cursors (id, slug, context, tenant_id, runtime, position, created_at, updated_at)
       VALUES (?, ?, '', ?, ?, 0, ?, ?) ON CONFLICT (tenant_id, runtime) DO NOTHING`,
      id,
      id,
      tenantId,
      runtime,
      now,
      now,
    );
    const rows = await db.query(
      'SELECT position FROM _smrt_webhook_cursors WHERE tenant_id = ? AND runtime = ?',
      tenantId,
      runtime,
    );
    const since = Number((rows.rows[0] as { position: number }).position);
    const page = await getChangesSince(db, {
      since,
      tenantId,
      tables: Object.keys(this.models),
      limit: 500,
    });
    if (page.resyncRequired)
      throw new WebhookHistoryExpiredError(page.resyncCursor ?? page.cursor);
    let published = 0;
    for (const change of page.changes) {
      // Core's tenant feed includes global rows; webhooks deliberately do not.
      if (
        change.tenantId !== tenantId ||
        !change.rowId ||
        !this.models[change.table]
      )
        continue;
      await this.dispatcher.dispatch({
        id: `change:${change.seq}`,
        event: change.operation,
        model: this.models[change.table],
        occurredAt: change.timestamp,
        data: { id: change.rowId },
      });
      published++;
    }
    await db.query(
      'UPDATE _smrt_webhook_cursors SET position = ?, updated_at = ? WHERE tenant_id = ? AND runtime = ? AND position = ?',
      page.cursor,
      new Date().toISOString(),
      tenantId,
      runtime,
      since,
    );
    return { cursor: page.cursor, published };
  }
  /** Operator-only recovery: call after reconciling retained source state externally. */
  async resumeAfterResync(cursor: number): Promise<void> {
    if (!Number.isSafeInteger(cursor) || cursor < 0)
      throw new Error('Invalid webhook change cursor.');
    const tenantId = requireTenant().tenantId;
    const { db, runtime } = this.dispatcher.store;
    await db.query(
      'UPDATE _smrt_webhook_cursors SET position = ? WHERE tenant_id = ? AND runtime = ?',
      cursor,
      tenantId,
      runtime,
    );
  }
}
