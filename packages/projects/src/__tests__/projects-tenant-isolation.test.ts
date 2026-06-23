/**
 * Regression tests for the tenant-global query helpers (#1600) in smrt-projects.
 *
 * Repository / Issue / PullRequest / Project are all
 * `@TenantScoped({ mode: 'optional' })`. Issue is the STI base and PullRequest
 * is an STI child on the shared Issue table; Repository and Project own their
 * own tables. Their collections used to expose:
 *   findGlobal()         → list({ where: { tenantId: null } })
 *   findWithGlobals(tid)  → raw `WHERE tenant_id = ? OR tenant_id IS NULL`
 * Under an ACTIVE tenant context with tenancy enabled (default `'throw'`
 * policy) BOTH throw: the explicit `tenant_id IS NULL` filter is flagged as an
 * isolation violation, and unflagged raw SQL on a tenant-scoped class is
 * blocked. `findWithGlobals` also trusted its caller-supplied `tenantId`.
 *
 * They now route through the shared `@happyvertical/smrt-tenancy` helpers, which
 * run raw with `{ allowRawOnTenantScoped: true }` and fail closed when an active
 * tenant context requests another tenant's rows (admin/system path keeps the
 * cross-tenant capability). Mirrors
 * `packages/ledgers/src/__tests__/ledgers-tenant-isolation.test.ts`.
 *
 * Real in-memory SQLite, no DB mocking, tenancy enabled under the default
 * `'throw'` policy, per `.claude/rules/testing.md`.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IssueCollection } from '../collections/Issues';
import { ProjectCollection } from '../collections/Projects';
import { PullRequestCollection } from '../collections/PullRequests';
import { RepositoryCollection } from '../collections/Repositories';
import { PullRequest } from '../models/PullRequest';

const sorted = (rows: Array<Record<string, any>>, field: string): string[] =>
  rows.map((r) => String(r[field] ?? '')).sort();

describe('projects tenant isolation (#1600)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy(); // default rawQueryPolicy: 'throw'
  });

  afterEach(async () => {
    disableTenancy();
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  it('RepositoryCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const repos = await RepositoryCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (await repos.create({ owner: 'acme', name: 't1-repo' })).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (await repos.create({ owner: 'acme', name: 't2-repo' })).save();
    });
    await withSystemContext(async () => {
      await (await repos.create({ owner: 'acme', name: 'g-repo' })).save();
    });

    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () => repos.findGlobal()),
        'name',
      ),
    ).toEqual(['g-repo']);
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          repos.findWithGlobals('tenant-1'),
        ),
        'name',
      ),
    ).toEqual(['g-repo', 't1-repo']);
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        repos.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);
    expect(
      sorted(
        await withSystemContext(() => repos.findWithGlobals('tenant-2')),
        'name',
      ),
    ).toEqual(['g-repo', 't2-repo']);
  });

  it('IssueCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const issues = await IssueCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (
        await issues.create({
          repositoryId: 'repo-1',
          number: 1,
          title: 't1-issue',
        })
      ).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (
        await issues.create({
          repositoryId: 'repo-1',
          number: 2,
          title: 't2-issue',
        })
      ).save();
    });
    await withSystemContext(async () => {
      await (
        await issues.create({
          repositoryId: 'repo-1',
          number: 3,
          title: 'g-issue',
        })
      ).save();
    });

    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () => issues.findGlobal()),
        'title',
      ),
    ).toEqual(['g-issue']);
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          issues.findWithGlobals('tenant-1'),
        ),
        'title',
      ),
    ).toEqual(['g-issue', 't1-issue']);
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        issues.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);
    expect(
      sorted(
        await withSystemContext(() => issues.findWithGlobals('tenant-2')),
        'title',
      ),
    ).toEqual(['g-issue', 't2-issue']);
  });

  it('PullRequestCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const prs = await PullRequestCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (
        await prs.create({ repositoryId: 'repo-1', number: 1, title: 't1-pr' })
      ).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (
        await prs.create({ repositoryId: 'repo-1', number: 2, title: 't2-pr' })
      ).save();
    });
    await withSystemContext(async () => {
      await (
        await prs.create({ repositoryId: 'repo-1', number: 3, title: 'g-pr' })
      ).save();
    });

    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () => prs.findGlobal()),
        'title',
      ),
    ).toEqual(['g-pr']);
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          prs.findWithGlobals('tenant-1'),
        ),
        'title',
      ),
    ).toEqual(['g-pr', 't1-pr']);
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        prs.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);
    expect(
      sorted(
        await withSystemContext(() => prs.findWithGlobals('tenant-2')),
        'title',
      ),
    ).toEqual(['g-pr', 't2-pr']);
  });

  it('ProjectCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const projects = await ProjectCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (
        await projects.create({ projectId: 'p1', title: 't1-project' })
      ).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (
        await projects.create({ projectId: 'p2', title: 't2-project' })
      ).save();
    });
    await withSystemContext(async () => {
      await (
        await projects.create({ projectId: 'pg', title: 'g-project' })
      ).save();
    });

    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () => projects.findGlobal()),
        'title',
      ),
    ).toEqual(['g-project']);
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          projects.findWithGlobals('tenant-1'),
        ),
        'title',
      ),
    ).toEqual(['g-project', 't1-project']);
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        projects.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);
    expect(
      sorted(
        await withSystemContext(() => projects.findWithGlobals('tenant-2')),
        'title',
      ),
    ).toEqual(['g-project', 't2-project']);
  });

  // PullRequest is an STI child sharing the `issues` table with base Issue rows.
  // The STI-child collection must auto-scope by `_meta_type` (getStiChildMetaType)
  // so its tenant-global helpers never surface sibling base Issue rows, while the
  // base IssueCollection legitimately spans both subtypes. (#1600)
  it('PullRequestCollection scopes to its _meta_type — no sibling Issue rows; IssueCollection spans both', async () => {
    const issues = await IssueCollection.create({ db });
    const prs = await PullRequestCollection.create({ db });

    // Seed a base Issue and a PullRequest in the SAME table, both tenant-1 and
    // global, so a missing `_meta_type` scope would surface the sibling Issue.
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (
        await issues.create({
          repositoryId: 'repo-1',
          number: 10,
          title: 't1-issue',
        })
      ).save();
      await (
        await prs.create({ repositoryId: 'repo-1', number: 11, title: 't1-pr' })
      ).save();
    });
    await withSystemContext(async () => {
      await (
        await issues.create({
          repositoryId: 'repo-1',
          number: 20,
          title: 'g-issue',
        })
      ).save();
      await (
        await prs.create({ repositoryId: 'repo-1', number: 21, title: 'g-pr' })
      ).save();
    });

    // Child collection: globals scoped to PullRequest only (no sibling Issue).
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () => prs.findGlobal()),
        'title',
      ),
    ).toEqual(['g-pr']);
    expect(
      (
        await withTenant({ tenantId: 'tenant-1' }, () => prs.findGlobal())
      ).every((p) => p instanceof PullRequest),
    ).toBe(true);
    // Child collection: tenant + globals, still scoped to PullRequest only.
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          prs.findWithGlobals('tenant-1'),
        ),
        'title',
      ),
    ).toEqual(['g-pr', 't1-pr']);

    // Base collection spans BOTH subtypes (Issue + PullRequest) for the tenant
    // plus globals — but never crosses tenants.
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () => issues.findGlobal()),
        'title',
      ),
    ).toEqual(['g-issue', 'g-pr']);
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          issues.findWithGlobals('tenant-1'),
        ),
        'title',
      ),
    ).toEqual(['g-issue', 'g-pr', 't1-issue', 't1-pr']);
  });
});
