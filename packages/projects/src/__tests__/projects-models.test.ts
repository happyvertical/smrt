/**
 * Behavioural coverage for the smrt-projects models (Issue / PullRequest /
 * Repository / Project).
 *
 * Real in-memory SQLite, no DB mocking, per `.claude/rules/testing.md`. The
 * external provider SDKs (`@happyvertical/repos`, `@happyvertical/projects`) are
 * mocked so `getClient()`'s token-resolution + client-construction path runs
 * without a network call; the returned client is a hand-rolled fake exposing
 * only the methods each test exercises. AI methods (`is()` / `do()`) are spied
 * per-instance so no real model call is made.
 *
 * Comment/Label models are deliberately never loaded here (getComments/addComment
 * are spied or unused), matching `issue-prompt-integration.test.ts`.
 */

import { getProject } from '@happyvertical/projects';
import { getRepository } from '@happyvertical/repos';
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

vi.mock('@happyvertical/repos', () => ({ getRepository: vi.fn() }));
vi.mock('@happyvertical/projects', () => ({ getProject: vi.fn() }));

const TOKEN_KEY = 'SMRT_PROJECTS_TEST_TOKEN';
const MISSING_KEY = 'SMRT_PROJECTS_DEFINITELY_MISSING_TOKEN';

/** SDK-shaped issue/PR record returned by the provider client. */
function sdkIssue(over: Record<string, any> = {}): any {
  return {
    number: 1,
    id: 'node-1',
    title: 'Synced title',
    body: 'Synced body',
    state: 'open',
    author: { login: 'octocat' },
    labels: [{ name: 'bug' }],
    assignees: [{ login: 'octocat' }],
    commentsCount: 2,
    ...over,
  };
}

function sdkPr(over: Record<string, any> = {}): any {
  return {
    ...sdkIssue(over),
    headRef: 'feature',
    baseRef: 'main',
    merged: false,
    mergedAt: null,
    mergeable: true,
    draft: false,
    ...over,
  };
}

/** A fake provider repository client (`IRepository`). */
function repoClient(over: Record<string, any> = {}): any {
  return {
    getRepository: vi.fn(async () => ({
      owner: 'acme',
      name: 'widgets',
      description: 'desc',
      defaultBranch: 'main',
      isPrivate: true,
    })),
    getIssue: vi.fn(async () => sdkIssue()),
    getPullRequest: vi.fn(async () => sdkPr()),
    searchIssues: vi.fn(async () => []),
    createIssue: vi.fn(async () => sdkIssue({ number: 7, id: 'new-issue' })),
    createPullRequest: vi.fn(async () => sdkPr({ number: 8, id: 'new-pr' })),
    closeIssue: vi.fn(async () => {}),
    addLabels: vi.fn(async () => {}),
    removeLabel: vi.fn(async () => {}),
    assignIssue: vi.fn(async () => {}),
    updateIssue: vi.fn(async () => {}),
    mergePullRequest: vi.fn(async () => {}),
    markPRReady: vi.fn(async () => {}),
    convertPRToDraft: vi.fn(async () => {}),
    requestReview: vi.fn(async () => {}),
    findIssueForPR: vi.fn(async () => null),
    ...over,
  };
}

/** A fake provider project client (`IProject`). */
function projectClient(over: Record<string, any> = {}): any {
  return {
    getProject: vi.fn(async () => ({
      title: 'Synced project',
      description: 'pdesc',
      owner: 'acme',
      url: 'https://example/p',
      statuses: [{ name: 'Todo' }, { name: 'Done' }],
      fields: [{ id: 'f1', name: 'Priority' }],
    })),
    addItem: vi.fn(async () => ({ id: 'item-1' })),
    removeItem: vi.fn(async () => {}),
    getItem: vi.fn(async () => ({ id: 'item-1' })),
    listItems: vi.fn(async () => []),
    updateItemStatus: vi.fn(async () => {}),
    updateItemField: vi.fn(async () => {}),
    listStatuses: vi.fn(async () => [{ name: 'Todo' }]),
    listFields: vi.fn(async () => [{ id: 'f1', name: 'Priority' }]),
    ...over,
  };
}

