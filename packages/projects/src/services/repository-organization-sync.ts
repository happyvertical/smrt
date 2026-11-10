/**
 * Organization-wide repository sync.
 *
 * Lists every repository of an owner through `@happyvertical/repos`, upserts
 * one tenant-scoped `Repository` row per listed repository, carries the
 * archived flag and the activity snapshot, and marks rows the provider no
 * longer lists. Idempotent, throttled, and safe for a scheduled job: it opens
 * no transaction (a nested `transaction()` takes a new pooled connection, not
 * a savepoint), so a failure leaves earlier rows saved and a rerun converges.
 */

import { withTenant } from '@happyvertical/smrt-tenancy';
import type { RepositoryCollection } from '../collections/Repositories';
import { SYNC_THROTTLE_MS } from '../constants';
import type { Repository } from '../models/Repository';
import { resolveRepositoryToken } from '../repository-token';
import type { RepositoryCiState, RepositoryProviderType } from '../types';

/** Latest release as reported by the organization listing. */
export interface OrganizationRepositoryRelease {
  tag: string;
  publishedAt: string | null;
  url: string;
}

/**
 * One repository of an organization listing. Structurally compatible with
 * `GitHubRepositorySummary` from `@happyvertical/repos`.
 */
export interface OrganizationRepositorySummary {
  owner: string;
  name: string;
  description: string | null;
  defaultBranch: string | null;
  url: string;
  isPrivate: boolean;
  archived: boolean;
  pushedAt: string | null;
  openPullRequestCount: number;
  latestRelease: OrganizationRepositoryRelease | null;
  ciState: 'success' | 'failure' | 'pending' | 'none';
}

/** Input handed to an {@link OrganizationRepositoryLister}. */
export interface OrganizationRepositoryListInput {
  owner: string;
  /** Resolved read-only token. */
  token: string;
  baseUrl?: string;
  signal?: AbortSignal;
}

/**
 * Lists the repositories of an organization. The default implementation is
 * `listOrganizationRepositories` from `@happyvertical/repos`; tests and
 * alternative providers inject their own.
 */
export type OrganizationRepositoryLister = (
  input: OrganizationRepositoryListInput,
) => Promise<{ repositories: OrganizationRepositorySummary[] }>;

/** Options for {@link syncOrganizationRepositories}. */
export interface SyncOrganizationOptions {
  /** Organization (or user) login to list. */
  owner: string;
  /** Env var / module config key holding a read-only token. Default `GITHUB_TOKEN`. */
  tokenConfigKey?: string;
  /** Provider. Organization listing is implemented for `github`. */
  providerType?: RepositoryProviderType;
  /** API base URL for self-hosted providers. */
  baseUrl?: string;
  /** Run inside this tenant's context. Defaults to the ambient context. */
  tenantId?: string;
  /** Ignore the {@link SYNC_THROTTLE_MS} throttle. */
  force?: boolean;
  /** Throttle window in ms. Defaults to {@link SYNC_THROTTLE_MS}. */
  throttleMs?: number;
  /** Lister override (tests, alternative providers). */
  lister?: OrganizationRepositoryLister;
  /** Clock override for tests. */
  now?: () => Date;
  signal?: AbortSignal;
}

/** Outcome of one organization sync. */
export interface SyncOrganizationResult {
  owner: string;
  /** True when no listing was made. */
  skipped: boolean;
  /** Why nothing was listed, or why vanish detection was withheld. */
  reason?: 'throttled' | 'empty-listing';
  /** Repositories in the provider listing. */
  listed: number;
  created: number;
  updated: number;
  /** Listed repositories currently archived. */
  archived: number;
  /** Rows newly marked missing by this run. */
  vanished: number;
  /** Rows that were missing and are listed again. */
  restored: number;
}

/**
 * Default lister: `listOrganizationRepositories` from `@happyvertical/repos`
 * (released in 0.111.11). Resolved lazily so older SDKs fail with a clear
 * message instead of an import error.
 */
export const defaultOrganizationRepositoryLister: OrganizationRepositoryLister =
  async (input) => {
    const sdk = (await import('@happyvertical/repos')) as unknown as {
      listOrganizationRepositories?: (options: {
        owner: string;
        token?: string;
        baseUrl?: string;
        signal?: AbortSignal;
      }) => Promise<{ repositories: OrganizationRepositorySummary[] }>;
    };
    if (typeof sdk.listOrganizationRepositories !== 'function') {
      throw new Error(
        'Organization sync requires @happyvertical/repos >= 0.111.11 (listOrganizationRepositories).',
      );
    }
    return sdk.listOrganizationRepositories({
      owner: input.owner,
      token: input.token,
      baseUrl: input.baseUrl,
      signal: input.signal,
    });
  };

