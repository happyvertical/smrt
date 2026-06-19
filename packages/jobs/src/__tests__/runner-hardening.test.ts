import {
  getTestDatabase,
  ObjectRegistry,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { afterEach, describe, expect, it } from 'vitest';
import { backgroundEligible } from '../background-policy.js';
import { createTaskRunner } from '../runner.js';
import { SmrtJobCollection } from '../smrt-job.js';

@smrt()
class HardeningProbe extends SmrtObject {
  // Opt into the allowlist: only `safeMethod` is reachable from a job.
  @backgroundEligible()
  async safeMethod(): Promise<string> {
    return 'ok';
  }

  // Not on the allowlist — the runner must refuse to dispatch it.
  async dangerousMethod(): Promise<string> {
    return 'should never run';
  }

  // Throws a message containing a credential to exercise redaction.
  // Allowlisted so it actually runs (and fails) rather than being rejected
  // by the eligibility guard.
  @backgroundEligible()
  async leakyMethod(): Promise<never> {
    throw new Error('upstream auth failed for postgres://svc:topsecret@db/app');
  }
}

afterEach(() => {
  ObjectRegistry.clearCollectionCache?.();
});

describe('TaskRunner security hardening (S5 #1402)', () => {
  it('rejects a job whose method is not background-eligible', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const collection = await SmrtJobCollection.create({ db });
    const canonical =
      ObjectRegistry.getClass('HardeningProbe')?.qualifiedName ||
      'HardeningProbe';

    const job = await collection.create({
      objectType: canonical,
      method: 'dangerousMethod',
      args: {},
      maxAttempts: 1,
    });
    await job.save();

    const runner = createTaskRunner({ concurrency: 1, pollInterval: 10 });
    await runner.initialize(db);
    const failure = new Promise<Error>((resolve, reject) => {
      runner.once('job:failed', (_job, error) => resolve(error as Error));
      runner.once('runner:error', reject);
    });
    await runner.start();
    try {
      const error = await failure;
      expect(error.message).toContain('not background-eligible');
    } finally {
      await runner.stop();
    }

    const persisted = await collection.get({ id: job.id ?? '' });
    expect(persisted?.status).toBe('failed');
  });

  it('still runs an allowlisted method', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const collection = await SmrtJobCollection.create({ db });
    const canonical =
      ObjectRegistry.getClass('HardeningProbe')?.qualifiedName ||
      'HardeningProbe';

    const job = await collection.create({
      objectType: canonical,
      method: 'safeMethod',
      args: {},
    });
    await job.save();

    const runner = createTaskRunner({ concurrency: 1, pollInterval: 10 });
    await runner.initialize(db);
    const completion = new Promise<unknown>((resolve, reject) => {
      runner.once('job:completed', (_job, result) => resolve(result));
      runner.once('job:failed', (_job, error) => reject(error));
      runner.once('runner:error', reject);
    });
    await runner.start();
    try {
      const result = (await completion) as { result?: unknown };
      expect(result.result).toBe('ok');
    } finally {
      await runner.stop();
    }
  });

  it('redacts secrets from last_error before persisting a failed job', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const collection = await SmrtJobCollection.create({ db });
    const canonical =
      ObjectRegistry.getClass('HardeningProbe')?.qualifiedName ||
      'HardeningProbe';

    const job = await collection.create({
      objectType: canonical,
      method: 'leakyMethod',
      args: {},
      maxAttempts: 1,
    });
    await job.save();

    const runner = createTaskRunner({ concurrency: 1, pollInterval: 10 });
    await runner.initialize(db);
    const failure = new Promise<void>((resolve, reject) => {
      runner.once('job:failed', () => resolve());
      runner.once('runner:error', reject);
    });
    await runner.start();
    try {
      await failure;
    } finally {
      await runner.stop();
    }

    const row = await db.query(
      `SELECT last_error FROM _smrt_jobs WHERE id = ?`,
      job.id,
    );
    const lastError = (row.rows[0] as { last_error: string }).last_error;
    expect(lastError).not.toContain('topsecret');
    expect(lastError).toContain('***REDACTED***');
    expect(lastError).toContain('db');
  });
});
