import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentSchedule,
  AgentScheduleCollection,
  type ScheduleStatus,
} from './schedule.js';

describe('AgentSchedule', () => {
  let collection: AgentScheduleCollection;
  let db: Awaited<ReturnType<typeof getDatabase>>;

  beforeEach(async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });

    // Create agent schedules table
    await db.query(`
      CREATE TABLE IF NOT EXISTS _smrt_agent_schedules (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        context TEXT,
        agent_type TEXT NOT NULL,
        agent_id TEXT,
        agent_config TEXT DEFAULT '{}',
        cron TEXT NOT NULL,
        timezone TEXT DEFAULT 'UTC',
        enabled INTEGER DEFAULT 1,
        status TEXT DEFAULT 'active',
        last_run DATETIME,
        next_run DATETIME,
        last_status TEXT,
        last_error TEXT,
        run_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        failure_count INTEGER DEFAULT 0,
        max_concurrent INTEGER DEFAULT 1,
        running_count INTEGER DEFAULT 0,
        timeout INTEGER DEFAULT 3600000,
        method TEXT DEFAULT 'run',
        method_args TEXT DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(slug, context)
      )
    `);

    collection = await AgentScheduleCollection.create({
      db: { type: 'sqlite', url: ':memory:' },
    });
    (collection as unknown as { _db: typeof db })._db = db;
  });

  afterEach(async () => {
    // Cleanup
  });

  describe('create and save', () => {
    it('should create a schedule with default values', async () => {
      const schedule = await collection.create({
        agentType: 'Praeco',
        cron: '0 2 * * *',
      });
      await schedule.save();

      expect(schedule.id).toBeDefined();
      expect(schedule.enabled).toBe(true);
      expect(schedule.status).toBe('active');
      expect(schedule.maxConcurrent).toBe(1);
      expect(schedule.method).toBe('run');
    });

    it('should create a schedule with custom values', async () => {
      const schedule = await collection.create({
        agentType: 'Praeco',
        agentId: 'praeco-main',
        cron: '0 */6 * * *',
        timezone: 'America/New_York',
        maxConcurrent: 2,
        timeout: 7200000,
        method: 'scrape',
        methodArgs: { depth: 3 },
      });
      await schedule.save();

      expect(schedule.agentType).toBe('Praeco');
      expect(schedule.agentId).toBe('praeco-main');
      expect(schedule.cron).toBe('0 */6 * * *');
      expect(schedule.timezone).toBe('America/New_York');
      expect(schedule.maxConcurrent).toBe(2);
      expect(schedule.timeout).toBe(7200000);
      expect(schedule.method).toBe('scrape');
      expect(schedule.methodArgs).toEqual({ depth: 3 });
    });
  });

  describe('enable() and disable()', () => {
    it('should enable a disabled schedule', async () => {
      const schedule = await collection.create({
        agentType: 'Praeco',
        cron: '0 2 * * *',
      });
      schedule.enabled = false;
      schedule.status = 'disabled';
      await schedule.save();

      await schedule.enable();

      expect(schedule.enabled).toBe(true);
      expect(schedule.status).toBe('active');
      expect(schedule.nextRun).not.toBeNull();
    });

    it('should disable an enabled schedule', async () => {
      const schedule = await collection.create({
        agentType: 'Praeco',
        cron: '0 2 * * *',
      });
      await schedule.save();

      await schedule.disable();

      expect(schedule.enabled).toBe(false);
      expect(schedule.status).toBe('disabled');
    });
  });

  describe('pause() and resume()', () => {
    it('should pause a schedule', async () => {
      const schedule = await collection.create({
        agentType: 'Praeco',
        cron: '0 2 * * *',
      });
      await schedule.save();

      await schedule.pause();

      expect(schedule.status).toBe('paused');
    });

    it('should resume a paused schedule', async () => {
      const schedule = await collection.create({
        agentType: 'Praeco',
        cron: '0 2 * * *',
      });
      schedule.status = 'paused';
      await schedule.save();

      await schedule.resume();

      expect(schedule.status).toBe('active');
    });
  });

  describe('recordSuccess() and recordFailure()', () => {
    it('should record a successful run', async () => {
      const schedule = await collection.create({
        agentType: 'Praeco',
        cron: '0 2 * * *',
      });
      schedule.runningCount = 1;
      await schedule.save();

      await schedule.recordSuccess();

      expect(schedule.lastRun).toBeInstanceOf(Date);
      expect(schedule.lastStatus).toBe('success');
      expect(schedule.runCount).toBe(1);
      expect(schedule.successCount).toBe(1);
      expect(schedule.runningCount).toBe(0);
    });

    it('should record a failed run', async () => {
      const schedule = await collection.create({
        agentType: 'Praeco',
        cron: '0 2 * * *',
      });
      schedule.runningCount = 1;
      await schedule.save();

      await schedule.recordFailure('Connection timeout');

      expect(schedule.lastRun).toBeInstanceOf(Date);
      expect(schedule.lastStatus).toBe('failed');
      expect(schedule.lastError).toBe('Connection timeout');
      expect(schedule.runCount).toBe(1);
      expect(schedule.failureCount).toBe(1);
      expect(schedule.runningCount).toBe(0);
    });
  });

  describe('isDue()', () => {
    it('should return false when disabled', async () => {
      const schedule = await collection.create({
        agentType: 'Praeco',
        cron: '0 2 * * *',
      });
      schedule.enabled = false;
      await schedule.save();

      expect(schedule.isDue()).toBe(false);
    });

    it('should return false when status is not active', async () => {
      const schedule = await collection.create({
        agentType: 'Praeco',
        cron: '0 2 * * *',
      });
      schedule.status = 'paused';
      await schedule.save();

      expect(schedule.isDue()).toBe(false);
    });

    it('should return false when no nextRun', async () => {
      const schedule = await collection.create({
        agentType: 'Praeco',
        cron: '0 2 * * *',
      });
      schedule.nextRun = null;
      await schedule.save();

      expect(schedule.isDue()).toBe(false);
    });

    it('should return false when max concurrent reached', async () => {
      const schedule = await collection.create({
        agentType: 'Praeco',
        cron: '0 2 * * *',
      });
      schedule.maxConcurrent = 1;
      schedule.runningCount = 1;
      schedule.nextRun = new Date(Date.now() - 60000); // Past due
      await schedule.save();

      expect(schedule.isDue()).toBe(false);
    });

    it('should return true when due and available', async () => {
      const schedule = await collection.create({
        agentType: 'Praeco',
        cron: '0 2 * * *',
      });
      schedule.nextRun = new Date(Date.now() - 60000); // 1 minute ago
      await schedule.save();

      expect(schedule.isDue()).toBe(true);
    });
  });

  describe('calculateNextRun()', () => {
    it('should calculate next run from cron expression', async () => {
      const schedule = await collection.create({
        agentType: 'Praeco',
        cron: '* * * * *', // Every minute
      });

      schedule.calculateNextRun();

      expect(schedule.nextRun).not.toBeNull();
      expect(schedule.nextRun?.getTime()).toBeGreaterThan(Date.now());
    });

    it('should set error status for invalid cron', async () => {
      const schedule = await collection.create({
        agentType: 'Praeco',
        cron: 'invalid cron',
      });

      schedule.calculateNextRun();

      expect(schedule.nextRun).toBeNull();
      expect(schedule.status).toBe('error');
      expect(schedule.lastError).toContain('Invalid cron expression');
    });

    it('should clear nextRun when disabled', async () => {
      const schedule = await collection.create({
        agentType: 'Praeco',
        cron: '0 2 * * *',
      });
      schedule.enabled = false;

      schedule.calculateNextRun();

      expect(schedule.nextRun).toBeNull();
    });
  });

  describe('getDescription()', () => {
    it('should return description with agent ID', async () => {
      const schedule = await collection.create({
        agentType: 'Praeco',
        agentId: 'praeco-main',
        cron: '0 2 * * *',
      });

      expect(schedule.getDescription()).toBe(
        'Praeco#praeco-main.run() @ 0 2 * * *',
      );
    });

    it('should return description without agent ID', async () => {
      const schedule = await collection.create({
        agentType: 'Praeco',
        cron: '0 2 * * *',
      });

      expect(schedule.getDescription()).toBe('Praeco.run() @ 0 2 * * *');
    });

    it('should include custom method', async () => {
      const schedule = await collection.create({
        agentType: 'Praeco',
        cron: '0 2 * * *',
        method: 'scrape',
      });

      expect(schedule.getDescription()).toBe('Praeco.scrape() @ 0 2 * * *');
    });
  });
});

