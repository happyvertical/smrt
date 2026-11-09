#!/usr/bin/env node
// Environment guard for .github/workflows/desktop-release.yml.
//
// A workflow job that names an environment which does not exist creates it
// silently, with no reviewers and no branch rule, and secrets stored in it
// then pass a presence-only check. This guard reads the environment through
// the GitHub API and refuses unless it is protected the way the README
// requires:
//
//   - it exists (404 is a refusal: the API also answers 404 when the token
//     cannot read it, and either way the release must not go on);
//   - admins cannot bypass its protection rules (`can_admins_bypass: false`);
//   - a `required_reviewers` rule exists with at least one reviewer and
//     `prevent_self_review: true`;
//   - deployment branches are "selected branches" (`custom_branch_policies:
//     true`, `protected_branches: false`) and the policy list is exactly one
//     entry: the branch `main` (no tag rule, no pattern, no second branch).
//
// Honest scope: this catches the OWNER's mistake (a forgotten or auto-created
// environment). It is not a defence against an attacker: anyone who can
// change this workflow file can remove the step. The environment's own branch
// rule, which GitHub enforces before a job can read any secret, is the real
// control. Token permission: GitHub's permission table for fine-grained
// tokens lists GET /repos/{repo}/environments/{name} and
// .../deployment-branch-policies under "Actions: read". A workflow token with
// only `contents: read` has `actions: none`, so the job needs
// `permissions: { contents: read, actions: read }`, nothing broader. That has
// NOT been proven by a real run. If the token cannot read the environment
// (403, 401, or the 404 GitHub also answers) the guard FAILS CLOSED and names
// the permission. Never prints the token.
//
//   --repo <owner/name> --environment <name>      token in env GITHUB_TOKEN
//
// Node built-ins only. Exit 0 ok, 1 refused, 2 usage.

import { fileURLToPath } from 'node:url';

const OWNER_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ENV_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const REQUIRED_BRANCH = 'main';

const READ_HINT =
  'the workflow token needs "actions: read" (permissions: contents: read, actions: read; ' +
  "GitHub's permission table lists the environment endpoints under Actions: read)";

/**
 * Production API client. Returns `{ status, body }` and never throws on an HTTP
 * error status. `fetchImpl` is injectable.
 */
export function makeGitHubApi({
  token,
  apiUrl = 'https://api.github.com',
  fetchImpl = globalThis.fetch,
}) {
  return async (path) => {
    const response = await fetchImpl(`${apiUrl}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'error',
    });
    let body;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    return { status: response.status, body };
  };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Returns the list of problems (empty = the environment is protected as
 * required). `api(path)` resolves to `{ status, body }`.
 */
export async function checkEnvironment({ repo, environment, api }) {
  if (!OWNER_REPO.test(repo ?? '') || !ENV_NAME.test(environment ?? '')) {
    return ['the repository or environment name is not a plain name'];
  }
  const base = `/repos/${repo}/environments/${encodeURIComponent(environment)}`;

  let response;
  try {
    response = await api(base);
  } catch {
    return [`the GitHub API could not be reached to read environment ${environment}`];
  }
  if (response.status === 404) {
    return [
      `environment ${environment} was not found, or the token cannot read it (${READ_HINT}); ` +
        'create the environment by hand and protect it before storing any secret',
    ];
  }
  if (response.status === 401 || response.status === 403) {
    return [
      `the token was refused reading environment ${environment}: ${READ_HINT}`,
    ];
  }
  if (response.status !== 200 || !isObject(response.body)) {
    return [
      `reading environment ${environment} returned an unexpected answer (HTTP ${response.status})`,
    ];
  }
  const env = response.body;
  const problems = [];
  if (env.name !== environment) {
    problems.push('the API answered for a different environment');
  }

  if (env.can_admins_bypass !== false) {
    problems.push(
      `environment ${environment} lets repository admins bypass its protection rules (turn off "Allow administrators to bypass configured protection rules")`,
    );
  }

  const rules = Array.isArray(env.protection_rules) ? env.protection_rules : [];
  const reviewerRule = rules.find(
    (rule) => isObject(rule) && rule.type === 'required_reviewers',
  );
  if (
    !reviewerRule ||
    !Array.isArray(reviewerRule.reviewers) ||
    reviewerRule.reviewers.length === 0
  ) {
    problems.push(`environment ${environment} has no required reviewers`);
  } else if (reviewerRule.prevent_self_review !== true) {
    problems.push(
      `environment ${environment} allows the person who started the run to approve it (turn on "Prevent self-review")`,
    );
  }

  const policy = env.deployment_branch_policy;
  if (
    !isObject(policy) ||
    policy.custom_branch_policies !== true ||
    policy.protected_branches !== false
  ) {
    problems.push(
      `environment ${environment} deployment branches are not "Selected branches and tags" with a custom rule (any branch, or protected branches, can deploy to it)`,
    );
    return problems;
  }

  let policies;
  try {
    policies = await api(`${base}/deployment-branch-policies`);
  } catch {
    problems.push('the deployment branch rules could not be read');
    return problems;
  }
  if (policies.status !== 200 || !isObject(policies.body)) {
    problems.push(
      `the deployment branch rules of ${environment} could not be read (HTTP ${policies.status}); ${READ_HINT}`,
    );
    return problems;
  }
  const list = policies.body.branch_policies;
  if (
    !Array.isArray(list) ||
    policies.body.total_count !== list.length ||
    list.length !== 1 ||
    !isObject(list[0]) ||
    list[0].type !== 'branch' ||
    list[0].name !== REQUIRED_BRANCH
  ) {
    problems.push(
      `environment ${environment} deployment branches must be exactly the branch ${REQUIRED_BRANCH}: no tags, no patterns, no other branch`,
    );
  }
  return problems;
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!['--repo', '--environment'].includes(key) || value === undefined) {
      throw new Error(`bad option ${key}`);
    }
    options[key.slice(2)] = value;
  }
  return options;
}

/** Returns the exit code. `io.api` replaces the network client in tests. */
export async function main(argv, env, io = {}) {
  const out = io.stderr ?? ((text) => process.stderr.write(text));
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    out(`release environment: usage error: ${error.message}\n`);
    return 2;
  }
  if (!options.repo || !options.environment) {
    out('release environment: usage error: --repo and --environment needed\n');
    return 2;
  }
  let api = io.api;
  if (!api) {
    if (typeof env.GITHUB_TOKEN !== 'string' || env.GITHUB_TOKEN === '') {
      out(
        `release environment FAILED: no GITHUB_TOKEN to read the environment with; ${READ_HINT}.\n`,
      );
      return 1;
    }
    api = makeGitHubApi({
      token: env.GITHUB_TOKEN,
      apiUrl: env.GITHUB_API_URL || undefined,
    });
  }
  const problems = await checkEnvironment({
    repo: options.repo,
    environment: options.environment,
    api,
  });
  if (problems.length > 0) {
    out('release environment FAILED: the release path was not started.\n');
    for (const problem of problems) out(`  - ${problem}\n`);
    out(
      'See "Owner setup" in packages/smrt-desktop/shell/README.md. This check catches an owner mistake; the environment branch rule is the control.\n',
    );
    return 1;
  }
  out('release environment passed.\n');
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
