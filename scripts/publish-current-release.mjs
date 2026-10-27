#!/usr/bin/env node
/** Consume an already authorized immutable candidate in its original live run. */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createForge, REPOSITORY } from './release-admission.mjs';
import { createReleaseAdmissionStore } from './release-admission-store.mjs';
import { recoverRelease } from './recover-release.mjs';

export async function main(env = process.env) {
  if (env.GITHUB_REPOSITORY !== REPOSITORY || env.GITHUB_REF !== 'refs/heads/main' ||
    env.GITHUB_WORKFLOW_REF !== `${REPOSITORY}/.github/workflows/on-merge-main.yml@refs/heads/main`) throw new Error('Active publishing requires trusted main Batched Release');
  const activeOwner = { runId: Number(env.GITHUB_RUN_ID), runAttempt: Number(env.GITHUB_RUN_ATTEMPT) };
  if (!Number.isSafeInteger(activeOwner.runId) || activeOwner.runId <= 0 || !Number.isSafeInteger(activeOwner.runAttempt) || activeOwner.runAttempt <= 0) throw new Error('Invalid active publisher identity');
  return recoverRelease({ store: createReleaseAdmissionStore({ repository: REPOSITORY, token: env.RELEASE_GITHUB_TOKEN }),
    forge: createForge({ readToken: env.GITHUB_TOKEN, writeToken: env.RELEASE_GITHUB_TOKEN }),
    owner: activeOwner, activeOwner, repoRoot: resolve(process.cwd()), readToken: env.GITHUB_TOKEN, writeToken: env.RELEASE_GITHUB_TOKEN });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`Active publication remains fenced: ${error.message}`); process.exitCode = 1; });
}
