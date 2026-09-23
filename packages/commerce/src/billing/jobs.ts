/**
 * smrt-jobs integration for billing (#3060).
 *
 * A runtime holds live dependencies (the payment provider, the relationship
 * reader) that cannot be serialized into a job row, so jobs name a runtime
 * registered in this process and carry only plain arguments.
 */
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { type SmrtJob, SmrtJobCollection } from '@happyvertical/smrt-jobs';
import type { PeriodCloseResult } from './period-close.js';
import type { BillingRuntime } from './runtime.js';

const REGISTRY_KEY = Symbol.for(
  '@happyvertical/smrt-commerce:billing-runtimes',
);

function registry(): Map<string, BillingRuntime> {
  const holder = globalThis as unknown as Record<
    symbol,
    Map<string, BillingRuntime> | undefined
  >;
  let runtimes = holder[REGISTRY_KEY];
  if (!runtimes) {
    runtimes = new Map();
    holder[REGISTRY_KEY] = runtimes;
  }
  return runtimes;
}

/** Make a runtime available to billing jobs under `name`. */
export function registerBillingRuntime(
  name: string,
  runtime: BillingRuntime,
): void {
  if (!name) throw new Error('A billing runtime name is required.');
  registry().set(name, runtime);
}

export function unregisterBillingRuntime(name: string): void {
  registry().delete(name);
}

export function getBillingRuntime(name: string): BillingRuntime {
  const runtime = registry().get(name);
  if (!runtime) {
    throw new Error(`No billing runtime is registered as '${name}'.`);
  }
  return runtime;
}

function runtimeFrom(args: Record<string, unknown>): BillingRuntime {
  if (typeof args.runtime !== 'string') {
    throw new Error('Billing jobs require a runtime name.');
  }
  return getBillingRuntime(args.runtime);
}

function optionalDate(value: unknown, name: string): Date | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${name} must be an ISO date.`);
  }
  return date;
}

export async function runBillingPeriodCloseJob(
  args: Record<string, unknown>,
): Promise<PeriodCloseResult> {
  return runtimeFrom(args).closePeriod({
    periodStart: optionalDate(args.periodStart, 'periodStart'),
    periodEnd: optionalDate(args.periodEnd, 'periodEnd'),
  });
}

export async function runBillingEventsJob(
  args: Record<string, unknown>,
): Promise<{ processed: number }> {
  const limit = args.limit === undefined ? 25 : Number(args.limit);
  return { processed: await runtimeFrom(args).processEvents(limit) };
}

export interface EnqueueBillingJobOptions {
  /** Registered runtime name. */
  runtime: string;
  runAt?: Date;
  queue?: string;
  maxAttempts?: number;
}

function jobObjectType(): string {
  return (
    ObjectRegistry.getClass('BillingPeriodClose')?.qualifiedName ??
    '@happyvertical/smrt-commerce:BillingPeriodClose'
  );
}

async function enqueue(
  runtime: BillingRuntime,
  method: string,
  args: Record<string, unknown>,
  options: EnqueueBillingJobOptions,
): Promise<SmrtJob> {
  const jobs = await SmrtJobCollection.create({ db: runtime.db });
  return jobs.enqueueJob({
    tenantId: null,
    queue: options.queue ?? 'billing',
    objectType: jobObjectType(),
    objectId: null,
    method,
    args: { runtime: options.runtime, ...args },
    runAt: options.runAt,
    maxAttempts: options.maxAttempts ?? 5,
  });
}

/**
 * Queue a period close. Without a period the job closes the previous
 * calendar month when it runs, so enqueueing it daily is safe.
 */
export function enqueueBillingPeriodClose(
  options: EnqueueBillingJobOptions & { periodStart?: Date; periodEnd?: Date },
): Promise<SmrtJob> {
  const runtime = getBillingRuntime(options.runtime);
  return enqueue(
    runtime,
    'runPeriodClose',
    {
      ...(options.periodStart
        ? { periodStart: options.periodStart.toISOString() }
        : {}),
      ...(options.periodEnd
        ? { periodEnd: options.periodEnd.toISOString() }
        : {}),
    },
    options,
  );
}

/** Queue processing of received provider events. */
export function enqueueBillingEvents(
  options: EnqueueBillingJobOptions & { limit?: number },
): Promise<SmrtJob> {
  const runtime = getBillingRuntime(options.runtime);
  return enqueue(
    runtime,
    'processBillingEvents',
    options.limit ? { limit: options.limit } : {},
    options,
  );
}
