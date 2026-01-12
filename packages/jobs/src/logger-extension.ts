import type { Logger } from '@happyvertical/logger';

/**
 * Job context for logging
 */
export interface JobContext {
  jobId: string;
  attempt: number;
  queue: string;
  objectType: string;
  method: string;
}

/**
 * Logger extension that auto-injects job context into all log entries
 *
 * During job execution, all logs automatically include:
 * - jobId: The job's unique identifier
 * - attempt: Which attempt this is (1, 2, 3...)
 * - queue: Which queue the job is in
 * - objectType: The type of object being operated on
 * - method: The method being invoked
 */
export class JobContextLogger implements Logger {
  constructor(
    private readonly baseLogger: Logger,
    private readonly jobContext: JobContext,
  ) {}

  private addContext(data?: Record<string, unknown>): Record<string, unknown> {
    return {
      ...data,
      _job: {
        id: this.jobContext.jobId,
        attempt: this.jobContext.attempt,
        queue: this.jobContext.queue,
        objectType: this.jobContext.objectType,
        method: this.jobContext.method,
      },
    };
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.baseLogger.debug(message, this.addContext(data));
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.baseLogger.info(message, this.addContext(data));
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.baseLogger.warn(message, this.addContext(data));
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.baseLogger.error(message, this.addContext(data));
  }
}

export default JobContextLogger;
