#!/usr/bin/env node
// Proves the publish job can authenticate to npm by OIDC trusted publishing
// BEFORE the irreversible release phase starts (#2998). A long-lived
// NPM_TOKEN used to be the only credential, and the old check only asserted it
// was non-empty: when the token expired, the run got all the way to the first
// `npm publish` before failing with a misleading E404.

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// First npm release that exchanges a GitHub OIDC token for publish rights.
export const MIN_NPM_VERSION = '11.5.1';

function compareVersions(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function findTrustedPublishProblems({ env, npmVersion }) {
  const problems = [];

  if (env.RUNNER_ENVIRONMENT !== 'github-hosted') {
    problems.push(
      `runner environment is "${env.RUNNER_ENVIRONMENT || 'unknown'}": npm trusted publishing only accepts GitHub-hosted runners, so the publish job must not run on the self-hosted ARC pool`,
    );
  }

  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    problems.push(
      'no GitHub OIDC token endpoint in the environment: both the calling workflow and publish.yml must grant `id-token: write`',
    );
  }

  if (!/^\d+\.\d+\.\d+/.test(npmVersion || '')) {
    problems.push(`could not read the npm version (got "${npmVersion}")`);
  } else if (compareVersions(npmVersion, MIN_NPM_VERSION) < 0) {
    problems.push(
      `npm ${npmVersion} cannot publish by OIDC; ${MIN_NPM_VERSION} or newer is required`,
    );
  }

  return problems;
}

function main() {
  const result = spawnSync('npm', ['--version'], { encoding: 'utf8' });
  const npmVersion = (result.stdout || '').trim();
  const problems = findTrustedPublishProblems({
    env: process.env,
    npmVersion,
  });

  if (problems.length > 0) {
    console.error('❌ npm trusted publishing preflight failed:');
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(
      'See CHANGESETS.md ("npm authentication") for the trusted publisher setup.',
    );
    process.exit(1);
  }

  console.log(
    `✅ npm ${npmVersion} on a GitHub-hosted runner with an OIDC token endpoint; publishing as a trusted publisher.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main();
}
