/**
 * Regression for #3390: core `save()` never called `AgentSchedule.beforeSave()`,
 * so an enabled schedule created with `create()` + `save()` persisted a NULL
 * `next_run`. `ScheduleRunner.poll()` selects `next_run <= now`, which NULL
 * never satisfies, so the schedule silently never fired.
 *
 * Real in-memory SQLite, no DB mocking.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentScheduleCollection } from './schedule.js';

describe('AgentSchedule.save() computes nextRun (#3390)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  it('persists next_run for an enabled schedule created with create() + save()', async () => {
    const schedules = await AgentScheduleCollection.create({ db });
    const schedule = await schedules.create({
      agentType: 'Praeco',
      cron: '*/15 * * * *',
      enabled: true,
      method: 'run',
    });
    const before = Date.now();
    await schedule.save();

    const reread = await schedules.get({ id: String(schedule.id) });
    expect(reread?.nextRun).toBeInstanceOf(Date);
    const nextRun = reread?.nextRun?.getTime() ?? 0;
    expect(nextRun).toBeGreaterThan(before);
    expect(nextRun).toBeLessThanOrEqual(before + 15 * 60 * 1000);
  });

  it('leaves next_run NULL for a disabled schedule', async () => {
    const schedules = await AgentScheduleCollection.create({ db });
    const schedule = await schedules.create({
      agentType: 'Praeco',
      cron: '*/15 * * * *',
      enabled: false,
      method: 'run',
    });
    await schedule.save();

    const reread = await schedules.get({ id: String(schedule.id) });
    expect(reread?.nextRun ?? null).toBeNull();
  });
});