describe('AgentScheduleCollection', () => {
  let collection: AgentScheduleCollection;
  let db: Awaited<ReturnType<typeof getDatabase>>;

  beforeEach(async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });

    await db.query(`
      CREATE TABLE IF NOT EXISTS _smrt_agent_schedules (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        context TEXT,
        agent_type TEXT NOT NULL,
        agent_id TEXT,
        agent_config TEXT DEFAULT '{}',
        cron TEXT NOT NULL,
        timezone TEXT DEFAULT 'UTC',
        enabled INTEGER DEFAULT 1,
        status TEXT DEFAULT 'active',
        last_run DATETIME,
        next_run DATETIME,
        last_status TEXT,
        last_error TEXT,
        run_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        failure_count INTEGER DEFAULT 0,
        max_concurrent INTEGER DEFAULT 1,
        running_count INTEGER DEFAULT 0,
        timeout INTEGER DEFAULT 3600000,
        method TEXT DEFAULT 'run',
        method_args TEXT DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(slug, context)
      )
    `);

    collection = await AgentScheduleCollection.create({
      db: { type: 'sqlite', url: ':memory:' },
    });
    (collection as unknown as { _db: typeof db })._db = db;
  });

  describe('listByStatus()', () => {
    it('should list schedules by status', async () => {
      const s1 = await collection.create({
        agentType: 'Agent1',
        cron: '0 * * * *',
      });
      s1.status = 'active';
      await s1.save();

      const s2 = await collection.create({
        agentType: 'Agent2',
        cron: '0 * * * *',
      });
      s2.status = 'paused';
      await s2.save();

      const active = await collection.listByStatus('active');
      expect(active).toHaveLength(1);
      expect(active[0].agentType).toBe('Agent1');
    });
  });

  describe('listDue()', () => {
    it('should list schedules that are due', async () => {
      const past = new Date(Date.now() - 60000);
      const future = new Date(Date.now() + 60000);

      const s1 = await collection.create({
        agentType: 'Agent1',
        cron: '0 * * * *',
      });
      s1.nextRun = past;
      await s1.save();

      const s2 = await collection.create({
        agentType: 'Agent2',
        cron: '0 * * * *',
      });
      s2.nextRun = future;
      await s2.save();

      const due = await collection.listDue();
      expect(due).toHaveLength(1);
      expect(due[0].agentType).toBe('Agent1');
    });
  });

  describe('listByAgentType()', () => {
    it('should list schedules for agent type', async () => {
      const s1 = await collection.create({
        agentType: 'Praeco',
        cron: '0 2 * * *',
      });
      await s1.save();

      const s2 = await collection.create({
        agentType: 'Caelus',
        cron: '0 4 * * *',
      });
      await s2.save();

      const praeco = await collection.listByAgentType('Praeco');
      expect(praeco).toHaveLength(1);
      expect(praeco[0].agentType).toBe('Praeco');
    });

    it('should exclude disabled by default', async () => {
      const s1 = await collection.create({
        agentType: 'Praeco',
        cron: '0 2 * * *',
      });
      s1.enabled = false;
      await s1.save();

      const result = await collection.listByAgentType('Praeco');
      expect(result).toHaveLength(0);
    });

    it('should include disabled when requested', async () => {
      const s1 = await collection.create({
        agentType: 'Praeco',
        cron: '0 2 * * *',
      });
      s1.enabled = false;
      await s1.save();

      const result = await collection.listByAgentType('Praeco', {
        includeDisabled: true,
      });
      expect(result).toHaveLength(1);
    });
  });

  describe('stats()', () => {
    it('should return schedule statistics', async () => {
      const statuses: ScheduleStatus[] = [
        'active',
        'active',
        'paused',
        'disabled',
        'error',
      ];

      for (const status of statuses) {
        const s = await collection.create({
          agentType: 'Agent',
          cron: '0 * * * *',
        });
        s.status = status;
        s.enabled = status !== 'disabled';
        // For due calculation
        if (status === 'active') {
          s.nextRun = new Date(Date.now() - 60000); // Past
        }
        await s.save();
      }

      const stats = await collection.stats();
      expect(stats.total).toBe(5);
      expect(stats.active).toBe(2);
      expect(stats.paused).toBe(1);
      expect(stats.disabled).toBe(1);
      expect(stats.error).toBe(1);
      expect(stats.dueNow).toBe(2); // Both active schedules are due
    });
  });
});
