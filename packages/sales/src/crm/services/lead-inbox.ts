/**
 * Public contracts and SQL-safe option normalization for the Lead inbox.
 * @packageDocumentation
 */

import type { Lead } from '../models/Lead.js';
import type { SalesActivity } from '../models/SalesActivity.js';
import type { SalesRepresentative } from '../models/SalesRepresentative.js';
import { LEAD_STATUSES, type LeadStatus } from '../types.js';

/** Stable inbox orderings supported on every SQL adapter. */
export type LeadInboxSort = 'created' | 'next_action' | 'name';

/** Filters and page bounds for `LeadCollection.listInbox()`. */
export interface LeadInboxOptions {
  status?: LeadStatus;
  ownerRepId?: string;
  unassigned?: boolean;
  overdue?: boolean;
  search?: string;
  sort?: LeadInboxSort;
  limit: number;
  offset: number;
  /** Evaluation instant for the overdue filter/count; defaults to now. */
  now?: Date;
}

/** Batched owner and next-action projection for one hydrated Lead. */
export interface LeadInboxItem {
  lead: Lead;
  owner: SalesRepresentative | null;
  nextAction: SalesActivity | null;
}

/** Counts used by the lifecycle and derived inbox tabs. */
export type LeadInboxStatusCounts = Record<
  LeadStatus | 'all' | 'unassigned' | 'overdue',
  number
>;

/** A page of hydrated Leads plus its batched relationship projection. */
export interface LeadInboxResult {
  leads: Lead[];
  items: LeadInboxItem[];
  total: number;
  statusCounts: LeadInboxStatusCounts;
}

export interface NormalizedLeadInboxOptions {
  status?: LeadStatus;
  ownerRepId?: string;
  unassigned: boolean;
  overdue: boolean;
  search?: string;
  sort: LeadInboxSort;
  limit: number;
  offset: number;
  now: Date;
}

const INBOX_SORTS = new Set<LeadInboxSort>(['created', 'next_action', 'name']);

/** Validate caller-controlled options before they reach SQL. */
export function normalizeLeadInboxOptions(
  options: LeadInboxOptions,
): NormalizedLeadInboxOptions {
  if (!options || typeof options !== 'object') {
    throw new Error('LeadCollection.listInbox: options are required');
  }
  if (
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 100
  ) {
    throw new Error(
      'LeadCollection.listInbox: limit must be an integer between 1 and 100',
    );
  }
  if (!Number.isSafeInteger(options.offset) || options.offset < 0) {
    throw new Error(
      'LeadCollection.listInbox: offset must be a non-negative integer',
    );
  }
  if (options.status !== undefined && !LEAD_STATUSES.includes(options.status)) {
    throw new Error(
      `LeadCollection.listInbox: unsupported status '${String(options.status)}'`,
    );
  }
  const sort = options.sort ?? 'created';
  if (!INBOX_SORTS.has(sort)) {
    throw new Error(
      `LeadCollection.listInbox: unsupported sort '${String(sort)}'`,
    );
  }
  if (
    options.ownerRepId !== undefined &&
    (typeof options.ownerRepId !== 'string' || !options.ownerRepId.trim())
  ) {
    throw new Error(
      'LeadCollection.listInbox: ownerRepId must be a non-empty string',
    );
  }
  if (options.search !== undefined && typeof options.search !== 'string') {
    throw new Error('LeadCollection.listInbox: search must be a string');
  }
  if (
    options.now !== undefined &&
    (!(options.now instanceof Date) || !Number.isFinite(options.now.getTime()))
  ) {
    throw new Error('LeadCollection.listInbox: now must be a valid Date');
  }

  const search = options.search?.trim();
  return {
    ...(options.status ? { status: options.status } : {}),
    ...(options.ownerRepId?.trim()
      ? { ownerRepId: options.ownerRepId.trim() }
      : {}),
    ...(search ? { search } : {}),
    unassigned: options.unassigned === true,
    overdue: options.overdue === true,
    sort,
    limit: options.limit,
    offset: options.offset,
    now: options.now ?? new Date(),
  };
}

/** Empty explicit count shape, including zero-count lifecycle tabs. */
export function emptyLeadInboxStatusCounts(): LeadInboxStatusCounts {
  return {
    all: 0,
    new: 0,
    working: 0,
    qualified: 0,
    disqualified: 0,
    merged: 0,
    unassigned: 0,
    overdue: 0,
  };
}
