#!/usr/bin/env node
// Proves the publish job can authenticate to npm by OIDC trusted publishing
// BEFORE the irreversible release phase starts (#2998). A long-lived
// NPM_TOKEN used to be the only credential, and the old check only asserted it
// was non-empty: when the token expired, the run got all the way to the first
// `npm publish` before failing with a misleading E404.

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { verifyPublishArtifacts } from './publish-artifacts-lib.mjs';

const registry = 'https://registry.npmjs.org/';

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

// The checks above prove the runner CAN publish by OIDC, not that npm will
// accept it for each package: trusted publishers are registered per package,
// and npm exchanges the GitHub ID token per package name at publish time. One
// unregistered package would otherwise stop the batch part-way through an
// irreversible publish. This performs the same exchange the npm CLI does
// (lib/utils/oidc.js) for every package up front; the short-lived tokens it
// returns are discarded, never stored or printed.
export async function findUntrustedPackages({
  names,
  env,
  fetchImpl = fetch,
  attempts = 3,
  retryDelayMs = 2_000,
  requestTimeoutMs = 10_000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const idTokenUrl = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  idTokenUrl.searchParams.append('audience', `npm:${new URL(registry).hostname}`);
  const idTokenResponse = await fetchImpl(idTokenUrl.href, {
    signal: AbortSignal.timeout(requestTimeoutMs),
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`,
    },
  });
  const idToken = idTokenResponse.ok
    ? (await idTokenResponse.json()).value
    : undefined;
  if (!idToken) {
    throw new Error(
      `GitHub did not issue an OIDC ID token (HTTP ${idTokenResponse.status})`,
    );
  }

  const untrusted = [];
  const unreachable = [];
  const unrecognized = [];
  for (const name of names) {
    const url = new URL(
      `/-/npm/v1/oidc/token/exchange/package/${name.replace('/', '%2f')}`,
      registry,
    ).href;
    let response;
    let body = {};
    let thrown;
    // A 5xx/429 or a network error says nothing about whether the package is
    // registered, so it is retried and then reported as its own condition,
    // never as "register this package" — a wrong remedy is what made the
    // original E404 costly.
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      thrown = undefined;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          // Without this a stalled connection waits out undici's 300s default
          // per attempt and the step burns the job timeout instead of failing.
          signal: AbortSignal.timeout(requestTimeoutMs),
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${idToken}`,
          },
        });
        body = await response.json().catch(() => ({}));
      } catch (error) {
        thrown = error;
      }
      const transient =
        thrown || response.status >= 500 || response.status === 429;
      if (!transient || attempt === attempts) break;
      await sleep(retryDelayMs * attempt);
    }
    if (thrown) {
      // fetch rejects with a bare "fetch failed"; the DNS/TLS/socket reason
      // that tells "npm is down" from "this runner cannot reach npm" is on cause.
      unreachable.push(`${name} (${thrown.cause?.message ?? thrown.message})`);
      continue;
    }
    const detail = `${name} (HTTP ${response.status}${body.message ? `: ${body.message}` : ''})`;
    if (response.status >= 500 || response.status === 429) {
      unreachable.push(detail);
    } else if (!response.ok) {
      untrusted.push(detail);
    } else if (!body.token) {
      unrecognized.push(detail);
    }
  }
  return { untrusted, unreachable, unrecognized };
}

export function describeExchangeFailures({
  untrusted,
  unreachable,
  unrecognized = [],
  total,
  env,
}) {
  const problems = [];
  // Only packages npm actually answered for can tell identity from
  // registration; an unreachable one must not mask an all-refused run.
  const answered = total - unreachable.length - unrecognized.length;
  if (unrecognized.length > 0) {
    problems.push(
      `npm answered the trusted-publisher exchange successfully for ${unrecognized.length} of ${total} packages but without an exchange token, so this preflight's expected response shape is probably wrong — compare it with lib/utils/oidc.js in the installed npm before touching any npmjs registration: ${unrecognized[0]}`,
    );
  }
  if (unreachable.length > 0) {
    problems.push(
      `npm did not answer the trusted-publisher exchange for ${unreachable.length} of ${total} packages after retries; this is a registry availability problem, not a registration problem — re-run the job: ${unreachable.join(', ')}`,
    );
  }
  if (untrusted.length === answered && answered > 1) {
    problems.push(
      `npm refused the trusted-publisher exchange for ALL ${answered} packages it answered for. That points at this run's identity rather than ${answered} missing registrations: npm matches the CALLING workflow (this run: ${env.GITHUB_WORKFLOW_REF || 'unknown'}) against each package's registered publisher, so dispatching publish.yml directly fails unless it is registered too. First refusal: ${untrusted[0]}`,
    );
  } else if (untrusted.length > 0) {
    problems.push(
      `npm refused the trusted-publisher exchange for ${untrusted.length} of ${total} packages; register happyvertical/smrt + the calling workflow for each on npmjs (a new package needs one manual first publish): ${untrusted.join(', ')}`,
    );
  }
  return problems;
}

async function main() {
  const result = spawnSync('npm', ['--version'], { encoding: 'utf8' });
  const npmVersion = (result.stdout || '').trim();
  const problems = findTrustedPublishProblems({
    env: process.env,
    npmVersion,
  });

  const artifactDir = process.argv[2];
  if (problems.length === 0 && artifactDir) {
    const names = verifyPublishArtifacts(artifactDir).packages.map(
      (artifact) => artifact.name,
    );
    const failures = await findUntrustedPackages({ names, env: process.env });
    problems.push(
      ...describeExchangeFailures({
        ...failures,
        total: names.length,
        env: process.env,
      }),
    );
  }

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
  main().catch((error) => {
    console.error(`❌ npm trusted publishing preflight failed: ${error.message}`);
    process.exit(1);
  });
}