describe('smrt-projects models', () => {
  let db: DatabaseInterface;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    savedEnv[TOKEN_KEY] = process.env[TOKEN_KEY];
    savedEnv[MISSING_KEY] = process.env[MISSING_KEY];
    process.env[TOKEN_KEY] = 'dummy-token';
    delete process.env[MISSING_KEY];
    vi.mocked(getRepository).mockReset();
    vi.mocked(getProject).mockReset();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  describe('Repository', () => {
    it('getClient() resolves a token, constructs and caches the client', async () => {
      const fake = repoClient();
      vi.mocked(getRepository).mockResolvedValue(fake);

      const repos = await RepositoryCollection.create({ db });
      const repo = await repos.create({
        owner: 'acme',
        name: 'widgets',
        tokenConfigKey: TOKEN_KEY,
      });

      const client = await repo.getClient();
      expect(client).toBe(fake);
      // Cached: a second call does not re-construct.
      await repo.getClient();
      expect(getRepository).toHaveBeenCalledTimes(1);

      // clearClient() forces re-construction on the next call.
      repo.clearClient();
      await repo.getClient();
      expect(getRepository).toHaveBeenCalledTimes(2);
    });

    it('getClient() throws a helpful error when the token cannot be resolved', async () => {
      const repos = await RepositoryCollection.create({ db });
      const repo = await repos.create({
        owner: 'acme',
        name: 'widgets',
        tokenConfigKey: MISSING_KEY,
      });
      await expect(repo.getClient()).rejects.toThrow(
        new RegExp(`Token not found for key '${MISSING_KEY}'`),
      );
    });

    it('sync() skips a recent sync but refreshes fields when forced', async () => {
      const repos = await RepositoryCollection.create({ db });
      const repo = await repos.create({
        owner: 'old',
        name: 'old',
        tokenConfigKey: TOKEN_KEY,
      });
      await repo.save();
      const fake = repoClient();
      (repo as any)._client = fake;

      // Recently synced + no force → throttled (no client call).
      repo.lastSyncedAt = new Date();
      await repo.sync();
      expect(fake.getRepository).not.toHaveBeenCalled();

      // Forced → fields updated from remote.
      await repo.sync({ force: true });
      expect(fake.getRepository).toHaveBeenCalledTimes(1);
      expect(repo.fullName).toBe('acme/widgets');
      expect(repo.isPrivate).toBe(true);
    });

    it('createIssue()/createPullRequest() reject an unsaved repository', async () => {
      // An unsaved repo has no id (assigned on save), so creation is rejected
      // before any provider call is made.
      const unsaved = new Repository({ db, owner: 'a', name: 'b' });
      expect(unsaved.id).toBeFalsy();
      await expect(unsaved.createIssue({ title: 'x' } as any)).rejects.toThrow(
        /must be saved/i,
      );
      await expect(
        unsaved.createPullRequest({ title: 'x' } as any),
      ).rejects.toThrow(/must be saved/i);
    });

    it('createIssue()/createPullRequest() persist the created model (regression: initialize before save)', async () => {
      // Regression for a latent defect: these methods construct a model from
      // `this.options` and call save() directly. Without an explicit
      // initialize() the new model's DB connection is unset and save() throws
      // "Database accessed before initialization". See Repository.createIssue.
      const repos = await RepositoryCollection.create({ db });
      const repo = await repos.create({ owner: 'acme', name: 'widgets' });
      await repo.save();
      (repo as any)._client = repoClient();

      const issue = await repo.createIssue({ title: 'New' } as any);
      expect(issue).toBeInstanceOf(Issue);
      expect(issue.number).toBe(7);
      expect(issue.id).toBeTruthy();
      // Persisted and retrievable through its collection.
      const issues = await IssueCollection.create({ db });
      expect((await issues.findByNumber(repo.id as string, 7))?.title).toBe(
        'Synced title',
      );

      const pr = await repo.createPullRequest({ title: 'New PR' } as any);
      expect(pr).toBeInstanceOf(PullRequest);
      expect(pr.number).toBe(8);
      // STI child row is correctly discriminated on retrieval.
      const prs = await PullRequestCollection.create({ db });
      expect((await prs.findByNumber(repo.id as string, 8))?.headRef).toBe(
        'feature',
      );
    });

    it('getIssues()/getPullRequests() delegate discovery to the provider client', async () => {
      const repos = await RepositoryCollection.create({ db });
      const repo = await repos.create({ owner: 'acme', name: 'widgets' });
      await repo.save();
      (repo as any)._client = repoClient({
        searchIssues: vi.fn(async (q: string) =>
          q === 'is:pr' ? [{ number: 5 }] : [sdkIssue({ number: 3 })],
        ),
        getPullRequest: vi.fn(async () => sdkPr({ number: 5 })),
      });

      const issues = await repo.getIssues({ state: 'open' });
      expect(issues.map((i) => i.number)).toEqual([3]);

      const prs = await repo.getPullRequests();
      expect(prs.map((p) => p.number)).toEqual([5]);
    });

    it('getByFullName() static finder resolves a persisted repository', async () => {
      const repos = await RepositoryCollection.create({ db });
      await (
        await repos.create({
          owner: 'acme',
          name: 'widgets',
          fullName: 'acme/widgets',
        })
      ).save();
      const found = await Repository.getByFullName('acme', 'widgets', { db });
      expect(found?.name).toBe('widgets');
      expect(found?.fullName).toBe('acme/widgets');
    });
  });

  describe('Issue', () => {
    it('getUrl() reflects the cached repository and clearCache() resets it', async () => {
      const issue = new Issue({ db, number: 42, repositoryId: 'r' });
      expect(issue.getUrl()).toBe('');
      (issue as any)._repository = { owner: 'acme', name: 'widgets' };
      expect(issue.getUrl()).toBe('https://github.com/acme/widgets/issues/42');
      issue.clearCache();
      expect(issue.getUrl()).toBe('');
    });

    it('getRepository() throws without a repositoryId, and loads the repo otherwise', async () => {
      const orphan = new Issue({ db });
      await expect(orphan.getRepository()).rejects.toThrow(/no repositoryId/i);

      const repos = await RepositoryCollection.create({ db });
      const repo = await repos.create({
        owner: 'acme',
        name: 'widgets',
        tokenConfigKey: TOKEN_KEY,
      });
      await repo.save();

      const fake = repoClient();
      vi.mocked(getRepository).mockResolvedValue(fake);

      const issues = await IssueCollection.create({ db });
      const issue = await issues.create({
        repositoryId: repo.id as string,
        number: 1,
      });
      const loaded = await issue.getRepository();
      expect(loaded.id).toBe(repo.id);
      // getClient() flows through the loaded repo's client.
      expect(await issue.getClient()).toBe(fake);
    });

    it('getRepository() throws when the referenced repository is missing', async () => {
      const issues = await IssueCollection.create({ db });
      const issue = await issues.create({
        repositoryId: 'no-such-repo',
        number: 1,
      });
      await expect(issue.getRepository()).rejects.toThrow(/not found/i);
    });

    it('sync() throttles a recent sync and otherwise refreshes from the client', async () => {
      const issues = await IssueCollection.create({ db });
      const issue = await issues.create({
        repositoryId: 'r',
        number: 1,
        title: 'old',
      });
      await issue.save();
      const fake = repoClient();
      (issue as any)._client = fake;

      issue.lastSyncedAt = new Date();
      await issue.sync();
      expect(fake.getIssue).not.toHaveBeenCalled();

      await issue.sync({ force: true });
      expect(issue.title).toBe('Synced title');
      expect(issue.labels).toEqual(['bug']);
    });

    it('close()/addLabels()/removeLabel()/assign() update local state via the client', async () => {
      const issues = await IssueCollection.create({ db });
      const issue = await issues.create({
        repositoryId: 'r',
        number: 1,
        labels: ['keep'],
        assignees: [],
      });
      await issue.save();
      const fake = repoClient();
      (issue as any)._client = fake;

      await issue.close();
      expect(issue.state).toBe('closed');
      expect(fake.closeIssue).toHaveBeenCalledWith(1);

      await issue.addLabels(['bug', 'keep']);
      expect(issue.labels.sort()).toEqual(['bug', 'keep']);

      await issue.removeLabel('keep');
      expect(issue.labels).toEqual(['bug']);

      await issue.assign(['alice', 'alice']);
      expect(issue.assignees).toEqual(['alice']);
    });

    it('incorporateFeedback() returns an unmodified preview when there are no comments', async () => {
      const issues = await IssueCollection.create({ db });
      const issue = await issues.create({
        repositoryId: 'r',
        number: 1,
        body: 'spec',
      });
      vi.spyOn(issue, 'getComments').mockResolvedValue([] as any);

      const result = await issue.incorporateFeedback();
      expect(result).toEqual({
        synthesized: 'spec',
        applied: false,
        commentsAnalyzed: 0,
      });
    });

    it('rollback() guards on missing original body / no synthesis, then restores', async () => {
      const issues = await IssueCollection.create({ db });
      const issue = await issues.create({
        repositoryId: 'r',
        number: 1,
        body: 'current',
      });
      await issue.save();
      const fake = repoClient();
      (issue as any)._client = fake;

      expect(await issue.rollback()).toEqual({
        success: false,
        message: 'No original body to rollback to',
      });

      issue.originalBody = 'original';
      issue.synthesisCount = 0;
      expect(await issue.rollback()).toMatchObject({ success: false });

      issue.synthesisCount = 2;
      const result = await issue.rollback();
      expect(result.success).toBe(true);
      expect(issue.body).toBe('original');
      expect(issue.synthesisCount).toBe(0);
      expect(fake.updateIssue).toHaveBeenCalledWith(1, { body: 'original' });
    });

    it('AI predicates delegate to is()/do()', async () => {
      const issues = await IssueCollection.create({ db });
      const issue = await issues.create({ repositoryId: 'r', number: 1 });
      vi.spyOn(issue, 'is').mockResolvedValue(true);
      vi.spyOn(issue, 'do').mockResolvedValue(' bug, P1 , ,docs ');

      expect(await issue.needsReview()).toBe(true);
      expect(await issue.isBugReport()).toBe(true);
      expect(await issue.isFeatureRequest()).toBe(true);
      expect(await issue.suggestLabels()).toEqual(['bug', 'P1', 'docs']);
    });
  });

  describe('PullRequest', () => {
    it('getChangeSize() classifies by total line delta', () => {
      const size = (additions: number, deletions: number) =>
        new PullRequest({ additions, deletions }).getChangeSize();
      expect(size(2, 3)).toBe('xs');
      expect(size(20, 10)).toBe('s');
      expect(size(100, 50)).toBe('m');
      expect(size(300, 150)).toBe('l');
      expect(size(400, 400)).toBe('xl');
    });

    it('getUrl() points at the pull-request path when a repo is cached', () => {
      const pr = new PullRequest({ number: 9 });
      expect(pr.getUrl()).toBe('');
      (pr as any)._repository = { owner: 'acme', name: 'widgets' };
      expect(pr.getUrl()).toBe('https://github.com/acme/widgets/pull/9');
    });

    it('merge() enforces its preconditions then merges through the client', async () => {
      const prs = await PullRequestCollection.create({ db });

      const already = await prs.create({
        repositoryId: 'r',
        number: 1,
        merged: true,
      });
      await expect(already.merge()).rejects.toThrow(/already merged/i);

      const draft = await prs.create({
        repositoryId: 'r',
        number: 2,
        draft: true,
      });
      await expect(draft.merge()).rejects.toThrow(/draft/i);

      const conflicted = await prs.create({
        repositoryId: 'r',
        number: 3,
        mergeable: false,
      });
      await expect(conflicted.merge()).rejects.toThrow(/not mergeable/i);

      const ok = await prs.create({
        repositoryId: 'r',
        number: 4,
        mergeable: true,
        draft: false,
      });
      await ok.save();
      const fake = repoClient();
      (ok as any)._client = fake;
      await ok.merge('squash');
      expect(fake.mergePullRequest).toHaveBeenCalledWith(4, 'squash');
      expect(ok.merged).toBe(true);
      expect(ok.state).toBe('closed');
    });

    it('markReady()/convertToDraft() toggle draft state via the client', async () => {
      const prs = await PullRequestCollection.create({ db });

      const notDraft = await prs.create({
        repositoryId: 'r',
        number: 1,
        draft: false,
      });
      await expect(notDraft.markReady()).rejects.toThrow(/not a draft/i);

      const draft = await prs.create({
        repositoryId: 'r',
        number: 2,
        draft: true,
      });
      await draft.save();
      const fake = repoClient();
      (draft as any)._client = fake;
      await draft.markReady();
      expect(draft.draft).toBe(false);
      expect(fake.markPRReady).toHaveBeenCalledWith(2);

      await expect(draft.convertToDraft()).resolves.toBeUndefined();
      expect(draft.draft).toBe(true);
      expect(fake.convertPRToDraft).toHaveBeenCalledWith(2);

      const alreadyDraft = await prs.create({
        repositoryId: 'r',
        number: 3,
        draft: true,
      });
      await expect(alreadyDraft.convertToDraft()).rejects.toThrow(
        /already a draft/i,
      );
    });

    it('requestReviewers() and findLinkedIssue() use the client', async () => {
      const prs = await PullRequestCollection.create({ db });
      const issues = await IssueCollection.create({ db });
      await (
        await issues.create({ repositoryId: 'r', number: 100, title: 'linked' })
      ).save();

      const pr = await prs.create({ repositoryId: 'r', number: 1 });
      const fake = repoClient({
        findIssueForPR: vi.fn(async () => ({ number: 100 })),
      });
      (pr as any)._client = fake;

      await pr.requestReviewers(['alice']);
      expect(fake.requestReview).toHaveBeenCalledWith(1, ['alice']);

      const linked = await pr.findLinkedIssue();
      expect(linked?.title).toBe('linked');

      // Null when the client reports no linked issue.
      (pr as any)._client = repoClient({
        findIssueForPR: vi.fn(async () => null),
      });
      expect(await pr.findLinkedIssue()).toBeNull();
    });

    it('isReadyToMerge() short-circuits on draft/mergeability/state before AI', async () => {
      const prs = await PullRequestCollection.create({ db });
      expect(
        await (
          await prs.create({ repositoryId: 'r', number: 1, draft: true })
        ).isReadyToMerge(),
      ).toBe(false);
      expect(
        await (
          await prs.create({ repositoryId: 'r', number: 2, mergeable: false })
        ).isReadyToMerge(),
      ).toBe(false);
      expect(
        await (
          await prs.create({ repositoryId: 'r', number: 3, state: 'closed' })
        ).isReadyToMerge(),
      ).toBe(false);

      const ready = await prs.create({
        repositoryId: 'r',
        number: 4,
        draft: false,
        mergeable: true,
        state: 'open',
      });
      vi.spyOn(ready, 'is').mockResolvedValue(true);
      expect(await ready.isReadyToMerge()).toBe(true);
    });

    it('summarize()/suggestReviewers() delegate to do()', async () => {
      const prs = await PullRequestCollection.create({ db });
      const pr = await prs.create({
        repositoryId: 'r',
        number: 1,
        title: 'T',
        body: 'B',
      });
      const doSpy = vi.spyOn(pr, 'do');
      doSpy.mockResolvedValueOnce('A concise summary.');
      expect(await pr.summarize()).toBe('A concise summary.');
      doSpy.mockResolvedValueOnce('alice, bob , ');
      expect(await pr.suggestReviewers()).toEqual(['alice', 'bob']);
    });

    it('sync() throttles, then refreshes PR-specific fields when forced', async () => {
      const prs = await PullRequestCollection.create({ db });
      const pr = await prs.create({
        repositoryId: 'r',
        number: 1,
        headRef: 'old',
      });
      await pr.save();
      const fake = repoClient({
        getPullRequest: vi.fn(async () =>
          sdkPr({ number: 1, headRef: 'new-head' }),
        ),
      });
      (pr as any)._client = fake;

      pr.lastSyncedAt = new Date();
      await pr.sync();
      expect(fake.getPullRequest).not.toHaveBeenCalled();

      await pr.sync({ force: true });
      expect(pr.headRef).toBe('new-head');
    });
  });

  describe('Project', () => {
    it('getClient() resolves a token, constructs/caches, and throws when missing', async () => {
      const fake = projectClient();
      vi.mocked(getProject).mockResolvedValue(fake);

      const projects = await ProjectCollection.create({ db });
      const project = await projects.create({
        projectId: 'p1',
        tokenConfigKey: TOKEN_KEY,
        statusFieldId: 'sf1',
        statusOptions: { Todo: 'opt1' },
      });
      expect(await project.getClient()).toBe(fake);
      await project.getClient();
      expect(getProject).toHaveBeenCalledTimes(1);
      project.clearClient();
      await project.getClient();
      expect(getProject).toHaveBeenCalledTimes(2);

      const missing = await projects.create({
        projectId: 'p2',
        tokenConfigKey: MISSING_KEY,
      });
      await expect(missing.getClient()).rejects.toThrow(/Token not found/);
    });

    it('sync() throttles a recent sync and refreshes when forced', async () => {
      const projects = await ProjectCollection.create({ db });
      const project = await projects.create({ projectId: 'p1', title: 'old' });
      await project.save();
      const fake = projectClient();
      (project as any)._client = fake;

      project.lastSyncedAt = new Date();
      await project.sync();
      expect(fake.getProject).not.toHaveBeenCalled();

      await project.sync({ force: true });
      expect(project.title).toBe('Synced project');
      expect(project.statuses.map((s) => s.name)).toEqual(['Todo', 'Done']);
    });

    it('item operations delegate to the client', async () => {
      const projects = await ProjectCollection.create({ db });
      const project = await projects.create({ projectId: 'p1' });
      const fake = projectClient({
        listItems: vi.fn(async () => [
          { id: 'i1', status: 'Todo', type: 'Issue', contentId: 'node-x' },
        ]),
      });
      (project as any)._client = fake;

      await expect(project.addItem({ nodeId: '' } as any)).rejects.toThrow(
        /nodeId/i,
      );
      expect(await project.addItem({ nodeId: 'node-1' } as any)).toEqual({
        id: 'item-1',
      });

      await project.removeItem('item-1');
      expect(fake.removeItem).toHaveBeenCalledWith('item-1');
      expect(await project.getItem('item-1')).toEqual({ id: 'item-1' });
      expect(await project.listItems()).toHaveLength(1);
      await project.updateItemStatus('i1', 'Done');
      expect(fake.updateItemStatus).toHaveBeenCalledWith('i1', 'Done');
      await project.updateItemField('i1', 'f1', 'High');
      expect(fake.updateItemField).toHaveBeenCalledWith('i1', 'f1', 'High');
      expect(await project.getItemsByStatus('Todo')).toHaveLength(1);

      // moveItem finds the project item by contentId, then updates its status.
      await project.moveItem({ nodeId: 'node-x' } as any, 'Done');
      expect(fake.updateItemStatus).toHaveBeenCalledWith('i1', 'Done');
      await expect(
        project.moveItem({ nodeId: 'absent' } as any, 'Done'),
      ).rejects.toThrow(/not found in project/i);
    });

    it('getStatuses()/getFields() prefer cached values and fall back to the client', async () => {
      const projects = await ProjectCollection.create({ db });

      const cached = await projects.create({
        projectId: 'p1',
        statuses: [{ name: 'Cached' }] as any,
        fields: [{ id: 'cf', name: 'Cached' }] as any,
      });
      (cached as any)._client = projectClient();
      expect((await cached.getStatuses()).map((s) => s.name)).toEqual([
        'Cached',
      ]);
      expect((await cached.getFields()).map((f) => f.id)).toEqual(['cf']);

      const empty = await projects.create({ projectId: 'p2' });
      await empty.save();
      (empty as any)._client = projectClient();
      expect((await empty.getStatuses()).map((s) => s.name)).toEqual(['Todo']);
      expect((await empty.getFields()).map((f) => f.id)).toEqual(['f1']);
    });

    it('analyzeHealth() builds a status distribution and delegates to do()', async () => {
      const projects = await ProjectCollection.create({ db });
      const project = await projects.create({
        projectId: 'p1',
        title: 'Board',
      });
      (project as any)._client = projectClient({
        listItems: vi.fn(async () => [
          { id: 'a', status: 'Todo' },
          { id: 'b', status: 'Todo' },
          { id: 'c', status: 'Done' },
        ]),
        listStatuses: vi.fn(async () => [{ name: 'Todo' }, { name: 'Done' }]),
      });
      const doSpy = vi.spyOn(project, 'do').mockResolvedValue('Healthy board.');

      expect(await project.analyzeHealth()).toBe('Healthy board.');
      const prompt = doSpy.mock.calls[0]?.[0] as string;
      expect(prompt).toContain('- Todo: 2 items');
      expect(prompt).toContain('- Done: 1 items');
    });

    it('getByTitle() static finder resolves a persisted project', async () => {
      const projects = await ProjectCollection.create({ db });
      await (
        await projects.create({ projectId: 'p1', title: 'Roadmap' })
      ).save();
      const found = await Project.getByTitle('Roadmap', { db });
      expect(found?.projectId).toBe('p1');
    });
  });
});
