/**
 * Mail sync as an idempotent background job (Epic I, #5130).
 *
 * The job is `EmailAccount.syncChanges()` on one account, run by the
 * `@happyvertical/smrt-jobs` TaskRunner. One account has one lane: the job is
 * deduplicated per tenant and account, so asking twice while a run is pending
 * or running returns the same job. Runs are at-least-once and safe to repeat:
 * the change-feed cursor only moves after a batch is applied.
 *
 * `@happyvertical/smrt-jobs` is a regular dependency, loaded lazily on first use. A host
 * that schedules mail sync installs it and runs a TaskRunner on the
 * {@link MAIL_SYNC_QUEUE} queue (and calls these helpers from its scheduler).
 *
 * @packageDocumentation
 */

import { ObjectRegistry } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { MailSyncOptions } from './mail-sync.js';
import type { EmailAccount } from './models/EmailAccount';

/** Queue the mail sync jobs run on. */
export const MAIL_SYNC_QUEUE = 'mail-sync';

/** Providers whose server offers the change feed. */
export const CHANGE_FEED_PROVIDERS: readonly string[] = ['jmap'];

export interface EnqueueMailSyncOptions extends MailSyncOptions {
  /** When to run. Default: now. */
  runAt?: Date;
  /** Job priority (higher runs sooner). */
  priority?: number;
  /** Attempts before the job fails for good. Default 3. */
  maxAttempts?: number;
  /** Job timeout in milliseconds. Default 15 minutes. */
  timeout?: number;
}

/** The dedupe key that makes one account one lane. */
export function mailSyncDedupeKey(accountId: string): string {
  return `mail-sync:${accountId}`;
}

function accountClassName(): string {
  const registered =
    ObjectRegistry.getClass('EmailAccount') ??
    ObjectRegistry.getClassByQualifiedName(
      '@happyvertical/smrt-messages:EmailAccount',
    );
  return registered?.qualifiedName ?? registered?.name ?? 'EmailAccount';
}

/**
 * Queue a sync of one account. Returns the queued (or already pending/running)
 * job, or null when the account is closed to sync (inactive, needing
 * reconnection, no change feed): nothing is queued for it.
 */
export async function enqueueMailSync(
  account: EmailAccount,
  options: EnqueueMailSyncOptions = {},
) {
  if (!account.id) throw new Error('enqueueMailSync needs a persisted account');
  if (!account.isActive || account.needsReconnect) return null;
  if (!CHANGE_FEED_PROVIDERS.includes(account.providerType)) return null;
  const { SmrtJobCollection } = await import('@happyvertical/smrt-jobs');
  const db = account.db as DatabaseInterface;
  const jobs = await SmrtJobCollection.create({ db });
  const args: Record<string, unknown> = {};
  if (options.limit !== undefined) args.limit = options.limit;
  if (options.maxBatches !== undefined) args.maxBatches = options.maxBatches;
  if (options.since !== undefined) {
    args.since = options.since ? new Date(options.since).toISOString() : null;
  }
  return jobs.enqueueJob({
    dedupeKey: mailSyncDedupeKey(account.id),
    tenantId: account.tenantId ?? null,
    queue: MAIL_SYNC_QUEUE,
    objectType: accountClassName(),
    objectId: account.id,
    method: 'syncChanges',
    // The runner calls the method with this object as its one argument.
    args,
    runAt: options.runAt,
    priority: options.priority,
    maxAttempts: options.maxAttempts ?? 3,
    timeout: options.timeout ?? 15 * 60 * 1000,
  });
}

/**
 * Queue a sync for every active account that is due (never synced, or last
 * synced at least its `syncIntervalMinutes` ago). Safe to call on every
 * scheduler tick: accounts that already have a job queued are not duplicated.
 */
export async function enqueueDueMailSyncs(
  accounts: EmailAccount[],
  options: EnqueueMailSyncOptions & { now?: Date } = {},
): Promise<string[]> {
  const now = (options.now ?? new Date()).getTime();
  const queued: string[] = [];
  for (const account of accounts) {
    const due =
      !account.lastSyncAt ||
      now - account.lastSyncAt.getTime() >=
        (account.syncIntervalMinutes || 0) * 60_000;
    if (!due) continue;
    const job = await enqueueMailSync(account, options);
    if (job?.id) queued.push(String(job.id));
  }
  return queued;
}
