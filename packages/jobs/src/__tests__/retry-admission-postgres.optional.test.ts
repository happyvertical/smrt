import { getTestDatabase } from '@happyvertical/smrt-core';
import { isPostgresAvailable } from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHmacDurableJobPayloadSigner } from '../durable-payload-integrity.js';
import { verifyScheduleAdmission } from '../schedule-admission.js';
import { ScheduleRunner } from '../schedule-runner.js';
import { SmrtJobCollection } from '../smrt-job.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const scheduleId = '33333333-3333-4333-8333-333333333333';
const describePostgres = isPostgresAvailable() ? describe : describe.skip;
const signer = createHmacDurableJobPayloadSigner({
  keyId: 'pg-retry-fixture',
  key: 'synthetic-pg-retry-capacity-signing-key-32-bytes',
});

describePostgres('retry and admission share PostgreSQL capacity', () => {
  let admin: DatabaseInterface;
  let db: DatabaseInterface;
  let consumer: DatabaseInterface;
  let databaseName: string;
  let runner: ScheduleRunner;
  let jobs: SmrtJobCollection;

  beforeEach(async () => {
    const baseUrl = process.env.DATABASE_URL ?? '';
    admin = await getTestDatabase({
      type: 'postgres',
      url: baseUrl,
      classes: [],
      includeSystemTables: false,
    });
    databaseName = `smrt_retry_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const url = new URL(baseUrl);
    url.pathname = `/${databaseName}`;
    db = await getTestDatabase({
      type: 'postgres',
      url: url.toString(),
      classes: ['SmrtJob', 'SmrtJobDedupeSlot'],
    });
    jobs = await SmrtJobCollection.create({ db });
    await db.query(`CREATE TABLE _smrt_agent_schedules (
      id UUID PRIMARY KEY, tenant_id UUID, agent_type TEXT,
      agent_id TEXT, agent_config TEXT, cron TEXT, timezone TEXT, method TEXT,
      method_args TEXT, timeout INTEGER, enabled BOOLEAN, status TEXT,
      next_run TEXT, running_count INTEGER, max_concurrent INTEGER, last_error TEXT)`);
    await db.query(
      `INSERT INTO _smrt_agent_schedules
      (id, tenant_id, agent_type, cron, timezone, method, method_args,
       enabled, status, next_run, running_count, max_concurrent)
      VALUES (?, ?, 'Probe', '* * * * *', 'UTC', 'run', '{}', TRUE,
       'active', '2026-01-01T00:00:00.000Z', 0, 1)`,
      scheduleId,
      tenantId,
    );
    consumer = await getTestDatabase({
      type: 'postgres',
      url: url.toString(),
      classes: [],
      includeSystemTables: false,
    });
    runner = new ScheduleRunner({
      tenantIds: [tenantId],
      occurrenceSigner: signer,
    });
    await runner.initialize(consumer);
  });

  afterEach(async () => {
    await runner?.stop();
    await consumer?.close?.();
    await db?.close?.();
    if (admin && databaseName)
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin?.close?.();
  });

  const poll = () => (runner as unknown as { poll(): Promise<void> }).poll();
  const active = async () =>
    (await jobs.list({ limit: 20 })).filter((job) =>
      ['pending', 'running'].includes(job.status),
    );

  async function cancelledOccurrence() {
    await poll();
    const old = (await jobs.list({ limit: 20 }))[0];
    expect(verifyScheduleAdmission(old, signer)).toBe(true);
    await old.cancel();
    await db.query(
      'UPDATE _smrt_agent_schedules SET next_run = ?',
      '2026-01-02T00:00:00.000Z',
    );
    return old;
  }

  async function waitForScheduleLock() {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const waiting = await admin.query(
        `SELECT pid FROM pg_stat_activity
        WHERE datname = ? AND wait_event_type = 'Lock'
        AND query LIKE '%UPDATE _smrt_agent_schedules%'`,
        databaseName,
      );
      if (waiting.rows.length) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(
      'Independent admission connection never waited for the schedule lock',
    );
  }

  it('committed retry blocks a real concurrent admission without advancing its due instant', async () => {
    if (!db.transaction) throw new Error('PostgreSQL transactions required');
    const old = await cancelledOccurrence();
    const original = JSON.stringify(old.args);
    let competing: Promise<void> | undefined;
    try {
      await db.transaction(async (tx) => {
        await old.retry({ transaction: tx });
        competing = poll();
        // Observe PostgreSQL's actual lock wait, rather than assuming overlap
        // from a short sleep or a mocked transaction callback.
        await waitForScheduleLock();
      });
      await competing;
      expect((await active()).map((job) => job.id)).toEqual([old.id]);
      expect(JSON.stringify((await jobs.get({ id: old.id }))?.args)).toBe(
        original,
      );
      expect(verifyScheduleAdmission(old, signer)).toBe(true);
      const schedule = await db.query(
        'SELECT next_run, running_count FROM _smrt_agent_schedules',
      );
      expect(schedule.rows[0]).toMatchObject({
        next_run: '2026-01-02T00:00:00.000Z',
        running_count: 1,
      });
    } finally {
      await competing;
    }
  });

  it('caller rollback restores retry and lets the blocked admission take the only slot', async () => {
    if (!db.transaction) throw new Error('PostgreSQL transactions required');
    const old = await cancelledOccurrence();
    const signature = JSON.stringify(old.args._scheduleAdmission);
    let competing: Promise<void> | undefined;
    try {
      await expect(
        db.transaction(async (tx) => {
          await old.retry({ transaction: tx });
          competing = poll();
          await waitForScheduleLock();
          throw new Error('fixture caller rollback');
        }),
      ).rejects.toThrow('fixture caller rollback');
      await competing;
      const stored = await jobs.get({ id: old.id }, { cache: false });
      expect(stored?.status).toBe('cancelled');
      expect(JSON.stringify(stored?.args._scheduleAdmission)).toBe(signature);
      const running = await active();
      expect(running).toHaveLength(1);
      expect(running[0].id).not.toBe(old.id);
      expect(verifyScheduleAdmission(running[0], signer)).toBe(true);
      await expect(stored?.retry()).rejects.toThrow(/capacity/i);
    } finally {
      await competing;
    }
  });
});
