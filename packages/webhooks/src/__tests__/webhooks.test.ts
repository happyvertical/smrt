import { createHmac } from 'node:crypto';
import {
  bumpChangeFeed,
  getTestDatabase,
  ObjectRegistry,
  pruneChangeFeed,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { SmrtJobCollection, TaskRunner } from '@happyvertical/smrt-jobs';
import {
  disableTenancy,
  enableTenancy,
  TenantScoped,
  tenantId,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebhookAdminService } from '../admin.js';
import {
  WebhookChangeFeed,
  WebhookHistoryExpiredError,
} from '../change-feed.js';
import {
  assertWebhookEvent,
  registerWebhookRuntime,
  runWebhookDeliveryJob,
  unregisterWebhookRuntime,
  WebhookDispatcher,
} from '../dispatcher.js';
import { registerWebhookModelEvents } from '../events.js';
import { WebhookSubscriptionCollection } from '../models.js';
import type { WebhookRequest } from '../security.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const secret = 'super-private-secret-'.repeat(3);
const event = {
  id: 'event-1',
  event: 'create',
  model: 'Order',
  occurredAt: '2026-10-09T00:00:00Z',
  data: { id: 'order-1', private: 'payload-only' },
};
const tenant = <T>(fn: () => Promise<T>, id = A) =>
  withTenant({ tenantId: id }, fn);

@smrt({ tableName: 'webhook_test_records' })
@TenantScoped({ mode: 'required' })
class WebhookTestRecord extends SmrtObject {
  @tenantId() tenantId: string = '';
}
class Records extends SmrtCollection<WebhookTestRecord> {
  static readonly _itemClass = WebhookTestRecord;
}

const dialects = process.env.DATABASE_URL
  ? (['sqlite', 'duckdb', 'postgres'] as const)
  : (['sqlite', 'duckdb'] as const);
for (const type of dialects)
  describe(`durable webhooks (${type})`, () => {
    let db: DatabaseInterface;
    let pgAdmin: DatabaseInterface | undefined;
    let pgName = '';
    let dispatcher: WebhookDispatcher;
    let requests: WebhookRequest[];
    let admin: WebhookAdminService;
    beforeEach(async () => {
      enableTenancy({ rawQueryPolicy: 'throw' });
      let url = ':memory:';
      if (type === 'postgres') {
        pgAdmin = await getTestDatabase({
          type,
          url: process.env.DATABASE_URL,
          classes: [],
          includeSystemTables: false,
        });
        pgName = `webhooks_${crypto.randomUUID().replaceAll('-', '')}`;
        await pgAdmin.query(`CREATE DATABASE ${pgName}`);
        const target = new URL(process.env.DATABASE_URL ?? '');
        target.pathname = `/${pgName}`;
        url = target.toString();
      }
      db = await getTestDatabase({
        type,
        url,
        classes: [
          'WebhookSubscription',
          'WebhookDelivery',
          'WebhookDeliveryTask',
          'WebhookCursor',
          'WebhookTestRecord',
          'SmrtJob',
          'SmrtJobEvent',
          'SmrtWorker',
        ],
      });
      requests = [];
      dispatcher = new WebhookDispatcher({
        db,
        runtime: 'test',
        transport: async (request) => {
          requests.push(request);
          return 204;
        },
      });
      admin = new WebhookAdminService(dispatcher.store, async () => true);
      await tenant(() =>
        admin.create({
          url: 'https://partner.example/hook',
          events: [],
          models: [],
          secret,
        }),
      );
    });
    afterEach(async () => {
      disableTenancy();
      unregisterWebhookRuntime('test');
      await db?.close?.();
      if (pgAdmin) {
        await pgAdmin.query(`DROP DATABASE ${pgName} WITH (FORCE)`);
        await pgAdmin.close?.();
        pgAdmin = undefined;
      }
    });

    it('atomically enqueues once, persists exact body, signs it, and survives dispatcher restart', async () => {
      await tenant(async () => {
        const [id] = await dispatcher.dispatch(event);
        expect(await dispatcher.dispatch(event)).toEqual([id]);
        const jobs = await SmrtJobCollection.create({ db });
        const rows = await jobs.list({
          where: { tenantId: A, queue: 'webhooks' },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].maxAttempts).toBe(5);
        expect(rows[0].retryStrategy.type).toBe('exponential');
        expect(JSON.stringify(rows[0].args)).not.toContain('payload-only');
        expect(JSON.stringify(rows[0].args)).not.toContain(secret);
        const restarted = new WebhookDispatcher({
          db,
          runtime: 'test',
          transport: async (r) => {
            requests.push(r);
            return 204;
          },
        });
        registerWebhookRuntime('test', restarted);
        await runWebhookDeliveryJob(rows[0].args);
        await restarted.deliver(id);
        expect(requests).toHaveLength(1);
        const request = requests[0];
        expect(request.body).toBe(JSON.stringify(event));
        expect(request.headers['x-smrt-signature']).toBe(
          `sha256=${createHmac('sha256', secret).update(`${request.headers['x-smrt-timestamp']}.${request.body}`).digest('hex')}`,
        );
        const view = await admin.view();
        expect(view.deliveries[0]).toMatchObject({
          status: 'delivered',
          responseStatus: 204,
          attempts: 1,
        });
        expect(JSON.stringify(view)).not.toMatch(
          /payload-only|super-private-secret|leaseToken/,
        );
      });
    });
    it('suppresses concurrent dispatch for the same durable identity', async () => {
      await tenant(async () => {
        const ids = await Promise.all([
          dispatcher.dispatch(event),
          dispatcher.dispatch(event),
        ]);
        expect(ids[0]).toEqual(ids[1]);
        expect(await dispatcher.store.deliveries()).toHaveLength(1);
        const jobs = await SmrtJobCollection.create({ db });
        expect(
          await jobs.list({ where: { tenantId: A, queue: 'webhooks' } }),
        ).toHaveLength(1);
      });
    });
    it('fans out to distinct subscriptions without overwriting their natural identities', async () => {
      await tenant(async () => {
        await admin.create({
          url: 'https://second.example/hook',
          events: [],
          models: [],
          secret,
        });
        const subscriptions = await dispatcher.store.subscriptions();
        expect(subscriptions).toHaveLength(2);
        const ids = await dispatcher.dispatch(event);
        expect(new Set(ids).size).toBe(2);
      });
    });
    it('rolls back the delivery if enqueue fails, then permits retry', async () => {
      await tenant(async () => {
        const spy = vi
          .spyOn(SmrtJobCollection.prototype, 'enqueueJob')
          .mockRejectedValueOnce(new Error('queue unavailable'));
        await expect(dispatcher.dispatch(event)).rejects.toThrow(
          'queue unavailable',
        );
        spy.mockRestore();
        expect(await dispatcher.store.deliveries()).toHaveLength(0);
        expect(await dispatcher.dispatch(event)).toHaveLength(1);
      });
    });
    it('fails closed for missing/mismatched tenant, and forbids non-administrator mutations', async () => {
      const [id] = await tenant(() => dispatcher.dispatch(event));
      await expect(dispatcher.store.delivery(id)).rejects.toThrow();
      await tenant(async () => {
        expect(await dispatcher.store.delivery(id)).toBeNull();
        expect((await admin.view()).subscriptions).toHaveLength(0);
        await dispatcher.deliver(id);
        expect(await dispatcher.store.replay(id)).toBe(false);
        registerWebhookRuntime('test', dispatcher);
        await expect(
          runWebhookDeliveryJob({
            runtime: 'test',
            tenantId: A,
            deliveryId: id,
          }),
        ).rejects.toThrow();
      }, B);
      const denied = new WebhookAdminService(
        dispatcher.store,
        async () => false,
      );
      await tenant(() =>
        expect(
          denied.create({
            url: 'https://partner.example',
            events: [],
            models: [],
            secret,
          }),
        ).rejects.toThrow('forbidden'),
      );
      expect(requests).toHaveLength(0);
    });
    it('retries failures, records only safe errors, and supports terminal replay', async () => {
      await tenant(async () => {
        const failing = new WebhookDispatcher({
          db,
          runtime: 'test',
          transport: async () => {
            throw new Error(`secret=${secret}`);
          },
        });
        const [id] = await failing.dispatch(event);
        for (let n = 0; n < 5; n++)
          await expect(failing.deliver(id)).rejects.toThrow(
            'Webhook delivery failed.',
          );
        expect(await failing.store.delivery(id)).toMatchObject({
          status: 'failed',
          attempts: 5,
          error: 'Webhook delivery failed.',
        });
        expect(await failing.store.replay(id)).toBe(true);
        expect(await failing.store.replay(id)).toBe(false);
        await dispatcher.deliver(id);
        expect(await dispatcher.store.delivery(id)).toMatchObject({
          status: 'delivered',
          attempts: 1,
        });
      });
    });
    it('guards leases and recovers abandoned attempts without duplicate concurrent sends', async () => {
      await tenant(async () => {
        const [id] = await dispatcher.dispatch(event);
        const token = await dispatcher.store.claim(id);
        expect(token).toBeTruthy();
        expect(await dispatcher.store.claim(id)).toBeNull();
        await expect(dispatcher.deliver(id)).rejects.toThrow('already leased');
        await db.query(
          'UPDATE _smrt_webhook_deliveries SET lease_until = ? WHERE id = ?',
          '2020-01-01T00:00:00Z',
          id,
        );
        await dispatcher.deliver(id);
        await expect(
          dispatcher.store.finish(id, token ?? '', 'failed', null, 'stale'),
        ).rejects.toThrow('lease lost');
        expect(requests).toHaveLength(1);
      });
    });
    it('filters model/event subscriptions, cancels disabled subscriptions, and accepts custom events', async () => {
      await tenant(async () => {
        const sub = (await dispatcher.store.subscriptions())[0];
        sub.events = ['custom.paid'];
        sub.models = ['Invoice'];
        await sub.save();
        expect(await dispatcher.dispatch(event)).toEqual([]);
        const [id] = await dispatcher.dispatch({
          ...event,
          event: 'custom.paid',
          model: 'Invoice',
        });
        await admin.toggle(sub.id ?? '', false);
        await dispatcher.deliver(id);
        expect(await dispatcher.store.delivery(id)).toMatchObject({
          status: 'cancelled',
        });
        expect(requests).toHaveLength(0);
        expect(() =>
          assertWebhookEvent({ ...event, event: 'bad\r\nheader' }),
        ).toThrow();
        expect(() =>
          assertWebhookEvent({ ...event, data: undefined as never }),
        ).toThrow();
      });
    });
    it('captures create, update, delete with safe identity-only model payloads', async () => {
      // Decorated test identities are package-qualified by the test scanner.
      const name =
        ObjectRegistry.getClass('WebhookTestRecord')?.qualifiedName ??
        'WebhookTestRecord';
      const stop = registerWebhookModelEvents(dispatcher, [name]);
      try {
        await tenant(async () => {
          const records = await Records.create({ db });
          const record = await records.create({ slug: 'record', tenantId: A });
          await record.save();
          await record.delete();
          const deliveries = await dispatcher.store.deliveries();
          expect(
            deliveries.map((d) => JSON.parse(d.payload).event).sort(),
          ).toEqual(['create', 'delete', 'update']);
          for (const d of deliveries)
            expect(JSON.parse(d.payload).data).toEqual({ id: record.id });
        });
      } finally {
        stop();
      }
    });
    it('runs the real jobs worker with captured tenant context', async () => {
      const [id] = await tenant(() => dispatcher.dispatch(event));
      registerWebhookRuntime('test', dispatcher);
      const runner = new TaskRunner({
        queues: ['webhooks'],
        pollInterval: 20,
        retention: false,
      });
      try {
        await runner.initialize(db);
        await runner.start();
        await vi.waitFor(
          async () => {
            expect(
              await tenant(() => dispatcher.store.delivery(id)),
            ).toMatchObject({ status: 'delivered' });
          },
          { timeout: 10000 },
        );
      } finally {
        await runner.stop();
      }
      expect(requests).toHaveLength(1);
    });
    it('reconciles terminal queue failures and fences an old job after replay', async () => {
      await tenant(async () => {
        const [id] = await dispatcher.dispatch(event);
        const jobs = await SmrtJobCollection.create({ db });
        const original = (
          await jobs.list({ where: { tenantId: A, queue: 'webhooks' } })
        )[0];
        await db.query(
          "UPDATE _smrt_jobs SET status = 'failed' WHERE id = ?",
          original.id,
        );
        await dispatcher.store.reconcile();
        expect(await dispatcher.store.delivery(id)).toMatchObject({
          status: 'failed',
        });
        expect(await dispatcher.store.replay(id)).toBe(true);
        await dispatcher.store.reconcile();
        expect(await dispatcher.store.delivery(id)).toMatchObject({
          status: 'pending',
          generation: 1,
        });
        registerWebhookRuntime('test', dispatcher);
        await runWebhookDeliveryJob(original.args);
        expect(requests).toHaveLength(0);
        await dispatcher.deliver(id);
        expect(requests).toHaveLength(1);
      });
    });
    it('recovers committed source changes and tombstones after partial publication or restart', async () => {
      const records = await Records.create({ db });
      await tenant(async () => {
        await records.create({ slug: 'other-tenant', tenantId: B });
      }, B);
      await bumpChangeFeed(db, {
        table: 'webhook_test_records',
        rowId: crypto.randomUUID(),
        operation: 'create',
        tenantId: null,
      });
      await tenant(async () => {
        const record = await records.create({
          slug: 'recoverable',
          tenantId: A,
        });
        await record.save();
        await record.delete();
        const mapping = { webhook_test_records: 'Order' };
        const feed = new WebhookChangeFeed(dispatcher, mapping);
        const publish = dispatcher.dispatch.bind(dispatcher);
        let calls = 0;
        const spy = vi
          .spyOn(dispatcher, 'dispatch')
          .mockImplementation(async (e) => {
            if (++calls === 2)
              throw new Error('interrupted after first durable enqueue');
            return publish(e);
          });
        await expect(feed.poll()).rejects.toThrow('interrupted');
        expect(await dispatcher.store.deliveries()).toHaveLength(1);
        spy.mockRestore();
        const restart = new WebhookChangeFeed(
          new WebhookDispatcher({ db, runtime: 'test' }),
          mapping,
        );
        await restart.poll();
        const deliveries = await dispatcher.store.deliveries();
        expect(deliveries).toHaveLength(3);
        expect(
          deliveries.map((d) => JSON.parse(d.payload).event).sort(),
        ).toEqual(['create', 'delete', 'update']);
        await restart.poll();
        expect(await dispatcher.store.deliveries()).toHaveLength(3);
      });
    });
    it('fails closed for pruned source history until an operator reconciles it', async () => {
      await tenant(async () => {
        const records = await Records.create({ db });
        await records.create({ slug: 'old', tenantId: A });
        await records.create({ slug: 'new', tenantId: A });
        await pruneChangeFeed(db, { maxRows: 1 });
        const feed = new WebhookChangeFeed(dispatcher, {
          webhook_test_records: 'Order',
        });
        const failure = await feed.poll().catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(WebhookHistoryExpiredError);
        if (!(failure instanceof WebhookHistoryExpiredError))
          throw new Error('Expected history expiration');
        expect(await dispatcher.store.deliveries()).toHaveLength(0);
        await feed.resumeAfterResync(failure.resumeCursor);
        await expect(feed.poll()).resolves.toMatchObject({ published: 0 });
      });
    });
    it('keeps persisted credentials out of public model serialization', async () => {
      await tenant(async () => {
        const subscriptions = await WebhookSubscriptionCollection.create({
          db,
        });
        const sub = (await subscriptions.list({ where: { tenantId: A } }))[0];
        expect(sub.secret).toBe(secret);
        expect(JSON.stringify(sub.toPublicJSON())).not.toContain(secret);
      });
    });
  });
