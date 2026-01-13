import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type JobStatus, SmrtJob, SmrtJobCollection } from '../smrt-job.js';

describe('SmrtJob', () => {
  let collection: SmrtJobCollection;

  beforeEach(async () => {
    const db = await getDatabase({ type: 'sqlite', url: ':memory:' });

    // Create jobs table
    await db.query(`
      CREATE TABLE IF NOT EXISTS _smrt_jobs (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        context TEXT,
        queue TEXT DEFAULT 'default',
        object_type TEXT NOT NULL,
        object_id TEXT,
        method TEXT NOT NULL,
        args TEXT DEFAULT '{}',
        run_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        priority INTEGER DEFAULT 50,
        status TEXT DEFAULT 'pending',
        attempts INTEGER DEFAULT 0,
        max_attempts INTEGER DEFAULT 3,
        timeout INTEGER DEFAULT 300000,
        timeout_behavior TEXT DEFAULT 'fail',
        started_at DATETIME,
        completed_at DATETIME,
        last_error TEXT,
        result_pointer TEXT,
        retry_strategy TEXT DEFAULT '{}',
        worker_id TEXT,
        worker_heartbeat DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(slug, context)
      )
    `);

    collection = await SmrtJobCollection.create({
      db: { type: 'sqlite', url: ':memory:' },
    });
    // Override internal db
    (collection as unknown as { _db: typeof db })._db = db;
  });

  afterEach(async () => {
    // Cleanup
  });

  describe('create and save', () => {
    it('should create a job with default values', async () => {
      const job = await collection.create({
        objectType: 'Document',
        method: 'generateSummary',
      });
      await job.save();

      expect(job.id).toBeDefined();
      expect(job.queue).toBe('default');
      expect(job.status).toBe('pending');
      expect(job.priority).toBe(50);
      expect(job.maxAttempts).toBe(3);
    });

    it('should create a job with custom values', async () => {
      const job = await collection.create({
        objectType: 'Document',
        objectId: 'doc-123',
        method: 'generateSummary',
        args: { format: 'md' },
        queue: 'summaries',
        priority: 75,
        maxAttempts: 5,
        timeout: 600000,
      });
      await job.save();

      expect(job.objectType).toBe('Document');
      expect(job.objectId).toBe('doc-123');
      expect(job.method).toBe('generateSummary');
      expect(job.args).toEqual({ format: 'md' });
      expect(job.queue).toBe('summaries');
      expect(job.priority).toBe(75);
      expect(job.maxAttempts).toBe(5);
      expect(job.timeout).toBe(600000);
    });
  });

  describe('retry()', () => {
    it('should reset job for retry', async () => {
      const job = await collection.create({
        objectType: 'Document',
        method: 'process',
      });
      job.status = 'failed';
      job.attempts = 2;
      job.lastError = 'Network error';
      job.startedAt = new Date();
      await job.save();

      await job.retry();

      expect(job.status).toBe('pending');
      expect(job.attempts).toBe(0);
      expect(job.lastError).toBeNull();
      expect(job.startedAt).toBeNull();
    });

    it('should throw error when retrying completed job', async () => {
      const job = await collection.create({
        objectType: 'Document',
        method: 'process',
      });
      job.status = 'completed';
      await job.save();

      await expect(job.retry()).rejects.toThrow('Cannot retry a completed job');
    });
  });

  describe('cancel()', () => {
    it('should cancel a pending job', async () => {
      const job = await collection.create({
        objectType: 'Document',
        method: 'process',
      });
      await job.save();

      await job.cancel();

      expect(job.status).toBe('cancelled');
      expect(job.completedAt).toBeInstanceOf(Date);
    });

    it('should throw error when cancelling completed job', async () => {
      const job = await collection.create({
        objectType: 'Document',
        method: 'process',
      });
      job.status = 'completed';
      await job.save();

      await expect(job.cancel()).rejects.toThrow(
        'Cannot cancel job with status: completed',
      );
    });
  });

  describe('getDescription()', () => {
    it('should return description with object ID', async () => {
      const job = await collection.create({
        objectType: 'Document',
        objectId: 'doc-123',
        method: 'generateSummary',
      });

      expect(job.getDescription()).toBe('Document#doc-123.generateSummary()');
    });

    it('should return description without object ID', async () => {
      const job = await collection.create({
        objectType: 'Document',
        method: 'generateSummary',
      });

      expect(job.getDescription()).toBe('Document.generateSummary()');
    });
  });
});

