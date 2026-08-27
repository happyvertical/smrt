import { describe, expect, it, vi } from 'vitest';
import {
  type ContentListJob,
  contentListJobAffectsQuery,
  createContentListJobController,
} from './content-list-runtime.js';

function job(overrides: Partial<ContentListJob> = {}): ContentListJob {
  return {
    jobId: 'job-1',
    actionId: 'review',
    submissionKey: 'review:row-1',
    status: 'running',
    target: { kind: 'rows', rowIds: ['row-1'] },
    ...overrides,
  };
}

describe('ContentList background jobs', () => {
  it('coalesces duplicate clicks into one submission', async () => {
    let resolve!: (value: ContentListJob) => void;
    const start = vi.fn(
      () =>
        new Promise<ContentListJob>((next) => {
          resolve = next;
        }),
    );
    const duplicate = vi.fn(async () => job({ jobId: 'duplicate' }));
    const controller = createContentListJobController();
    const submission = {
      actionId: 'review',
      submissionKey: 'review:row-1',
      target: { kind: 'rows' as const, rowIds: ['row-1'] },
    };

    const first = controller.submit(submission, start);
    const second = controller.submit(submission, duplicate);

    expect(start).toHaveBeenCalledTimes(1);
    expect(duplicate).not.toHaveBeenCalled();
    expect(controller.snapshot().pendingRowIds.has('row-1')).toBe(true);

    resolve(job());
    await expect(first).resolves.toMatchObject({ jobId: 'job-1' });
    await expect(second).resolves.toMatchObject({ jobId: 'job-1' });
  });

  it('keeps a rejected submission failed and retryable', async () => {
    const retry = vi.fn(async () => job({ jobId: 'job-2', status: 'running' }));
    const controller = createContentListJobController({ retry });

    await expect(
      controller.submit(
        {
          actionId: 'review',
          submissionKey: 'review:row-1',
          target: { kind: 'rows', rowIds: ['row-1'] },
        },
        async () => {
          throw new Error('worker unavailable');
        },
      ),
    ).rejects.toThrow('worker unavailable');

    const failed = controller.snapshot().jobs[0];
    expect(failed).toMatchObject({
      status: 'failed',
      error: 'worker unavailable',
    });
    const retryPromise = controller.retry(failed.jobId);
    expect(controller.canRetry?.(failed.jobId)).toBe(false);
    expect(controller.snapshot().jobs).toEqual([
      expect.objectContaining({ jobId: failed.jobId, status: 'failed' }),
      expect.objectContaining({ status: 'queued', error: undefined }),
    ]);
    await expect(retryPromise).resolves.toMatchObject({
      jobId: 'job-2',
      status: 'running',
    });
    expect(controller.snapshot().jobs).toEqual([
      expect.objectContaining({ jobId: failed.jobId, status: 'failed' }),
      expect.objectContaining({ jobId: 'job-2', status: 'running' }),
    ]);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('coalesces retries and never reopens the historical failure', async () => {
    let resolveRetry!: (value: ContentListJob) => void;
    const retry = vi.fn(
      () =>
        new Promise<ContentListJob>((resolve) => {
          resolveRetry = resolve;
        }),
    );
    const controller = createContentListJobController({ retry });
    controller.update(job({ status: 'failed', error: 'first failure' }));

    const first = controller.retry('job-1');
    const duplicate = controller.retry('job-1');
    expect(duplicate).toBe(first);
    expect(controller.canRetry?.('job-1')).toBe(false);

    resolveRetry(job({ jobId: 'job-2', status: 'running' }));
    await expect(first).resolves.toMatchObject({ jobId: 'job-2' });
    await expect(controller.retry('job-1')).rejects.toThrow(
      'already been retried',
    );
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('keeps a prior attempt terminal when its late success arrives during retry', async () => {
    let rejectRetry!: (error: Error) => void;
    const retry = vi.fn(
      () =>
        new Promise<ContentListJob>((_resolve, reject) => {
          rejectRetry = reject;
        }),
    );
    const controller = createContentListJobController({ retry });
    controller.update(job({ status: 'failed', error: 'first failure' }));

    const retryPromise = controller.retry('job-1');
    controller.update(job({ status: 'succeeded' }));

    expect(controller.snapshot().jobs).toEqual([
      expect.objectContaining({ jobId: 'job-1', status: 'failed' }),
      expect.objectContaining({
        jobId: expect.stringContaining('content-list:retry:'),
        status: 'queued',
      }),
    ]);

    rejectRetry(new Error('retry failed'));
    await expect(retryPromise).rejects.toThrow('retry failed');
    expect(controller.snapshot().jobs).toEqual([
      expect.objectContaining({ jobId: 'job-1', status: 'failed' }),
      expect.objectContaining({ status: 'failed', error: 'retry failed' }),
    ]);
    expect(controller.snapshot().jobs).not.toContainEqual(
      expect.objectContaining({ status: 'succeeded' }),
    );
  });

  it('ignores out-of-order progress after a terminal result', () => {
    const controller = createContentListJobController();
    controller.update(job({ status: 'succeeded' }));
    controller.update(job({ status: 'running', completed: 1, total: 2 }));
    controller.update(job({ status: 'failed', error: 'late failure' }));

    expect(controller.snapshot().jobs[0].status).toBe('succeeded');
    expect(controller.snapshot().pendingRowIds.size).toBe(0);
  });

  it('refreshes only a successful job for the visible rows or exact query', () => {
    const rows = new Set(['row-1']);
    expect(
      contentListJobAffectsQuery(job({ status: 'succeeded' }), 'query-a', rows),
    ).toBe(true);
    expect(
      contentListJobAffectsQuery(
        job({
          status: 'succeeded',
          target: { kind: 'rows', rowIds: ['row-2'] },
        }),
        'query-a',
        rows,
      ),
    ).toBe(false);
    expect(
      contentListJobAffectsQuery(
        job({
          status: 'succeeded',
          target: { kind: 'query', queryKey: 'query-b' },
        }),
        'query-a',
        rows,
      ),
    ).toBe(false);
    expect(
      contentListJobAffectsQuery(
        job({
          status: 'succeeded',
          target: { kind: 'query', queryKey: 'query-a' },
        }),
        'query-a',
        rows,
      ),
    ).toBe(true);
  });
});
