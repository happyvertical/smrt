/**
 * Behavioural coverage for the smrt-projects collection query/discovery helpers.
 *
 * These exercise the provider-agnostic querying surface that the existing
 * tenant-isolation suite (`projects-tenant-isolation.test.ts`) does not touch:
 * the `findBy*` / `findOpen` / `findByNumber` filters, the SDK-backed
 * `discover()` sync path, and the `batchSync` / `syncAll` fan-out loops.
 *
 * Real in-memory SQLite, no DB mocking, per `.claude/rules/testing.md`. The only
 * mocked surface is the provider SDK client (`IRepository` / `IProject`), which
 * stands in for the external GitHub/GitLab API calls — injected via the model's
 * cached `_client` so `getClient()` never reaches the network. Methods that
 * delegate to a freshly-loaded model's client (e.g. `batchSync`, `getStatistics`)
 * are covered by spying that model's prototype, since the loaded instances have
 * no injected client.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IssueCollection } from '../collections/Issues';
import { ProjectCollection } from '../collections/Projects';
import { PullRequestCollection } from '../collections/PullRequests';
import { RepositoryCollection } from '../collections/Repositories';
import { Issue } from '../models/Issue';
import { Project } from '../models/Project';
import { PullRequest } from '../models/PullRequest';
import { Repository } from '../models/Repository';

/** A remote issue/PR record shaped like the provider SDK returns. */
function remoteIssue(over: Record<string, any> = {}): any {
  return {
    number: 1,
    id: 'node-1',
    title: 'Remote issue',
    body: 'body',
    state: 'open',
    author: { login: 'octocat' },
    labels: [{ name: 'bug' }],
    assignees: [{ login: 'octocat' }],
    commentsCount: 0,
    ...over,
  };
}

function remotePr(over: Record<string, any> = {}): any {
  return {
    ...remoteIssue(over),
    headRef: 'feature',
    baseRef: 'main',
    merged: false,
    mergedAt: null,
    mergeable: true,
    draft: false,
    ...over,
  };
}

/** Minimal fake provider client; only the methods a test exercises are set. */
function fakeRepoClient(over: Record<string, any> = {}): any {
  return {
    searchIssues: vi.fn(async () => []),
    getPullRequest: vi.fn(async () => remotePr()),
    ...over,
  };
}

