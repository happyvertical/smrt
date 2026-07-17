#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function fail(message) {
  throw new Error(message);
}

function requireCleanRefPart(value, label) {
  if (!value || !/^[A-Za-z0-9._/-]+$/.test(value)) {
    fail(`${label} contains unsupported characters: ${JSON.stringify(value)}`);
  }
}

function runGit(args, { env, label, spawn }) {
  const result = spawn('git', args, {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    fail(`${label}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    fail(`${label}:\n${result.stderr || result.stdout}`);
  }
}

export function pushReleaseRefs({
  baseBranch = process.env.RELEASE_BASE_BRANCH ?? 'main',
  dryRun = process.env.RELEASE_PUSH_DRY_RUN === 'true',
  githubToken = process.env.RELEASE_GITHUB_TOKEN,
  releaseVersion = process.env.RELEASE_VERSION,
  spawn = spawnSync,
} = {}) {
  if (!releaseVersion) {
    fail('RELEASE_VERSION is required to push release refs');
  }

  requireCleanRefPart(baseBranch, 'Release base branch');
  requireCleanRefPart(releaseVersion, 'Release version');

  if (!githubToken) {
    fail('RELEASE_GITHUB_TOKEN is required to push release refs');
  }

  const authHeader = `AUTHORIZATION: basic ${Buffer.from(
    `x-access-token:${githubToken}`,
  ).toString('base64')}`;
  const gitEnv = {
    ...process.env,
    // An empty extraHeader resets values inherited from checkout or global
    // Git config before the release App credential is added. GitHub rejects
    // requests containing multiple Authorization headers with HTTP 400.
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_1: authHeader,
    GIT_TERMINAL_PROMPT: '0',
  };
  const tag = `v${releaseVersion}`;
  const pushArgs = ['push'];

  if (dryRun) {
    pushArgs.push('--dry-run');
  }

  pushArgs.push(
    '--no-verify',
    '--atomic',
    'origin',
    `HEAD:refs/heads/${baseBranch}`,
    `refs/tags/${tag}:refs/tags/${tag}`,
  );

  runGit(
    pushArgs,
    {
      env: gitEnv,
      label: dryRun
        ? `Failed to preflight release ${tag} push to ${baseBranch}`
        : `Failed to atomically push release ${tag} to ${baseBranch}`,
      spawn,
    },
  );
}

const isCli =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  try {
    pushReleaseRefs();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
