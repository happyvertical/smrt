import { ObjectRegistry, type SmrtObject } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  JobBuilder,
  type Priority,
  parseDelay,
  priorityToNumber,
} from './job-builder.js';
import type { JobHandle } from './job-handle.js';
import { SmrtJobCollection } from './smrt-job.js';

/**
 * Options for the simple .bg() method
 */
export interface BgOptions {
  /** Queue name */
  queue?: string;
  /** Priority level */
  priority?: 'critical' | 'high' | 'normal' | 'low' | number;
  /** Delay before running (ms or string like '5m') */
  delay?: string | number;
  /** Maximum retries */
  retries?: number;
  /** Timeout in milliseconds */
  timeout?: number;
}

/**
 * Type for the extended SmrtObject with background job methods
 */
export interface BackgroundCapable {
  /**
   * Simple background job submission
   *
   * @param method - Method name to invoke
   * @param args - Arguments to pass to the method
   * @param options - Job options
   * @returns JobHandle for tracking the job
   *
   * @example
   * const handle = await doc.bg('generateSummary', { format: 'md' });
   */
  bg<T = unknown>(
    method: string,
    args?: Record<string, unknown>,
    options?: BgOptions,
  ): Promise<JobHandle<T>>;

  /**
   * Fluent job builder for advanced options
   *
   * @param method - Method name to invoke
   * @param args - Arguments to pass to the method
   * @returns JobBuilder for fluent configuration
   *
   * @example
   * const handle = await doc.background('generateSummary', { format: 'md' })
   *   .delay('5m')
   *   .retries(5)
   *   .priority('high')
   *   .enqueue();
   */
  background<T = unknown>(
    method: string,
    args?: Record<string, unknown>,
  ): JobBuilder<T>;
}

// Cache for job collections per database
const collectionCache = new WeakMap<DatabaseInterface, SmrtJobCollection>();

/**
 * Get or create a job collection for the given database
 */
async function getJobCollection(
  db: DatabaseInterface,
): Promise<SmrtJobCollection> {
  let collection = collectionCache.get(db);
  if (!collection) {
    collection = await SmrtJobCollection.create({
      db: { type: 'sqlite', url: ':memory:' }, // Placeholder
    });
    // Override internal db reference
    (collection as unknown as { _db: DatabaseInterface })._db = db;
    collectionCache.set(db, collection);
  }
  return collection;
}

function getObjectTypeName(instance: SmrtObject): string {
  const metaType = (instance as { _meta_type?: unknown })._meta_type;
  if (typeof metaType === 'string' && metaType.length > 0) {
    return metaType;
  }

  const className = instance.constructor.name;
  return ObjectRegistry.getClass(className)?.qualifiedName || className;
}

// Type for a SmrtObject constructor
type SmrtObjectConstructor = new (...args: any[]) => SmrtObject;
type BackgroundCapableConstructor<T extends SmrtObjectConstructor> = T & {
  new (...args: ConstructorParameters<T>): InstanceType<T> & BackgroundCapable;
};

function requireObjectDb(instance: SmrtObject): DatabaseInterface {
  const db = (instance as unknown as { _db?: DatabaseInterface })._db;
  if (!db) {
    throw new Error('Object not initialized. Call initialize() first.');
  }

  return db;
}

async function bgImpl<R = unknown>(
  this: SmrtObject,
  method: string,
  args: Record<string, unknown> = {},
  options: BgOptions = {},
): Promise<JobHandle<R>> {
  const db = requireObjectDb(this);
  const collection = await getJobCollection(db);
  const builder = new JobBuilder<R>(
    getObjectTypeName(this),
    this.id ?? null,
    method,
    args,
    collection,
  );

  if (options.queue) builder.queue(options.queue);
  if (options.priority) builder.priority(options.priority);
  if (options.delay) builder.delay(options.delay);
  if (options.retries !== undefined) builder.retries(options.retries);
  if (options.timeout) builder.timeout(options.timeout);

  return builder.enqueue();
}

function backgroundImpl<R = unknown>(
  this: SmrtObject,
  method: string,
  args: Record<string, unknown> = {},
): JobBuilder<R> {
  const db = requireObjectDb(this);
  const objectType = getObjectTypeName(this);
  const objectId = this.id ?? null;

  // Create a proxy builder that defers collection access until enqueue().
  const lazyBuilder = {
    _queue: 'default',
    _delay: 0,
    _retries: 3,
    _priority: 50,
    _timeout: 300000,
    _timeoutBehavior: 'fail' as 'fail' | 'kill' | 'warn',
    _retryStrategy: null as unknown,
    // `undefined` => fall through to JobBuilder's DEFAULT_TENANT_JOB_CAP. A
    // caller can override (incl. `0` to disable) via tenantJobCap() below.
    _tenantJobCap: undefined as number | undefined,

    queue(name: string) {
      this._queue = name;
      return this;
    },
    delay(d: string | number) {
      this._delay = parseDelay(d);
      return this;
    },
    runAt(date: Date) {
      this._delay = date.getTime() - Date.now();
      return this;
    },
    retries(count: number) {
      this._retries = count;
      return this;
    },
    retryStrategy(strategy: unknown) {
      this._retryStrategy = strategy;
      return this;
    },
    priority(level: Priority) {
      this._priority = priorityToNumber(level);
      return this;
    },
    timeout(ms: number) {
      this._timeout = ms;
      return this;
    },
    timeoutBehavior(behavior: 'fail' | 'kill' | 'warn') {
      this._timeoutBehavior = behavior;
      return this;
    },
    tenantJobCap(max: number) {
      this._tenantJobCap = max;
      return this;
    },
    async enqueue(): Promise<JobHandle<R>> {
      const collection = await getJobCollection(db);
      const builder = new JobBuilder<R>(
        objectType,
        objectId,
        method,
        args,
        collection,
      );

      builder.queue(this._queue);
      builder.delay(this._delay);
      builder.retries(this._retries);
      builder.priority(this._priority);
      builder.timeout(this._timeout);
      builder.timeoutBehavior(this._timeoutBehavior);
      // Only forward an explicit override; leaving it unset preserves the
      // JobBuilder default (DEFAULT_TENANT_JOB_CAP).
      if (this._tenantJobCap !== undefined) {
        builder.tenantJobCap(this._tenantJobCap);
      }

      if (this._retryStrategy) {
        builder.retryStrategy(
          this._retryStrategy as Parameters<typeof builder.retryStrategy>[0],
        );
      }

      return builder.enqueue();
    },
  };

  return lazyBuilder as unknown as JobBuilder<R>;
}

/**
 * Extend a SmrtObject class with background job methods
 *
 * @param BaseClass - The SmrtObject class to extend
 * @returns Extended class with .bg() and .background() methods
 *
 * @example
 * const BackgroundDocument = withBackgroundJobs(Document);
 * const doc = new BackgroundDocument({ ... });
 * const handle = await doc.bg('generateSummary', { format: 'md' });
 */
export function withBackgroundJobs<T extends SmrtObjectConstructor>(
  BaseClass: T,
): BackgroundCapableConstructor<T> {
  const prototype = BaseClass.prototype as SmrtObject &
    Partial<BackgroundCapable>;

  if (typeof prototype.bg !== 'function') {
    Object.defineProperty(prototype, 'bg', {
      value: bgImpl,
      writable: true,
      configurable: true,
    });
  }

  if (typeof prototype.background !== 'function') {
    Object.defineProperty(prototype, 'background', {
      value: backgroundImpl,
      writable: true,
      configurable: true,
    });
  }

  return BaseClass as BackgroundCapableConstructor<T>;
}

export default withBackgroundJobs;
