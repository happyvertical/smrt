#!/usr/bin/env node
/**
 * Maintainer approval gate for external fork pull requests (#4558).
 *
 * Fork PRs never run with trusted credentials before merge. Their code is
 * validated in the sandboxed `Fork PR Validation` workflow (`pull_request`,
 * read-only token, no secrets). The required contexts `Required CI` and
 * `postgres-required` come from the trusted `pull_request_target` workflows,
 * which only run this script from the base revision.
 *
 *   gate     Runs inside those required jobs for a fork PR. Passes only on a
 *            re-run (attempt > 1, which only someone with write access can
 *            cause) of the current head, while the approval label is present,
 *            the sandbox run for that head succeeded, and the PR leaves
 *            `.github/` alone.
 *   approve  Runs when a maintainer applies the approval label. Re-runs the
 *            required jobs for the labelled head so the gate evaluates.
 *
 * The merge queue's full trusted validation still gates every merge.
 */

import { pathToFileURL } from 'node:url';

export const APPROVAL_LABEL = 'ci: fork-approved';
export const FORK_VALIDATION_WORKFLOW = 'fork-pr-validation.yml';
export const REQUIRED_CONTEXTS = ['Required CI', 'postgres-required'];
const ACTIONS_APP_SLUG = 'github-actions';

function touchesGithubDir(file) {
  return [file.filename, file.previous_filename].some(
    (name) => typeof name === 'string' && name.startsWith('.github/'),
  );
}

/**
 * Checks that hold for both `gate` and `approve`. Pure; every input comes
 * from the GitHub REST API.
 *
 * @param {{ expectedHeadSha: string, pr: any, files: any[], validationRuns: any[] }} input
 * @returns {string[]} reasons the approval does not hold; empty when it does
 */
export function approvalProblems({ expectedHeadSha, pr, files, validationRuns }) {
  const problems = [];
  if (pr.state !== 'open') {
    problems.push(`the pull request is ${pr.state}`);
  }
  if (pr.head?.sha !== expectedHeadSha) {
    problems.push(
      `the head moved from ${expectedHeadSha} to ${pr.head?.sha}; approve the new head`,
    );
  }
  const labels = (pr.labels ?? []).map((label) => label.name);
  if (!labels.includes(APPROVAL_LABEL)) {
    problems.push(`a maintainer has not applied \`${APPROVAL_LABEL}\``);
  }
  const workflowFiles = files.filter(touchesGithubDir).map((file) => file.filename);
  if (workflowFiles.length > 0) {
    problems.push(
      `the PR changes .github/ (${workflowFiles.join(', ')}); a maintainer must ` +
        're-land it from a same-repository branch',
    );
  }
  const runs = validationRuns
    .filter((run) => run.head_sha === expectedHeadSha && run.event === 'pull_request')
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const latest = runs[0];
  if (!latest) {
    problems.push(
      `no Fork PR Validation run exists for ${expectedHeadSha}; approve the workflow run first`,
    );
  } else if (latest.status !== 'completed') {
    problems.push(`Fork PR Validation for ${expectedHeadSha} is still ${latest.status}`);
  } else if (latest.conclusion !== 'success') {
    problems.push(
      `Fork PR Validation for ${expectedHeadSha} concluded ${latest.conclusion} (${latest.html_url})`,
    );
  }
  return problems;
}

/**
 * The required-context gate for a fork PR.
 *
 * @param {{ runAttempt: number } & Parameters<typeof approvalProblems>[0]} input
 */
export function gateProblems({ runAttempt, ...input }) {
  if (!(runAttempt > 1)) {
    return [
      'fork PRs pass this check only after a maintainer reviews the change, ' +
        `confirms Fork PR Validation passed, and applies \`${APPROVAL_LABEL}\``,
    ];
  }
  return approvalProblems(input);
}

/**
 * Picks the GitHub Actions job behind each required context on the head.
 *
 * @param {any[]} checkRuns check runs on the head commit
 * @returns {{ jobs: { context: string, id: number }[], problems: string[] }}
 */
export function selectRequiredJobs(checkRuns) {
  const jobs = [];
  const problems = [];
  for (const context of REQUIRED_CONTEXTS) {
    const latest = checkRuns
      .filter((run) => run.name === context && run.app?.slug === ACTIONS_APP_SLUG)
      .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))[0];
    if (!latest) {
      problems.push(`no \`${context}\` check exists on the head yet`);
    } else if (latest.status !== 'completed') {
      problems.push(`\`${context}\` is still ${latest.status}; re-apply the label when it finishes`);
    } else {
      jobs.push({ context, id: latest.id });
    }
  }
  return { jobs, problems };
}

async function api(path, { method = 'GET', token, body } = {}) {
  const url = path.startsWith('https://') ? path : `https://api.github.com/${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${method} ${url} failed: ${response.status} ${await response.text()}`);
  }
  const next = response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
  const data = response.status === 204 ? null : await response.json();
  return { data, next };
}

async function paginate(path, token, pick = (data) => data) {
  const items = [];
  let url = path;
  while (url) {
    const { data, next } = await api(url, { token });
    items.push(...pick(data));
    url = next;
  }
  return items;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function loadApprovalInput({ repo, prNumber, headSha, token }) {
  const { data: pr } = await api(`repos/${repo}/pulls/${prNumber}`, { token });
  const files = await paginate(`repos/${repo}/pulls/${prNumber}/files?per_page=100`, token);
  const validationRuns = await paginate(
    `repos/${repo}/actions/workflows/${FORK_VALIDATION_WORKFLOW}/runs?` +
      `event=pull_request&head_sha=${headSha}&per_page=100`,
    token,
    (data) => data.workflow_runs,
  );
  return { expectedHeadSha: headSha, pr, files, validationRuns };
}

function report(problems, success) {
  if (problems.length === 0) {
    console.log(success);
    return 0;
  }
  for (const problem of problems) {
    console.log(`::error::${problem}`);
  }
  return 1;
}

async function main(command) {
  const token = requireEnv('GITHUB_TOKEN');
  const repo = requireEnv('GITHUB_REPOSITORY');
  const prNumber = requireEnv('PR_NUMBER');
  const headSha = requireEnv('HEAD_SHA');
  const input = await loadApprovalInput({ repo, prNumber, headSha, token });

  if (command === 'gate') {
    const runAttempt = Number(requireEnv('GITHUB_RUN_ATTEMPT'));
    return report(
      gateProblems({ runAttempt, ...input }),
      `Fork PR head ${headSha} is maintainer-approved and passed Fork PR Validation.`,
    );
  }

  if (command === 'approve') {
    const problems = approvalProblems(input);
    if (problems.length > 0) {
      return report(problems, '');
    }
    const checkRuns = await paginate(
      `repos/${repo}/commits/${headSha}/check-runs?per_page=100`,
      token,
      (data) => data.check_runs,
    );
    const { jobs, problems: jobProblems } = selectRequiredJobs(checkRuns);
    if (jobProblems.length > 0) {
      return report(jobProblems, '');
    }
    for (const job of jobs) {
      // A GitHub Actions check run id is its job id.
      await api(`repos/${repo}/actions/jobs/${job.id}/rerun`, { method: 'POST', token });
      console.log(`Re-ran ${job.context} (job ${job.id}) for ${headSha}.`);
    }
    return 0;
  }

  throw new Error(`usage: fork-pr-approval.mjs <gate|approve>`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.log(`::error::${error.message}`);
      process.exitCode = 1;
    },
  );
}
