#!/usr/bin/env node
/**
 * Cancel a merge-group validation run once one of its jobs has failed (#5045).
 *
 * `Required CI` reads `needs.*.result`, so it reports only when every job has
 * finished. A merge group whose dependency audit failed in the first minute
 * therefore held the one-entry queue for another 35-45 minutes: 10 of the 18
 * failed merge-group runs of 2026-11-09..16 had failed within 11 minutes and
 * reported at 25-49. Cancelling the run ends the remaining jobs; `Required CI`
 * runs under `always()`, sees a result that is not `success`, and fails, which
 * is what removes the entry from the queue.
 *
 * The cost is that jobs still running when the first one fails never report,
 * so a group with several defects shows one per attempt. The pull request run
 * is not cancelled this way and still reports every job.
 *
 * This job is not one of `Required CI`'s needs and always exits 0: an API
 * error or a cancel that is refused leaves the run to finish as it did before.
 *
 * Usage (in the workflow): node scripts/merge-group-fail-fast.mjs
 * Environment: GITHUB_TOKEN (actions: write), GITHUB_REPOSITORY, GITHUB_RUN_ID,
 * GITHUB_RUN_ATTEMPT, GITHUB_API_URL, SELF_JOB, AGGREGATE_JOB.
 */
import { fileURLToPath } from 'node:url';

/** A job with one of these conclusions means `Required CI` cannot pass. */
const DOOMED = new Set(['failure', 'timed_out', 'cancelled']);

/**
 * What to do given the run's current jobs.
 *
 * @param {{ name: string, status: string, conclusion: string | null }[]} jobs
 * @param {{ self: string, aggregate: string }} names this job, and the job
 *   that only starts once every validation job has finished
 * @returns {{ action: 'cancel', job: string } | { action: 'done' } | { action: 'wait' }}
 */
export function decide(jobs, { self, aggregate }) {
  const others = jobs.filter((job) => job.name !== self);
  // Once the aggregate exists every other job has finished: nothing is left
  // to cancel, and cancelling now would only hide its own result.
  if (others.some((job) => job.name === aggregate)) return { action: 'done' };
  const doomed = others.find((job) => DOOMED.has(job.conclusion ?? ''));
  return doomed ? { action: 'cancel', job: doomed.name } : { action: 'wait' };
}

/**
 * Poll until the run is cancelled, has nothing left to cancel, or the deadline
 * passes. Never throws.
 *
 * @param {{
 *   listJobs: () => Promise<{ name: string, status: string, conclusion: string | null }[]>,
 *   cancel: () => Promise<void>,
 *   sleep: (ms: number) => Promise<void>,
 *   log: (message: string) => void,
 *   names: { self: string, aggregate: string },
 *   intervalMs?: number,
 *   maxPolls?: number,
 * }} options
 * @returns {Promise<'cancelled' | 'done' | 'deadline'>}
 */
export async function watch({
  listJobs,
  cancel,
  sleep,
  log,
  names,
  intervalMs = 20_000,
  maxPolls = 510,
}) {
  for (let poll = 0; poll < maxPolls; poll += 1) {
    try {
      const decision = decide(await listJobs(), names);
      if (decision.action === 'done') {
        log(`${names.aggregate} has started; nothing left to cancel.`);
        return 'done';
      }
      if (decision.action === 'cancel') {
        log(`"${decision.job}" did not succeed; cancelling the run so the merge group is removed now.`);
        await cancel();
        return 'cancelled';
      }
    } catch (error) {
      // Leave the run alone; it still reports through Required CI.
      log(`::warning::fail-fast check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await sleep(intervalMs);
  }
  log('Deadline reached without a failed job; leaving the run to finish.');
  return 'deadline';
}

function githubClient() {
  const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT } = process.env;
  const api = process.env.GITHUB_API_URL || 'https://api.github.com';
  const run = `${api}/repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${GITHUB_TOKEN}`,
    'x-github-api-version': '2022-11-28',
  };
  const request = async (url, init) => {
    const response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${url} returned ${response.status}`);
    return response;
  };
  return {
    async listJobs() {
      const jobs = [];
      for (let page = 1; ; page += 1) {
        const response = await request(`${run}/attempts/${GITHUB_RUN_ATTEMPT}/jobs?per_page=100&page=${page}`);
        const body = await response.json();
        jobs.push(...body.jobs);
        if (body.jobs.length < 100) return jobs;
      }
    },
    async cancel() {
      await request(`${run}/cancel`, { method: 'POST' });
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const names = { self: process.env.SELF_JOB ?? '', aggregate: process.env.AGGREGATE_JOB ?? '' };
  if (!names.self || !names.aggregate || !process.env.GITHUB_TOKEN || !process.env.GITHUB_RUN_ID) {
    console.log('::warning::fail-fast is not configured; leaving the run to finish.');
  } else {
    await watch({
      ...githubClient(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log: (message) => console.log(message),
      names,
    });
  }
}