describe('SmrtJobCollection', () => {
  let collection: SmrtJobCollection;
  let db: Awaited<ReturnType<typeof getDatabase>>;

  beforeEach(async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });

    // Create jobs table
    await db.query(`
      CREATE TABLE IF NOT EXISTS _smrt_jobs (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        context TEXT,
        queue TEXT DEFAULT 'default',
        object_type TEXT NOT NULL,
        object_id TEXT,
        method TEXT NOT NULL,
        args TEXT DEFAULT '{}',
        run_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        priority INTEGER DEFAULT 50,
        status TEXT DEFAULT 'pending',
        attempts INTEGER DEFAULT 0,
        max_attempts INTEGER DEFAULT 3,
        timeout INTEGER DEFAULT 300000,
        timeout_behavior TEXT DEFAULT 'fail',
        started_at DATETIME,
        completed_at DATETIME,
        last_error TEXT,
        result_pointer TEXT,
        retry_strategy TEXT DEFAULT '{}',
        worker_id TEXT,
        worker_heartbeat DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(slug, context)
      )
    `);

    collection = await SmrtJobCollection.create({
      db: { type: 'sqlite', url: ':memory:' },
    });
    (collection as unknown as { _db: typeof db })._db = db;
  });

  describe('listByStatus()', () => {
    it('should list jobs by single status', async () => {
      const job1 = await collection.create({
        objectType: 'Doc',
        method: 'process',
      });
      job1.status = 'pending';
      await job1.save();

      const job2 = await collection.create({
        objectType: 'Doc',
        method: 'process',
      });
      job2.status = 'completed';
      await job2.save();

      const pending = await collection.listByStatus('pending');
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe(job1.id);
    });

    it('should list jobs by multiple statuses', async () => {
      const job1 = await collection.create({
        objectType: 'Doc',
        method: 'process',
      });
      job1.status = 'pending';
      await job1.save();

      const job2 = await collection.create({
        objectType: 'Doc',
        method: 'process',
      });
      job2.status = 'failed';
      await job2.save();

      const jobs = await collection.listByStatus(['pending', 'failed']);
      expect(jobs).toHaveLength(2);
    });
  });

  describe('listReady()', () => {
    it('should list pending jobs ready to run', async () => {
      const now = new Date();
      const past = new Date(now.getTime() - 60000);
      const future = new Date(now.getTime() + 60000);

      const job1 = await collection.create({
        objectType: 'Doc',
        method: 'process',
        runAt: past,
      });
      await job1.save();

      const job2 = await collection.create({
        objectType: 'Doc',
        method: 'process',
        runAt: future,
      });
      await job2.save();

      const ready = await collection.listReady();
      expect(ready).toHaveLength(1);
      expect(ready[0].id).toBe(job1.id);
    });

    it('should filter by queues', async () => {
      const job1 = await collection.create({
        objectType: 'Doc',
        method: 'process',
        queue: 'high-priority',
      });
      await job1.save();

      const job2 = await collection.create({
        objectType: 'Doc',
        method: 'process',
        queue: 'default',
      });
      await job2.save();

      const ready = await collection.listReady({
        queues: ['high-priority'],
      });
      expect(ready).toHaveLength(1);
      expect(ready[0].queue).toBe('high-priority');
    });
  });

  describe('stats()', () => {
    it('should return job statistics', async () => {
      const statuses: JobStatus[] = [
        'pending',
        'pending',
        'running',
        'completed',
        'completed',
        'completed',
        'failed',
      ];

      for (const status of statuses) {
        const job = await collection.create({
          objectType: 'Doc',
          method: 'process',
        });
        job.status = status;
        await job.save();
      }

      const stats = await collection.stats();
      expect(stats.pending).toBe(2);
      expect(stats.running).toBe(1);
      expect(stats.completed).toBe(3);
      expect(stats.failed).toBe(1);
      expect(stats.cancelled).toBe(0);
    });

    it('should filter by queue', async () => {
      const job1 = await collection.create({
        objectType: 'Doc',
        method: 'process',
        queue: 'summaries',
      });
      job1.status = 'completed';
      await job1.save();

      const job2 = await collection.create({
        objectType: 'Doc',
        method: 'process',
        queue: 'default',
      });
      job2.status = 'pending';
      await job2.save();

      const stats = await collection.stats('summaries');
      expect(stats.completed).toBe(1);
      expect(stats.pending).toBe(0);
    });
  });

  describe('cleanup()', () => {
    it('should delete old completed jobs', async () => {
      const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000); // 8 days ago
      const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000); // 1 day ago

      const oldJob = await collection.create({
        objectType: 'Doc',
        method: 'process',
      });
      oldJob.status = 'completed';
      oldJob.completedAt = oldDate;
      await oldJob.save();

      const recentJob = await collection.create({
        objectType: 'Doc',
        method: 'process',
      });
      recentJob.status = 'completed';
      recentJob.completedAt = recentDate;
      await recentJob.save();

      const deleted = await collection.cleanup({
        completedBefore: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // 7 days ago
      });

      expect(deleted).toBe(1);

      const remaining = await collection.list({});
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(recentJob.id);
    });
  });
});
