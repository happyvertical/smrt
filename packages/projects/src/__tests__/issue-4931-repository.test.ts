import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { snapshotObjectRegistryState } from '../../../core/src/test-utils.js';
import { Issue } from '../models/Issue.js';
import { PullRequest } from '../models/PullRequest.js';
import { Repository } from '../models/Repository.js';

for (const replaced of [false, true]) {
  describe(`repository children, app replacement=${replaced}`, () => {
    let restore: () => void;
    let expectedIssue: typeof Issue;
    let expectedPR: typeof PullRequest;
    beforeAll(async () => {
      restore = snapshotObjectRegistryState();
      const app = replaced ? await import('./issue-4931-app.fixture.js') : null;
      expectedIssue = app?.Issue ?? Issue;
      expectedPR = app?.PullRequest ?? PullRequest;
    });
    afterAll(() => restore());
    afterEach(() => vi.restoreAllMocks());

    for (const kind of ['Issue', 'PullRequest'] as const) {
      it(`create${kind} creates the exact effective class, initialized before save`, async () => {
        const lifecycle: string[] = [];
        vi.spyOn(Issue.prototype, 'initialize').mockImplementation(
          async function () {
            lifecycle.push('initialize');
            return this;
          },
        );
        vi.spyOn(Issue.prototype, 'save').mockImplementation(async function () {
          lifecycle.push('save');
          return this;
        });
        const created = {
          number: 7,
          id: 'node-7',
          title: 'remote',
          body: 'body',
          state: 'open',
          author: { login: 'owner' },
          labels: [{ name: 'bug' }],
          assignees: [],
          commentsCount: 0,
          headRef: 'feature',
          baseRef: 'main',
          merged: false,
          draft: true,
        };
        const repository = new Repository({
          id: 'repo-1',
          tenantId: 'tenant-1',
        });
        vi.spyOn(repository, 'getClient').mockResolvedValue({
          createIssue: vi.fn().mockResolvedValue(created),
          createPullRequest: vi.fn().mockResolvedValue(created),
        } as Awaited<ReturnType<Repository['getClient']>>);
        const child =
          kind === 'Issue'
            ? await repository.createIssue({ title: 'input' })
            : await repository.createPullRequest({
                title: 'input',
                headRef: 'feature',
                baseRef: 'main',
              });
        expect(child.constructor).toBe(
          kind === 'Issue' ? expectedIssue : expectedPR,
        );
        expect(child).toMatchObject({
          repositoryId: 'repo-1',
          number: 7,
          title: 'remote',
          labels: ['bug'],
        });
        expect(lifecycle).toEqual(['initialize', 'save']);
      });
    }
  });
}
