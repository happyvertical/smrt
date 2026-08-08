import assert from 'node:assert/strict';
import test from 'node:test';

import {
  inspectMergeQueue,
  requireIdleMergeQueue,
} from './check-merge-queue-idle.mjs';

function response(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function githubFetch({ queueRefs = [], queued = [], inProgress = [] } = {}) {
  return async (url) => {
    if (url.includes('/git/matching-refs/')) {
      return response(queueRefs);
    }
    if (url.includes('status=queued')) {
      return response({ workflow_runs: queued });
    }
    if (url.includes('status=in_progress')) {
      return response({ workflow_runs: inProgress });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
}

const options = {
  repository: 'happyvertical/smrt',
  token: 'test-token',
};

test('allows a release only when merge-group runs and queue refs are absent', async () => {
  const state = await requireIdleMergeQueue({
    ...options,
    fetchImpl: githubFetch(),
  });

  assert.deepEqual(state, { activeRuns: [], queueRefs: [] });
});

test('defers a release when an active merge group exists', async () => {
  await assert.rejects(
    requireIdleMergeQueue({
      ...options,
      fetchImpl: githubFetch({
        inProgress: [
          {
            head_branch: 'gh-readonly-queue/main/pr-2254',
            html_url: 'https://github.com/happyvertical/smrt/actions/runs/1',
          },
        ],
      }),
    }),
    /Merge queue is active \(1 run\(s\), 0 ref\(s\)\)/,
  );
});

test('defers a release when a queue ref exists before its run starts', async () => {
  await assert.rejects(
    requireIdleMergeQueue({
      ...options,
      fetchImpl: githubFetch({
        queueRefs: [{ ref: 'refs/heads/gh-readonly-queue/main/pr-2254' }],
      }),
    }),
    /Merge queue is active \(0 run\(s\), 1 ref\(s\)\)/,
  );
});

test('fails closed when GitHub cannot prove the queue is idle', async () => {
  await assert.rejects(
    inspectMergeQueue({
      ...options,
      fetchImpl: async () => response({ message: 'unavailable' }, { ok: false, status: 503 }),
    }),
    /GitHub API 503/,
  );
});
