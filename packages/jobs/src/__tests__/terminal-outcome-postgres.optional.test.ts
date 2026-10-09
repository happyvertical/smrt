import { getTestDatabase } from '@happyvertical/smrt-core';
import { isPostgresAvailable } from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtJobCollection } from '../smrt-job.js';
import { SmrtJobEventCollection } from '../smrt-job-event.js';
import {
  terminalSnapshot,
  transitionTerminalJob,
} from '../terminal-outcome.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;
const TENANT_ID = '11111111-1111-4111-8111-111111111111';

describePostgres('atomic terminal job outcomes on PostgreSQL', () => {
  let admin: DatabaseInterface;
  let db: DatabaseInterface;
  let baseUrl: string;
  let databaseName: string;

  beforeEach(async () => {
    baseUrl = process.env.DATABASE_URL ?? '';
    admin = await getTestDatabase({
      type: 'postgres',
      url: baseUrl,
      classes: [],
      includeSystemTables: false,
    });
    databaseName = `smrt_terminal_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const url = new URL(baseUrl);
    url.pathname = `/${databaseName}`;
    db = await getTestDatabase({
      type: 'postgres',
      url: url.toString(),
      classes: ['SmrtJob', 'SmrtJobEvent'],
    });
  });

  afterEach(async () => {
    await (db as { close?: () => Promise<void> }).close?.();
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await (admin as { close?: () => Promise<void> }).close?.();
  });

  it('commits once after a race and rolls back state when its event fails', async () => {
    const jobs = await SmrtJobCollection.create({ db });
    const events = await SmrtJobEventCollection.create({ db });
    const first = await jobs.create({
      tenantId: TENANT_ID,
      queue: 'reports',
      objectType: 'SmrtDataSurfaceActionTask',
      method: 'run',
    });
    const firstSnapshot = terminalSnapshot(first);
    if (!firstSnapshot) throw new Error('Expected persisted job');

    expect(
      await transitionTerminalJob(db, {
        job: firstSnapshot,
        status: 'completed',
        completedAt: new Date(),
        expectedStatuses: ['pending'],
      }),
    ).not.toBeNull();
    expect(
      await transitionTerminalJob(db, {
        job: firstSnapshot,
        status: 'failed',
        completedAt: new Date(),
        expectedStatuses: ['pending'],
        failureKind: 'execution',
      }),
    ).toBeNull();

    const second = await jobs.create({
      tenantId: TENANT_ID,
      queue: 'reports',
      objectType: 'SmrtDataSurfaceActionTask',
      method: 'run',
    });
    const secondSnapshot = terminalSnapshot(second);
    if (!secondSnapshot) throw new Error('Expected persisted job');
    await db.query(`CREATE FUNCTION reject_terminal_outcome() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'terminal event rejected';
      END
      $$`);
    await db.query(`CREATE TRIGGER reject_terminal_outcome
      BEFORE INSERT ON _smrt_job_events
      FOR EACH ROW EXECUTE FUNCTION reject_terminal_outcome()`);

    await expect(
      transitionTerminalJob(db, {
        job: secondSnapshot,
        status: 'failed',
        completedAt: new Date(),
        expectedStatuses: ['pending'],
        failureKind: 'execution',
      }),
    ).rejects.toThrow(/terminal event rejected/);
    expect((await jobs.get({ id: second.id }))?.status).toBe('pending');
    expect(
      (
        await events.listTerminalOutcomes({
          tenantId: TENANT_ID,
        })
      ).outcomes,
    ).toHaveLength(1);
  });
});