describe('smrt-projects collections', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  describe('IssueCollection', () => {
    it('discover() creates new issues and updates existing ones from the provider', async () => {
      const repos = await RepositoryCollection.create({ db });
      const repo = await repos.create({ owner: 'acme', name: 'widgets' });
      await repo.save();
      (repo as any)._client = fakeRepoClient({
        searchIssues: vi.fn(async () => [
          remoteIssue({ number: 1, title: 'First', id: 'n1' }),
        ]),
      });

      const issues = await IssueCollection.create({ db });

      // First discovery creates the issue.
      const created = await issues.discover({ repository: repo });
      expect(created).toHaveLength(1);
      expect(created[0].title).toBe('First');
      expect(created[0].id).toBeTruthy();

      // Second discovery with changed remote data updates the same row.
      (repo as any)._client = fakeRepoClient({
        searchIssues: vi.fn(async () => [
          remoteIssue({ number: 1, title: 'First (edited)', id: 'n1b' }),
        ]),
      });
      const updated = await issues.discover({ repository: repo });
      expect(updated).toHaveLength(1);
      expect(updated[0].id).toBe(created[0].id);
      expect(updated[0].title).toBe('First (edited)');

      // Only one row persisted overall.
      const all = await issues.findByRepository(repo.id as string);
      expect(all).toHaveLength(1);
    });

    it('discover() throws when the repository is unsaved', async () => {
      const issues = await IssueCollection.create({ db });
      const repo = new Repository({ db, owner: 'a', name: 'b' });
      await expect(issues.discover({ repository: repo })).rejects.toThrow(
        /must be saved/i,
      );
    });

    it('filters issues by repository, state, label, assignee, and number', async () => {
      const issues = await IssueCollection.create({ db });
      await (
        await issues.create({
          repositoryId: 'repo-1',
          number: 1,
          title: 'open-bug',
          state: 'open',
          labels: ['bug', 'p1'],
          assignees: ['alice'],
        })
      ).save();
      await (
        await issues.create({
          repositoryId: 'repo-1',
          number: 2,
          title: 'closed-feature',
          state: 'closed',
          labels: ['feature'],
          assignees: ['bob'],
        })
      ).save();
      await (
        await issues.create({
          repositoryId: 'repo-2',
          number: 3,
          title: 'other-repo',
          state: 'open',
          labels: ['bug'],
          assignees: ['alice'],
        })
      ).save();

      expect(
        (await issues.findByRepository('repo-1')).map((i) => i.number).sort(),
      ).toEqual([1, 2]);

      expect((await issues.findOpen()).map((i) => i.title).sort()).toEqual([
        'open-bug',
        'other-repo',
      ]);
      expect((await issues.findOpen('repo-1')).map((i) => i.title)).toEqual([
        'open-bug',
      ]);

      expect(
        (await issues.findByLabel('bug')).map((i) => i.number).sort(),
      ).toEqual([1, 3]);
      expect(
        (await issues.findByLabel('bug', 'repo-1')).map((i) => i.number),
      ).toEqual([1]);

      expect(
        (await issues.findByAssignee('alice')).map((i) => i.number).sort(),
      ).toEqual([1, 3]);
      expect(
        (await issues.findByAssignee('alice', 'repo-2')).map((i) => i.number),
      ).toEqual([3]);

      const found = await issues.findByNumber('repo-1', 2);
      expect(found?.title).toBe('closed-feature');
      expect(await issues.findByNumber('repo-1', 999)).toBeNull();
    });

    it('findWithUnincorporatedFeedback() returns open issues with comments but no synthesis', async () => {
      const issues = await IssueCollection.create({ db });
      await (
        await issues.create({
          repositoryId: 'r',
          number: 1,
          state: 'open',
          commentsCount: 3,
          synthesisCount: 0,
        })
      ).save();
      await (
        await issues.create({
          repositoryId: 'r',
          number: 2,
          state: 'open',
          commentsCount: 2,
          synthesisCount: 1,
        })
      ).save();
      await (
        await issues.create({
          repositoryId: 'r',
          number: 3,
          state: 'open',
          commentsCount: 0,
          synthesisCount: 0,
        })
      ).save();

      const result = await issues.findWithUnincorporatedFeedback('r');
      expect(result.map((i) => i.number)).toEqual([1]);
    });

    it('findByTenant() scopes to the given tenant id', async () => {
      const issues = await IssueCollection.create({ db });
      await (
        await issues.create({ repositoryId: 'r', number: 1, tenantId: 't1' })
      ).save();
      await (
        await issues.create({ repositoryId: 'r', number: 2, tenantId: 't2' })
      ).save();
      expect((await issues.findByTenant('t1')).map((i) => i.number)).toEqual([
        1,
      ]);
    });

    it('batchSync() syncs every issue belonging to the repository', async () => {
      const issues = await IssueCollection.create({ db });
      const repo = new Repository({ db, owner: 'a', name: 'b' });
      (repo as any).id = 'repo-1';
      await (await issues.create({ repositoryId: 'repo-1', number: 1 })).save();
      await (await issues.create({ repositoryId: 'repo-1', number: 2 })).save();

      const syncSpy = vi
        .spyOn(Issue.prototype, 'sync')
        .mockImplementation(async function (this: Issue) {
          return this;
        });

      const synced = await issues.batchSync(repo, { force: true });
      expect(synced).toHaveLength(2);
      expect(syncSpy).toHaveBeenCalledTimes(2);
      expect(syncSpy).toHaveBeenCalledWith({ force: true });
    });

    it('findNeedingReview() filters open issues through the AI needsReview predicate', async () => {
      const issues = await IssueCollection.create({ db });
      await (
        await issues.create({ repositoryId: 'r', number: 1, state: 'open' })
      ).save();
      await (
        await issues.create({ repositoryId: 'r', number: 2, state: 'open' })
      ).save();

      vi.spyOn(Issue.prototype, 'needsReview').mockImplementation(
        async function (this: Issue) {
          return this.number === 1;
        },
      );

      const result = await issues.findNeedingReview('r');
      expect(result.map((i) => i.number)).toEqual([1]);
    });
  });

  describe('PullRequestCollection', () => {
    it('discover() creates and updates PRs, skipping ones that fail to fetch', async () => {
      const repos = await RepositoryCollection.create({ db });
      const repo = await repos.create({ owner: 'acme', name: 'widgets' });
      await repo.save();

      (repo as any)._client = fakeRepoClient({
        searchIssues: vi.fn(async () => [{ number: 1 }, { number: 2 }]),
        getPullRequest: vi.fn(async (n: number) => {
          if (n === 2) throw new Error('rate limited');
          return remotePr({ number: 1, title: 'PR one', id: 'pr1' });
        }),
      });

      const prs = await PullRequestCollection.create({ db });
      const discovered = await prs.discover({ repository: repo });
      // PR #2 fetch threw → skipped; only #1 created.
      expect(discovered.map((p) => p.number)).toEqual([1]);
      expect(discovered[0].headRef).toBe('feature');

      // Re-discover #1 with updated data → updates in place.
      (repo as any)._client = fakeRepoClient({
        searchIssues: vi.fn(async () => [{ number: 1 }]),
        getPullRequest: vi.fn(async () =>
          remotePr({
            number: 1,
            title: 'PR one (edited)',
            id: 'pr1b',
            draft: true,
          }),
        ),
      });
      const updated = await prs.discover({ repository: repo });
      expect(updated[0].title).toBe('PR one (edited)');
      expect(updated[0].draft).toBe(true);
      expect(await prs.findByRepository(repo.id as string)).toHaveLength(1);
    });

    it('discover() throws when the repository is unsaved', async () => {
      const prs = await PullRequestCollection.create({ db });
      const repo = new Repository({ db, owner: 'a', name: 'b' });
      await expect(prs.discover({ repository: repo })).rejects.toThrow(
        /must be saved/i,
      );
    });

    it('filters PRs by open state, draft, mergeable, branch, number, and change size', async () => {
      const prs = await PullRequestCollection.create({ db });
      await (
        await prs.create({
          repositoryId: 'r',
          number: 1,
          state: 'open',
          draft: false,
          mergeable: true,
          headRef: 'feat-a',
          baseRef: 'main',
          additions: 2,
          deletions: 3,
        })
      ).save();
      await (
        await prs.create({
          repositoryId: 'r',
          number: 2,
          state: 'open',
          draft: true,
          mergeable: true,
          headRef: 'feat-b',
          baseRef: 'develop',
          additions: 100,
          deletions: 100,
        })
      ).save();
      await (
        await prs.create({
          repositoryId: 'r',
          number: 3,
          state: 'closed',
          draft: false,
          mergeable: false,
          headRef: 'feat-c',
          baseRef: 'main',
          additions: 600,
          deletions: 0,
        })
      ).save();

      expect((await prs.findOpen('r')).map((p) => p.number).sort()).toEqual([
        1, 2,
      ]);
      expect((await prs.findDrafts('r')).map((p) => p.number)).toEqual([2]);
      expect((await prs.findReadyToMerge('r')).map((p) => p.number)).toEqual([
        1,
      ]);
      // findByBranch matches head OR base ref.
      expect(
        (await prs.findByBranch('main')).map((p) => p.number).sort(),
      ).toEqual([1, 3]);
      expect(
        (await prs.findByBranch('feat-b', 'r')).map((p) => p.number),
      ).toEqual([2]);
      expect((await prs.findByNumber('r', 3))?.state).toBe('closed');
      expect(await prs.findByNumber('r', 42)).toBeNull();
      // findBySize uses the real getChangeSize(): #1 = 5 lines → xs.
      expect((await prs.findBySize('xs', 'r')).map((p) => p.number)).toEqual([
        1,
      ]);
    });

    it('findByTenant() scopes PRs to the tenant', async () => {
      const prs = await PullRequestCollection.create({ db });
      await (
        await prs.create({ repositoryId: 'r', number: 1, tenantId: 't1' })
      ).save();
      await (
        await prs.create({ repositoryId: 'r', number: 2, tenantId: 't2' })
      ).save();
      expect((await prs.findByTenant('t2')).map((p) => p.number)).toEqual([2]);
    });

    it('batchSync() and findAIReadyToMerge() fan out over PRs', async () => {
      const prs = await PullRequestCollection.create({ db });
      const repo = new Repository({ db, owner: 'a', name: 'b' });
      (repo as any).id = 'repo-1';
      await (
        await prs.create({ repositoryId: 'repo-1', number: 1, state: 'open' })
      ).save();
      await (
        await prs.create({ repositoryId: 'repo-1', number: 2, state: 'open' })
      ).save();

      const syncSpy = vi
        .spyOn(PullRequest.prototype, 'sync')
        .mockImplementation(async function (this: PullRequest) {
          return this;
        });
      expect(await prs.batchSync(repo)).toHaveLength(2);
      expect(syncSpy).toHaveBeenCalledTimes(2);

      vi.spyOn(PullRequest.prototype, 'isReadyToMerge').mockImplementation(
        async function (this: PullRequest) {
          return this.number === 2;
        },
      );
      const ready = await prs.findAIReadyToMerge('repo-1');
      expect(ready.map((p) => p.number)).toEqual([2]);
    });
  });

  describe('ProjectCollection', () => {
    it('finds projects by title, owner, and provider', async () => {
      const projects = await ProjectCollection.create({ db });
      await (
        await projects.create({
          projectId: 'p1',
          title: 'Roadmap',
          owner: 'acme',
          providerType: 'github',
        })
      ).save();
      await (
        await projects.create({
          projectId: 'p2',
          title: 'Backlog',
          owner: 'beta',
          providerType: 'linear',
        })
      ).save();

      expect((await projects.findByTitle('Roadmap'))?.projectId).toBe('p1');
      expect(await projects.findByTitle('missing')).toBeNull();
      expect(
        (await projects.findByOwner('acme')).map((p) => p.projectId),
      ).toEqual(['p1']);
      expect(
        (await projects.findByProvider('linear')).map((p) => p.projectId),
      ).toEqual(['p2']);
    });

    it('getOrCreate() returns an existing project, or creates+syncs a new one', async () => {
      const projects = await ProjectCollection.create({ db });
      await (
        await projects.create({ projectId: 'p1', title: 'Existing' })
      ).save();

      const existing = await projects.getOrCreate('p1');
      expect(existing.title).toBe('Existing');

      const syncSpy = vi
        .spyOn(Project.prototype, 'sync')
        .mockImplementation(async function (this: Project) {
          return this;
        });
      const created = await projects.getOrCreate('p2', {
        title: 'New',
        owner: 'acme',
      });
      expect(created.projectId).toBe('p2');
      expect(created.title).toBe('New');
      expect(syncSpy).toHaveBeenCalledWith({ force: true });
    });

    it('syncAll() syncs every project', async () => {
      const projects = await ProjectCollection.create({ db });
      await (await projects.create({ projectId: 'p1' })).save();
      await (await projects.create({ projectId: 'p2' })).save();
      const syncSpy = vi
        .spyOn(Project.prototype, 'sync')
        .mockImplementation(async function (this: Project) {
          return this;
        });
      expect(await projects.syncAll({ force: true })).toHaveLength(2);
      expect(syncSpy).toHaveBeenCalledTimes(2);
    });

    it('findWithItemsInStatus() keeps projects with items and skips ones that error', async () => {
      const projects = await ProjectCollection.create({ db });
      await (await projects.create({ projectId: 'p1' })).save();
      await (await projects.create({ projectId: 'p2' })).save();

      vi.spyOn(Project.prototype, 'getItemsByStatus').mockImplementation(
        async function (this: Project) {
          if (this.projectId === 'p2') throw new Error('no access');
          return [{ id: 'i1', status: 'Todo' }] as any;
        },
      );

      const matching = await projects.findWithItemsInStatus('Todo');
      expect(matching.map((p) => p.projectId)).toEqual(['p1']);
    });

    it('getStatistics() aggregates items by status and type', async () => {
      const projects = await ProjectCollection.create({ db });
      await (await projects.create({ projectId: 'p1', title: 'Stats' })).save();

      vi.spyOn(Project.prototype, 'listItems').mockResolvedValue([
        { id: 'a', status: 'Todo', type: 'Issue' },
        { id: 'b', status: 'Done', type: 'PullRequest' },
        { id: 'c', status: 'Todo', type: 'Issue' },
      ] as any);
      vi.spyOn(Project.prototype, 'getStatuses').mockResolvedValue([
        { name: 'Todo' },
        { name: 'Done' },
      ] as any);

      const stats = await projects.getStatistics('p1');
      expect(stats.totalItems).toBe(3);
      expect(stats.itemsByStatus).toEqual({ Todo: 2, Done: 1 });
      expect(stats.itemsByType).toEqual({
        Issue: 2,
        PullRequest: 1,
        DraftIssue: 0,
      });

      await expect(projects.getStatistics('missing')).rejects.toThrow(
        /not found/i,
      );
    });

    it('findByTenant() scopes projects to the tenant', async () => {
      const projects = await ProjectCollection.create({ db });
      await (await projects.create({ projectId: 'p1', tenantId: 't1' })).save();
      await (await projects.create({ projectId: 'p2', tenantId: 't2' })).save();
      expect(
        (await projects.findByTenant('t1')).map((p) => p.projectId),
      ).toEqual(['p1']);
    });
  });

  describe('RepositoryCollection', () => {
    it('finds repositories by full name, owner, and provider', async () => {
      const repos = await RepositoryCollection.create({ db });
      await (
        await repos.create({
          owner: 'acme',
          name: 'widgets',
          providerType: 'github',
        })
      ).save();
      await (
        await repos.create({
          owner: 'acme',
          name: 'gadgets',
          providerType: 'gitlab',
        })
      ).save();

      expect((await repos.findByFullName('acme', 'widgets'))?.name).toBe(
        'widgets',
      );
      expect(await repos.findByFullName('acme', 'nope')).toBeNull();
      expect(
        (await repos.findByOwner('acme')).map((r) => r.name).sort(),
      ).toEqual(['gadgets', 'widgets']);
      expect((await repos.findByProvider('gitlab')).map((r) => r.name)).toEqual(
        ['gadgets'],
      );
    });

    it('getOrCreate() creates a repo once and returns the same row afterwards', async () => {
      const repos = await RepositoryCollection.create({ db });
      const created = await repos.getOrCreate('acme', 'widgets', {
        providerType: 'github',
      });
      expect(created.fullName).toBe('acme/widgets');
      expect(created.id).toBeTruthy();

      const again = await repos.getOrCreate('acme', 'widgets');
      expect(again.id).toBe(created.id);
      expect(await repos.findByOwner('acme')).toHaveLength(1);
    });

    it('syncAll() syncs every repository', async () => {
      const repos = await RepositoryCollection.create({ db });
      await (await repos.create({ owner: 'a', name: '1' })).save();
      await (await repos.create({ owner: 'a', name: '2' })).save();
      const syncSpy = vi
        .spyOn(Repository.prototype, 'sync')
        .mockImplementation(async function (this: Repository) {
          return this;
        });
      expect(await repos.syncAll({ force: true })).toHaveLength(2);
      expect(syncSpy).toHaveBeenCalledTimes(2);
    });

    it('findWithOpenIssues() keeps repos with open issues and skips ones that error', async () => {
      const repos = await RepositoryCollection.create({ db });
      await (await repos.create({ owner: 'a', name: 'has-issues' })).save();
      await (await repos.create({ owner: 'a', name: 'no-access' })).save();

      vi.spyOn(Repository.prototype, 'getIssues').mockImplementation(
        async function (this: Repository) {
          if (this.name === 'no-access') throw new Error('forbidden');
          return [{ number: 1 }] as any;
        },
      );

      const result = await repos.findWithOpenIssues();
      expect(result.map((r) => r.name)).toEqual(['has-issues']);
    });

    it('findByTenant() scopes repos to the tenant', async () => {
      const repos = await RepositoryCollection.create({ db });
      await (
        await repos.create({ owner: 'a', name: '1', tenantId: 't1' })
      ).save();
      await (
        await repos.create({ owner: 'a', name: '2', tenantId: 't2' })
      ).save();
      expect((await repos.findByTenant('t1')).map((r) => r.name)).toEqual([
        '1',
      ]);
    });
  });
});
