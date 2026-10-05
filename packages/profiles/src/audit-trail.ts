import type { AuditEntry, AuditWriter } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { AuditLogCollection } from './collections/AuditLogCollection.js';
import { AuditLog } from './models/AuditLog.js';

/** Profiles owns audit persistence; core only owns the mutation contract. */
export function createAuditWriter(): AuditWriter {
  return async (entry: AuditEntry, db: DatabaseInterface) => {
    const log = new AuditLog({
      db,
      profileId: entry.actorId,
      onBehalfOfId: entry.onBehalfOfId,
      tenantId: entry.tenantId,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      source: entry.source ?? 'web',
      reason: entry.reason ?? '',
      changes: entry.changes,
    });
    await log.initialize();
    await log.save();
  };
}

export interface AuditFilter {
  profileId?: string;
  resourceType?: string;
  resourceId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

/** Consumer checks both audit permission and access to the referenced resource. */
export type AuthorizeAuditRead = (
  entry: AuditLog,
) => boolean | Promise<boolean>;

/** No generated read routes: consumers expose this fail-closed permission seam. */
export async function readAuditTrail(
  logs: AuditLogCollection,
  authorize: AuthorizeAuditRead,
  filter: AuditFilter = {},
): Promise<AuditLog[]> {
  if (typeof authorize !== 'function')
    throw new Error('Audit reads require consumer authorization');
  const limit = filter.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error('Audit limit must be an integer from 1 to 1000');
  }
  for (const date of [filter.from, filter.to]) {
    if (
      date !== undefined &&
      (!(date instanceof Date) || !Number.isFinite(date.getTime()))
    ) {
      throw new Error('Audit date filters must be valid Dates');
    }
  }
  if (filter.from && filter.to && filter.from > filter.to)
    throw new Error('Audit date range is reversed');
  const where: Record<string, unknown> = {};
  for (const key of ['profileId', 'resourceType', 'resourceId'] as const) {
    if (filter[key] !== undefined) where[key] = filter[key];
  }
  if (filter.from) where['occurredAt >='] = filter.from;
  if (filter.to) where['occurredAt <='] = filter.to;
  const candidates = await logs.list({
    where,
    orderBy: 'occurredAt DESC',
    limit,
  });
  const visible: AuditLog[] = [];
  for (const entry of candidates) {
    // A broken permission hook authorizes nothing; never return unfiltered data.
    try {
      if ((await authorize(entry)) === true) visible.push(entry);
    } catch {
      // Denied.
    }
  }
  return visible;
}

/** Explicit maintenance API. Scheduling and retention window belong to the consumer. */
export async function pruneAuditTrail(
  logs: AuditLogCollection,
  options: { maxAgeDays: number; now?: Date; batchSize?: number },
): Promise<number> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? 500;
  if (
    !Number.isFinite(options.maxAgeDays) ||
    options.maxAgeDays <= 0 ||
    !Number.isFinite(now.getTime()) ||
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 1000
  ) {
    throw new Error(
      'Audit retention requires a positive age and a batch size from 1 to 1000',
    );
  }
  const before = new Date(now.getTime() - options.maxAgeDays * 86_400_000);
  const rows = await logs.list({
    where: { 'occurredAt <': before },
    orderBy: 'occurredAt ASC',
    limit: batchSize,
  });
  let removed = 0;
  for (const row of rows) {
    if (row.id && (await logs.delete(row.id))) removed += 1;
  }
  return removed;
}
