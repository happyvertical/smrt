import { pathToFileURL } from 'node:url';

const ACTIVE_RUN_STATUSES = ['queued', 'in_progress'];

async function githubJson(fetchImpl, apiUrl, token, path) {
  const response = await fetchImpl(`${apiUrl}${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GitHub API ${response.status} for ${path}: ${body.slice(0, 500)}`,
    );
  }

  return response.json();
}

export async function inspectMergeQueue({
  apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com',
  fetchImpl = globalThis.fetch,
  repository = process.env.GITHUB_REPOSITORY,
  token = process.env.GITHUB_TOKEN,
} = {}) {
  if (!repository || !token) {
    throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
  }

  const encodedRepository = repository
    .split('/')
    .map(encodeURIComponent)
    .join('/');
  const [queueRefs, ...runResponses] = await Promise.all([
    githubJson(
      fetchImpl,
      apiUrl,
      token,
      `/repos/${encodedRepository}/git/matching-refs/heads/gh-readonly-queue/main/`,
    ),
    ...ACTIVE_RUN_STATUSES.map((status) =>
      githubJson(
        fetchImpl,
        apiUrl,
        token,
        `/repos/${encodedRepository}/actions/runs?event=merge_group&status=${status}&per_page=100`,
      ),
    ),
  ]);

  if (!Array.isArray(queueRefs)) {
    throw new Error('GitHub matching-refs response was not an array');
  }

  const activeRuns = runResponses.flatMap((response, index) => {
    if (!Array.isArray(response.workflow_runs)) {
      throw new Error(
        `GitHub Actions response for ${ACTIVE_RUN_STATUSES[index]} was invalid`,
      );
    }
    return response.workflow_runs;
  });

  return {
    activeRuns,
    queueRefs,
  };
}

export async function requireIdleMergeQueue(options) {
  const { activeRuns, queueRefs } = await inspectMergeQueue(options);

  if (activeRuns.length > 0 || queueRefs.length > 0) {
    const runSummary = activeRuns
      .map((run) => run.html_url ?? run.head_branch ?? run.id)
      .join(', ');
    const refSummary = queueRefs
      .map((entry) => entry.ref ?? 'unknown queue ref')
      .join(', ');
    throw new Error(
      [
        `Merge queue is active (${activeRuns.length} run(s), ${queueRefs.length} ref(s)); release deferred.`,
        runSummary && `Runs: ${runSummary}`,
        refSummary && `Refs: ${refSummary}`,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  return { activeRuns, queueRefs };
}

async function main() {
  try {
    await requireIdleMergeQueue();
    console.log('Merge queue is idle; release may proceed.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