const sameOwner = (a: string, b: string): boolean =>
  a.toLowerCase() === b.toLowerCase();

function toDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function applySummary(
  repo: Repository,
  s: OrganizationRepositorySummary,
  now: Date,
): void {
  repo.owner = s.owner;
  repo.name = s.name;
  repo.fullName = `${s.owner}/${s.name}`;
  repo.description = s.description ?? '';
  repo.defaultBranch = s.defaultBranch ?? repo.defaultBranch ?? 'main';
  repo.isPrivate = s.isPrivate;
  repo.url = s.url;
  repo.archived = s.archived;
  repo.lastPushedAt = toDate(s.pushedAt);
  repo.openPullRequestCount = s.openPullRequestCount;
  repo.ciState = s.ciState as RepositoryCiState;
  repo.latestReleaseTag = s.latestRelease?.tag ?? '';
  repo.latestReleaseDate = toDate(s.latestRelease?.publishedAt ?? null);
  repo.latestReleaseUrl = s.latestRelease?.url ?? '';
  repo.lastObservedAt = now;
  repo.lastSyncedAt = now;
  repo.missingSince = null;
}

/**
 * Sync every repository of an organization into `Repository` rows.
 *
 * - Upserts by (tenant, provider, owner, name); a rerun with an unchanged
 *   listing creates nothing.
 * - Sets `archived` and the activity snapshot from the listing.
 * - Rows of the same owner that the listing no longer contains get
 *   `missingSince`; they come back (cleared) if listed again. Repositories of
 *   other owners (added by name) are never touched. Vanish detection is
 *   withheld when the listing is empty, since that usually means lost access.
 * - Throttled by the newest `lastObservedAt` among the owner's rows.
 *
 * @param collection - Repository collection (tenant scope comes from context)
 * @param options - See {@link SyncOrganizationOptions}
 */
export async function syncOrganizationRepositories(
  collection: RepositoryCollection,
  options: SyncOrganizationOptions,
): Promise<SyncOrganizationResult> {
  if (options.tenantId) {
    return withTenant({ tenantId: options.tenantId }, () =>
      syncOrganizationRepositories(collection, {
        ...options,
        tenantId: undefined,
      }),
    );
  }

  const owner = options.owner?.trim();
  if (!owner) throw new Error('syncOrganization requires an owner');
  const providerType = options.providerType ?? 'github';
  if (providerType !== 'github' && !options.lister) {
    throw new Error(
      `Organization listing is not implemented for provider '${providerType}'.`,
    );
  }
  const clock = options.now ?? (() => new Date());
  const result: SyncOrganizationResult = {
    owner,
    skipped: false,
    listed: 0,
    created: 0,
    updated: 0,
    archived: 0,
    vanished: 0,
    restored: 0,
  };

  const existing = (await collection.list({ where: { providerType } })).filter(
    (r) => sameOwner(r.owner, owner),
  );

  const throttleMs = options.throttleMs ?? SYNC_THROTTLE_MS;
  if (!options.force && existing.length > 0) {
    const newest = Math.max(
      ...existing.map((r) => r.lastObservedAt?.getTime() ?? 0),
    );
    if (newest > 0 && clock().getTime() - newest < throttleMs) {
      return { ...result, skipped: true, reason: 'throttled' };
    }
  }

  const tokenConfigKey = options.tokenConfigKey ?? 'GITHUB_TOKEN';
  const lister = options.lister ?? defaultOrganizationRepositoryLister;
  const listing = await lister({
    owner,
    token: resolveRepositoryToken(tokenConfigKey),
    baseUrl: options.baseUrl,
    signal: options.signal,
  });

  const now = clock();
  const byKey = new Map(existing.map((r) => [`${r.owner}/${r.name}`, r]));
  const seen = new Set<string>();

  for (const summary of listing.repositories) {
    const key = `${summary.owner}/${summary.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let repo = byKey.get(key);
    if (repo) {
      if (repo.missingSince) result.restored++;
      applySummary(repo, summary, now);
      result.updated++;
    } else {
      repo = await collection.create({
        providerType,
        tokenConfigKey,
        baseUrl: options.baseUrl ?? '',
      });
      applySummary(repo, summary, now);
      result.created++;
    }
    if (summary.archived) result.archived++;
    await repo.save();
  }
  result.listed = seen.size;

  if (seen.size === 0) {
    return { ...result, reason: 'empty-listing' };
  }
  for (const repo of existing) {
    if (seen.has(`${repo.owner}/${repo.name}`) || repo.missingSince) continue;
    repo.missingSince = now;
    await repo.save();
    result.vanished++;
  }
  return result;
}
