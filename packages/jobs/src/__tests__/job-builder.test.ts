import type { RetryStrategy, RetryStrategyConfig } from '@happyvertical/jobs';
import { describe, expect, it, vi } from 'vitest';
import {
  JobBuilder,
  type Priority,
  parseDelay,
  priorityToNumber,
} from '../job-builder.js';
import type { SmrtJobCollection } from '../smrt-job.js';

const sdk = vi.hoisted(() => ({ loads: 0 }));
vi.mock('@happyvertical/jobs', async (original) => {
  sdk.loads++;
  return original();
});

describe('JobBuilder utilities', () => {
  it('loads the SDK only for a default strategy at enqueue, preserving custom strategies', async () => {
    const enqueueJob = vi.fn().mockResolvedValue({ id: 'job-1' });
    const collection = { enqueueJob } as unknown as SmrtJobCollection;
    const config: RetryStrategyConfig = { type: 'linear', config: {} };
    const custom = { toConfig: () => config } as RetryStrategy;
    const builder = new JobBuilder('Widget', 'w1', 'run', {}, collection);
    expect(sdk.loads).toBe(0);
    await builder.retryStrategy(custom).enqueue();
    expect(sdk.loads).toBe(0);
    expect(enqueueJob.mock.calls[0][0].retryStrategy).toBe(config);

    await new JobBuilder('Widget', 'w2', 'run', {}, collection).enqueue();
    expect(sdk.loads).toBe(1);
    const { exponential } = await import('@happyvertical/jobs');
    expect(enqueueJob.mock.calls[1][0].retryStrategy).toEqual(
      exponential().toConfig(),
    );
  });

  describe('priorityToNumber', () => {
    it('converts string priorities to correct numbers', () => {
      expect(priorityToNumber('critical')).toBe(100);
      expect(priorityToNumber('high')).toBe(75);
      expect(priorityToNumber('normal')).toBe(50);
      expect(priorityToNumber('low')).toBe(25);
    });

    it('passes through numeric priorities', () => {
      expect(priorityToNumber(10)).toBe(10);
      expect(priorityToNumber(99)).toBe(99);
    });
  });

  describe('parseDelay', () => {
    it('parses milliseconds', () => {
      expect(parseDelay('100ms')).toBe(100);
      expect(parseDelay('1000ms')).toBe(1000);
    });

    it('parses seconds', () => {
      expect(parseDelay('1s')).toBe(1000);
      expect(parseDelay('30s')).toBe(30000);
    });

    it('parses minutes', () => {
      expect(parseDelay('1m')).toBe(60000);
      expect(parseDelay('5m')).toBe(300000);
    });

    it('parses hours', () => {
      expect(parseDelay('1h')).toBe(3600000);
      expect(parseDelay('2h')).toBe(7200000);
    });

    it('parses days', () => {
      expect(parseDelay('1d')).toBe(86400000);
    });

    it('handles numbers directly', () => {
      expect(parseDelay(5000)).toBe(5000);
    });

    it('throws on a non-finite numeric delay', () => {
      // A non-finite delay flows into `new Date(Date.now() + delay)`, persisting
      // an `Invalid Date` runAt that the claim query can never match (S3 #1401).
      expect(() => parseDelay(Number.NaN)).toThrow('Invalid delay value');
      expect(() => parseDelay(Number.POSITIVE_INFINITY)).toThrow(
        'Invalid delay value',
      );
      expect(() => parseDelay(Number.NEGATIVE_INFINITY)).toThrow(
        'Invalid delay value',
      );
    });

    it('throws error for invalid format', () => {
      expect(() => parseDelay('invalid')).toThrow('Invalid delay format');
      expect(() => parseDelay('abc123')).toThrow('Invalid delay format');
    });

    it('defaults to milliseconds when no unit provided', () => {
      expect(parseDelay('500')).toBe(500);
    });
  });
});
