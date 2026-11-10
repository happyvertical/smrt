/**
 * #3308: a handler error's own retry hints win over the job's retry strategy.
 * `retryable: false` fails the job at once; a positive `retryAfterMs` puts
 * the retry no earlier than the provider's reset time.
 */
import {
  getTestDatabase,
  ObjectRegistry,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { describe, expect, it } from 'vitest';
import { backgroundEligible } from '../background-policy.js';
import { createTaskRunner } from '../runner.js';
import { SmrtJobCollection } from '../smrt-job.js';

function hintedError(message: string, hints: Record<string, unknown>): Error {
  return Object.assign(new Error(message), hints);
}

@smrt()
class RetryHintProbe extends SmrtObject {
  @backgroundEligible()
  async notRetryable(): Promise<never> {
    throw hintedError('invalid api key', { retryable: false });
  }

  @backgroundEligible()
  async rateLimited(): Promise<never> {
    throw hintedError('rate limited', { retryAfterMs: 120_000 });
  }

  @backgroundEligible()
  async rateLimitedForAges(): Promise<never> {
    throw hintedError('quota exhausted', {
      retryAfterMs: 365 * 24 * 60 * 60 * 1000,
    });
  }
}

async function runOnce(method: string) {
  const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  const collection = await SmrtJobCollection.create({ db });
  const objectType =
    ObjectRegistry.getClass('RetryHintProbe')?.qualifiedName ||
    'RetryHintProbe';
  const job = await collection.create({
    objectType,
    method,
    args: {},
    maxAttempts: 3,
  });
  await job.save();

  const runner = createTaskRunner({ concurrency: 1, pollInterval: 10 });
  await runner.initialize(db);
  const outcome = new Promise<{ kind: string; delay?: number }>(
    (resolve, reject) => {
      runner.once('job:failed', () => resolve({ kind: 'failed' }));
      runner.once('job:retrying', (_job, _error, delay: number) =>
        resolve({ kind: 'retrying', delay }),
      );
      runner.once('runner:error', reject);
    },
  );
  const startedAt = Date.now();
  await runner.start();
  try {
    const result = await outcome;
    const persisted = await collection.get({ id: job.id ?? '' });
    return { result, persisted, startedAt };
  } finally {
    await runner.stop();
  }
}

describe('TaskRunner honours handler retry hints (#3308)', () => {
  it('fails a retryable: false error terminally on its first attempt', async () => {
    const { result, persisted } = await runOnce('notRetryable');
    expect(result.kind).toBe('failed');
    expect(persisted?.status).toBe('failed');
    expect(persisted?.attempts).toBe(1);
  });

  it('schedules the retry no earlier than retryAfterMs', async () => {
    const { result, persisted, startedAt } = await runOnce('rateLimited');
    expect(result.kind).toBe('retrying');
    expect(result.delay).toBeGreaterThanOrEqual(120_000);
    expect(persisted?.status).toBe('pending');
    expect(
      new Date(persisted?.runAt as Date | string).getTime(),
    ).toBeGreaterThanOrEqual(startedAt + 120_000);
  });

  it('bounds an excessive retryAfterMs', async () => {
    const { result } = await runOnce('rateLimitedForAges');
    expect(result.kind).toBe('retrying');
    expect(result.delay).toBe(24 * 60 * 60 * 1000);
  });
});
