import type { JobStatus, SmrtJob, SmrtJobCollection } from './smrt-job.js';

/**
 * Options for waiting on a job
 */
export interface WaitOptions {
  /** Maximum time to wait in milliseconds */
  timeout?: number;
  /** Polling interval in milliseconds */
  pollInterval?: number;
}

/**
 * Result from a completed job
 */
export interface JobResult<T = unknown> {
  /** Whether the job completed successfully */
  success: boolean;
  /** The result data (if successful) */
  result?: T;
  /** Error message (if failed) */
  error?: string;
  /** Pointer to where the full result is stored */
  resultPointer?: string | null;
}

/**
 * Handle for tracking and managing a background job
 *
 * This provides a convenient interface for:
 * - Checking job status
 * - Waiting for completion
 * - Canceling the job
 * - Retrying failed jobs
 */
export class JobHandle<T = unknown> {
  private readonly collection: SmrtJobCollection;

  constructor(
    public readonly id: string,
    collection: SmrtJobCollection,
  ) {
    this.collection = collection;
  }

  /**
   * Get the current job status
   */
  async status(): Promise<JobStatus> {
    const job = await this.getJob();
    return job.status;
  }

  /**
   * Get the full job object
   */
  async getJob(): Promise<SmrtJob> {
    const job = await this.collection.get({ id: this.id });
    if (!job) {
      throw new Error(`Job not found: ${this.id}`);
    }
    return job;
  }

  /**
   * Wait for the job to complete
   *
   * @param options - Wait configuration
   * @returns The job result
   * @throws Error if the job fails or times out
   */
  async wait(options: WaitOptions = {}): Promise<JobResult<T>> {
    const { timeout = 60000, pollInterval = 100 } = options;
    const startTime = Date.now();

    while (true) {
      const job = await this.getJob();

      if (job.status === 'completed') {
        return {
          success: true,
          resultPointer: job.resultPointer,
        };
      }

      if (job.status === 'failed') {
        return {
          success: false,
          error: job.lastError ?? 'Job failed',
        };
      }

      if (job.status === 'cancelled') {
        return {
          success: false,
          error: 'Job was cancelled',
        };
      }

      // Check timeout
      if (Date.now() - startTime >= timeout) {
        throw new Error(`Timeout waiting for job ${this.id}`);
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  }

  /**
   * Cancel the job
   */
  async cancel(): Promise<void> {
    const job = await this.getJob();
    await job.cancel();
  }

  /**
   * Retry a failed job
   */
  async retry(): Promise<void> {
    const job = await this.getJob();
    await job.retry();
  }

  /**
   * Check if the job is still running
   */
  async isRunning(): Promise<boolean> {
    const status = await this.status();
    return status === 'pending' || status === 'running';
  }

  /**
   * Check if the job has completed (successfully or not)
   */
  async isDone(): Promise<boolean> {
    const status = await this.status();
    return (
      status === 'completed' || status === 'failed' || status === 'cancelled'
    );
  }
}

export default JobHandle;
