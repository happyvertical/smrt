#!/usr/bin/env node
/**
 * Maintainer approval gate for external fork pull requests (#4558).
 *
 * Fork PRs never run with trusted credentials before merge. Their code is
 * validated in the sandboxed `Fork PR Validation` workflow (`pull_request`,
 * read-only token, no secrets). The required contexts `Required CI` and
 * `postgres-required` run on `pull_request` (#4881) and, for a fork PR, run
 * only this script, checked out from the PR's base commit. Their YAML is the
 * fork's merge commit, so the gate holds while the fork leaves `.github/`
 * alone, which `guard` reports before anyone approves the fork's runs.
 *
 *   guard    Runs on every fork PR push. Fails when the PR touches
 *            `.github/` (or its file list is incomplete), so maintainers see
 *            that before approving any fork workflow run.
 *   approve  Runs when someone applies the approval label. Requires that the
 *            labeller has write access and that a write-access user submitted
 *            an Approve review on that exact head commit, then records a
 *            `fork-approval` commit status on it and re-runs the required jobs.
 *   gate     Runs inside the required jobs for a fork PR. Passes only when
 *            the current head carries that status from GitHub Actions, the
 *            label is still present, the sandbox run for the head succeeded,
 *            and the PR leaves `.github/` alone.
 *
 * The status binds approval to one commit: a fork cannot write statuses to
 * this repository, and a new push is a new SHA with no status. The merge
 * queue's full trusted validation still gates every merge.
 */

import { pathToFileURL } from 'node:url';

export const APPROVAL_LABEL = 'ci: fork-approved';
export const APPROVAL_STATUS_CONTEXT = 'fork-approval';
export const FORK_VALIDATION_WORKFLOW = 'fork-pr-validation.yml';
export const REQUIRED_CONTEXTS = ['Required CI', 'postgres-required'];
const ACTIONS_APP_SLUG = 'github-actions';
const ACTIONS_BOT_LOGIN = 'github-actions[bot]';
const APPROVER_PERMISSIONS = new Set(['admin', 'write']);
// GET pulls/{n}/files stops at this many files without reporting truncation.
const PR_FILES_API_LIMIT = 3000;

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
export function fileProblems(pr, files) {
  const problems = [];
  if (pr.changed_files >= PR_FILES_API_LIMIT || files.length !== pr.changed_files) {
    problems.push(
      `the changed-file list is incomplete (${files.length} of ${pr.changed_files}); ` +
        'a maintainer must re-land this PR from a same-repository branch',
    );
  }
  const workflowFiles = files.filter(touchesGithubDir).map((file) => file.filename);
  if (workflowFiles.length > 0) {
    problems.push(
      `the PR changes .github/ (${workflowFiles.join(', ')}); do not approve its workflow ` +
        'runs, and re-land it from a same-repository branch',
    );
  }
  return problems;
}

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
  problems.push(...fileProblems(pr, files));
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
 * Whether the labeller may approve: write, maintain or admin access. The
 * collaborator-permission API reports maintain as `write` and triage as `read`.
 *
 * @param {{ permission?: string } | null} permission API response, null on error
 */
export function senderProblems(sender, permission) {
  if (APPROVER_PERMISSIONS.has(permission?.permission)) {
    return [];
  }
  return [
    `${sender} applied \`${APPROVAL_LABEL}\` without write access ` +
      `(${permission?.permission ?? 'unknown'}); only maintainers can approve a fork PR`,
  ];
}

/**
 * Users whose current review approves exactly `headSha`. A user's current
 * review is their latest APPROVED, CHANGES_REQUESTED or DISMISSED one, as
 * GitHub counts it; comment-only reviews do not change it.
 *
 * @param {any[]} reviews pull request reviews in API (chronological) order
 */
export function headApprovers(reviews, headSha) {
  const current = new Map();
  for (const review of reviews) {
    if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state) && review.user) {
      current.set(review.user.login, review);
    }
  }
  return [...current.values()]
    .filter((review) => review.state === 'APPROVED' && review.commit_id === headSha)
    .map((review) => review.user.login);
}

