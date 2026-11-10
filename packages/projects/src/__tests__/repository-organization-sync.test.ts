/**
 * Organization repository sync (smrt#4905): idempotency, archived, vanished,
 * throttle, tenant isolation. Real in-memory SQLite; the provider lister is
 * injected.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RepositoryCollection } from '../collections/Repositories';
import {
  defaultOrganizationRepositoryLister,
  type OrganizationRepositoryLister,
  type OrganizationRepositorySummary,
} from '../services/repository-organization-sync';

const summary = (
  name: string,
  over: Partial<OrganizationRepositorySummary> = {},
): OrganizationRepositorySummary => ({
  owner: 'acme',
  name,
  description: `${name} repo`,
  defaultBranch: 'main',
  url: `https://github.com/acme/${name}`,
  isPrivate: false,
  archived: false,
  pushedAt: '2026-11-01T10:00:00Z',
  openPullRequestCount: 2,
  latestRelease: {
    tag: 'v1.2.3',
    publishedAt: '2026-10-30T09:00:00Z',
    url: `https://github.com/acme/${name}/releases/tag/v1.2.3`,
  },
  ciState: 'success',
  ...over,
});

describe('RepositoryCollection.syncOrganization (#4905)', () => {
  let db: DatabaseInterface;
  let repos: RepositoryCollection;
  let listing: OrganizationRepositorySummary[];
  let lister: ReturnType<typeof vi.fn> & OrganizationRepositoryLister;
  let clock: Date;
  const base = () => ({
    owner: 'acme',
    tokenConfigKey: 'TEST_ORG_SYNC_TOKEN',
    lister,
    now: () => clock,
  });

  beforeEach(async () => {
    process.env.TEST_ORG_SYNC_TOKEN = 'read-only-token';
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    repos = await RepositoryCollection.create({ db });
    listing = [summary('alpha'), summary('beta')];
    lister = vi.fn(async () => ({
      repositories: listing,
    })) as unknown as typeof lister;
    clock = new Date('2026-11-10T12:00:00Z');
  });

  afterEach(async () => {
    disableTenancy();
    delete process.env.TEST_ORG_SYNC_TOKEN;
    if (db && typeof db.close === 'function') await db.close();
  });

  it('upserts every repo with activity and the token key, never the token', async () => {
    const result = await repos.syncOrganization(base());
    expect(result).toMatchObject({ listed: 2, created: 2, updated: 0 });
    expect(lister).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'acme', token: 'read-only-token' }),
    );
    const alpha = await repos.findByFullName('acme', 'alpha');
    expect(alpha).toMatchObject({
      fullName: 'acme/alpha',
      openPullRequestCount: 2,
      ciState: 'success',
      latestReleaseTag: 'v1.2.3',
      archived: false,
      missingSince: null,
      tokenConfigKey: 'TEST_ORG_SYNC_TOKEN',
    });
    expect(alpha?.lastPushedAt?.toISOString()).toBe('2026-11-01T10:00:00.000Z');
    expect(alpha?.latestReleaseDate?.toISOString()).toBe(
      '2026-10-30T09:00:00.000Z',
    );
  });

  it('is idempotent: a rerun updates in place and creates nothing', async () => {
    await repos.syncOrganization(base());
    clock = new Date('2026-11-10T13:00:00Z');
    const again = await repos.syncOrganization(base());
    expect(again).toMatchObject({ created: 0, updated: 2, vanished: 0 });
    expect(await repos.list({})).toHaveLength(2);
  });

  it('carries archived and hides it from listActive by default', async () => {
    listing = [summary('alpha'), summary('old', { archived: true })];
    const result = await repos.syncOrganization(base());
    expect(result.archived).toBe(1);
    expect((await repos.listActive()).map((r) => r.name)).toEqual(['alpha']);
    expect(await repos.listActive({ includeArchived: true })).toHaveLength(2);
  });

  it('marks vanished repos, restores them, and leaves other owners alone', async () => {
    await repos.getOrCreate('elsewhere', 'tool');
    await repos.syncOrganization(base());
    listing = [summary('alpha')];
    clock = new Date('2026-11-10T14:00:00Z');
    const gone = await repos.syncOrganization(base());
    expect(gone.vanished).toBe(1);
    const beta = await repos.findByFullName('acme', 'beta');
    expect(beta?.missingSince?.toISOString()).toBe('2026-11-10T14:00:00.000Z');
    expect(
      (await repos.findByFullName('elsewhere', 'tool'))?.missingSince,
    ).toBe(null);
    expect((await repos.listActive()).map((r) => r.name).sort()).toEqual([
      'alpha',
      'tool',
    ]);

    // Already-missing rows keep their original marker on the next run.
    clock = new Date('2026-11-10T15:00:00Z');
    expect((await repos.syncOrganization(base())).vanished).toBe(0);
    expect(
      (await repos.findByFullName('acme', 'beta'))?.missingSince?.toISOString(),
    ).toBe('2026-11-10T14:00:00.000Z');

    listing = [summary('alpha'), summary('beta')];
    clock = new Date('2026-11-10T16:00:00Z');
    const back = await repos.syncOrganization(base());
    expect(back.restored).toBe(1);
    expect((await repos.findByFullName('acme', 'beta'))?.missingSince).toBe(
      null,
    );
  });

  it('does not mark everything vanished on an empty listing', async () => {
    await repos.syncOrganization(base());
    listing = [];
    clock = new Date('2026-11-10T14:00:00Z');
    const result = await repos.syncOrganization(base());
    expect(result).toMatchObject({ reason: 'empty-listing', vanished: 0 });
    expect((await repos.listActive()).length).toBe(2);
  });

  it('honors the throttle unless forced', async () => {
    await repos.syncOrganization(base());
    clock = new Date('2026-11-10T12:01:00Z');
    const throttled = await repos.syncOrganization(base());
    expect(throttled).toMatchObject({ skipped: true, reason: 'throttled' });
    expect(lister).toHaveBeenCalledTimes(1);

    await repos.syncOrganization({ ...base(), force: true });
    expect(lister).toHaveBeenCalledTimes(2);

    clock = new Date('2026-11-10T12:30:00Z');
    expect((await repos.syncOrganization(base())).skipped).toBe(false);
  });

  it('fails clearly without a token and does not write', async () => {
    delete process.env.TEST_ORG_SYNC_TOKEN;
    await expect(repos.syncOrganization(base())).rejects.toThrow(
      /Token not found/,
    );
    expect(await repos.list({})).toHaveLength(0);
  });

  it('enforces one row per tenant/provider/owner/name', async () => {
    enableTenancy();
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (await repos.create({ owner: 'acme', name: 'dup' })).save();
      await expect(async () => {
        await (await repos.create({ owner: 'acme', name: 'dup' })).save();
      }).rejects.toThrow(/Unique constraint/);
    });
    // Same name under another tenant is a separate record.
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (await repos.create({ owner: 'acme', name: 'dup' })).save();
    });
  });

  it('isolates tenants: separate rows, separate vanish and throttle', async () => {
    enableTenancy();
    await repos.syncOrganization({ ...base(), tenantId: 'tenant-1' });
    // Tenant 2 is not throttled by tenant 1's sync and gets its own rows.
    const t2 = await repos.syncOrganization({
      ...base(),
      tenantId: 'tenant-2',
    });
    expect(t2).toMatchObject({ skipped: false, created: 2 });

    listing = [summary('alpha')];
    clock = new Date('2026-11-10T14:00:00Z');
    await repos.syncOrganization({ ...base(), tenantId: 'tenant-1' });

    const t1Rows = await withTenant({ tenantId: 'tenant-1' }, () =>
      repos.list({}),
    );
    const t2Rows = await withTenant({ tenantId: 'tenant-2' }, () =>
      repos.list({}),
    );
    expect(t1Rows.find((r) => r.name === 'beta')?.missingSince).not.toBe(null);
    expect(t2Rows.find((r) => r.name === 'beta')?.missingSince).toBe(null);
    expect(t1Rows.every((r) => r.tenantId === 'tenant-1')).toBe(true);
    expect(t2Rows.every((r) => r.tenantId === 'tenant-2')).toBe(true);
  });

  it('default lister reports a clear error when the SDK lacks the export', async () => {
    const sdk = (await import('@happyvertical/repos')) as Record<
      string,
      unknown
    >;
    if (typeof sdk.listOrganizationRepositories === 'function') return;
    await expect(
      defaultOrganizationRepositoryLister({ owner: 'acme', token: 't' }),
    ).rejects.toThrow(/0\.111\.11/);
  });
});