/**
 * The required-context gate for a fork PR.
 *
 * @param {{ statuses: any[] } & Parameters<typeof approvalProblems>[0]} input
 *   statuses: commit statuses on the head, newest first (the API's order)
 */
export function gateProblems({ statuses, ...input }) {
  const approval = statuses.find((status) => status.context === APPROVAL_STATUS_CONTEXT);
  const problems = [];
  if (
    approval?.state !== 'success' ||
    approval.creator?.login !== ACTIONS_BOT_LOGIN
  ) {
    problems.push(
      `awaiting maintainer approval of ${input.expectedHeadSha}: a maintainer reviews ` +
        'and approves this commit, confirms Fork PR Validation passed, and applies ' +
        `\`${APPROVAL_LABEL}\``,
    );
  }
  return [...problems, ...approvalProblems(input)];
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
      problems.push(
        `\`${context}\` is still ${latest.status}; remove and re-add the label when it finishes`,
      );
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

async function loadFiles({ repo, prNumber, token }) {
  const { data: pr } = await api(`repos/${repo}/pulls/${prNumber}`, { token });
  const files = await paginate(`repos/${repo}/pulls/${prNumber}/files?per_page=100`, token);
  return { pr, files };
}

async function loadApprovalInput({ repo, prNumber, headSha, token }) {
  const { pr, files } = await loadFiles({ repo, prNumber, token });
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

async function readPermission(repo, login, token) {
  try {
    const { data } = await api(
      `repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
      { token },
    );
    return data;
  } catch (error) {
    console.log(`::warning::could not read ${login}'s permission: ${error.message}`);
    return null;
  }
}

async function reviewProblems({ repo, prNumber, headSha, token }) {
  const reviews = await paginate(`repos/${repo}/pulls/${prNumber}/reviews?per_page=100`, token);
  for (const login of headApprovers(reviews, headSha)) {
    if (senderProblems(login, await readPermission(repo, login, token)).length === 0) {
      return [];
    }
  }
  return [
    `no maintainer has submitted an Approve review on ${headSha}; review this exact ` +
      'commit, approve it, then remove and re-add the label',
  ];
}

async function approve({ repo, prNumber, headSha, token, input }) {
  const sender = requireEnv('SENDER');
  const problems = [
    ...senderProblems(sender, await readPermission(repo, sender, token)),
    ...(await reviewProblems({ repo, prNumber, headSha, token })),
    ...approvalProblems(input),
  ];
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
  await api(`repos/${repo}/statuses/${headSha}`, {
    method: 'POST',
    token,
    body: {
      state: 'success',
      context: APPROVAL_STATUS_CONTEXT,
      description: `Approved by ${sender}`.slice(0, 140),
    },
  });
  console.log(`Recorded ${APPROVAL_STATUS_CONTEXT} on ${headSha} for ${sender}.`);
  for (const job of jobs) {
    // A GitHub Actions check run id is its job id.
    await api(`repos/${repo}/actions/jobs/${job.id}/rerun`, { method: 'POST', token });
    console.log(`Re-ran ${job.context} (job ${job.id}) for ${headSha}.`);
  }
  return 0;
}

async function main(command) {
  const token = requireEnv('GITHUB_TOKEN');
  const repo = requireEnv('GITHUB_REPOSITORY');
  const prNumber = requireEnv('PR_NUMBER');
  if (command === 'guard') {
    const { pr, files } = await loadFiles({ repo, prNumber, token });
    return report(fileProblems(pr, files), 'The PR leaves .github/ unchanged.');
  }
  const headSha = requireEnv('HEAD_SHA');
  const input = await loadApprovalInput({ repo, prNumber, headSha, token });

  if (command === 'gate') {
    const statuses = await paginate(
      `repos/${repo}/commits/${headSha}/statuses?per_page=100`,
      token,
    );
    return report(
      gateProblems({ statuses, ...input }),
      `Fork PR head ${headSha} is maintainer-approved and passed Fork PR Validation.`,
    );
  }
  if (command === 'approve') {
    return approve({ repo, prNumber, headSha, token, input });
  }
  throw new Error('usage: fork-pr-approval.mjs <guard|gate|approve>');
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
