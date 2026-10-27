#!/usr/bin/env node
/** Clean privileged runner only: verify bytes as data; never execute candidate code. */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createController, createForge, REPOSITORY } from './release-admission.mjs';
import { createReleaseAdmissionStore } from './release-admission-store.mjs';
import { validateReleaseRecoveryArtifacts } from './release-admission-state.mjs';
import { withReleaseArtifacts } from './recover-release.mjs';

const check = (condition, message) => { if (!condition) throw new Error(message); };
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

export async function authorizeRelease({ store, forge, owner, sourceSha, version, releaseCommitSha, repoRoot, readToken, expectedArtifacts, io = {} }) {
  check(sha(sourceSha) && sha(releaseCommitSha) && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version), 'Invalid sealed candidate identity');
  const current = (await store.read())?.state;
  check(current?.repository === REPOSITORY && current.phase === 'qualifying' &&
    current.owner?.runId === owner.runId && current.owner?.runAttempt === owner.runAttempt && current.snapshotSha === sourceSha, 'Authorization must own the exact qualifying window');
  const run = await forge.request(`actions/runs/${owner.runId}/attempts/${owner.runAttempt}`);
  const workflow = await forge.request(`actions/workflows/${run.workflow_id}`);
  check(run.id === owner.runId && run.run_attempt === owner.runAttempt && run.status === 'in_progress' &&
    run.repository?.full_name === REPOSITORY && run.head_repository?.full_name === REPOSITORY &&
    run.path === '.github/workflows/on-merge-main.yml' && workflow.path === run.path, 'Untrusted authorization owner');
  const names = [`release-candidate-${owner.runId}-${owner.runAttempt}`, ...[1, 2].map(shard => `publish-release-pack-${owner.runId}-${owner.runAttempt}-${shard}`)];
  const bound = validateReleaseRecoveryArtifacts(expectedArtifacts);
  check(JSON.stringify(bound.map(a => a.name).sort()) === JSON.stringify([...names].sort()), 'Expected producer artifact names mismatch');
  const artifacts = await forge.list(`actions/runs/${owner.runId}/artifacts`, 'artifacts');
  for (const expected of bound) {
    const matches = artifacts.filter(a => a.name === expected.name);
    check(matches.length === 1 && matches[0].id === expected.id && matches[0].digest === expected.digest &&
      matches[0].expired === false && matches[0].workflow_run?.id === owner.runId, 'Sealed artifact differs from immutable producer outputs');
  }
  const release = { snapshotSha: sourceSha, releaseCommitSha, version, ref: `refs/tags/v${version}`, recoveryArtifacts: validateReleaseRecoveryArtifacts(bound) };
  return withReleaseArtifacts({ forge, owner, release, repoRoot, readToken, io,
    consume: async ({ artifactDir, verify, restored }) => {
      const git = args => execFileSync('git', ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', restored.candidateRoot, ...args], { encoding: 'utf8' }).trim();
      const controller = io.controller ?? createController({ store, forge, git, verifyArtifacts: verify,
        candidateVersion: () => JSON.parse(git(['show', 'HEAD:package.json'])).version });
      // This is the only new write boundary. Full live private bypass checks
      // occur here, immediately before the original-owner CAS to publishing.
      return controller.beginPublishing(owner, { snapshotSha: sourceSha, version, artifactDir, expectedArtifacts: release.recoveryArtifacts });
    },
  });
}

export async function main(env = process.env) {
  check(env.GITHUB_REPOSITORY === REPOSITORY && env.GITHUB_REF === 'refs/heads/main' &&
    env.GITHUB_WORKFLOW_REF === `${REPOSITORY}/.github/workflows/on-merge-main.yml@refs/heads/main`, 'Authorization requires trusted main Batched Release');
  const owner = { runId: Number(env.GITHUB_RUN_ID), runAttempt: Number(env.GITHUB_RUN_ATTEMPT) };
  check(Number.isSafeInteger(owner.runId) && owner.runId > 0 && Number.isSafeInteger(owner.runAttempt) && owner.runAttempt > 0, 'Invalid authorization owner');
  const expectedArtifacts = [
    ['CANDIDATE', `release-candidate-${owner.runId}-${owner.runAttempt}`],
    ['PACK_1', `publish-release-pack-${owner.runId}-${owner.runAttempt}-1`],
    ['PACK_2', `publish-release-pack-${owner.runId}-${owner.runAttempt}-2`],
  ].map(([prefix, name]) => {
    const digest = env[`${prefix}_ARTIFACT_DIGEST`];
    check(typeof digest === 'string' && /^(sha256:)?[a-f0-9]{64}$/.test(digest), 'Missing immutable producer digest');
    return { id: Number(env[`${prefix}_ARTIFACT_ID`]), name, digest: `sha256:${digest.replace(/^sha256:/, '')}` };
  });
  validateReleaseRecoveryArtifacts(expectedArtifacts);
  return authorizeRelease({ expectedArtifacts, store: createReleaseAdmissionStore({ repository: REPOSITORY, token: env.RELEASE_GITHUB_TOKEN }),
    forge: createForge({ readToken: env.GITHUB_TOKEN, writeToken: env.RELEASE_GITHUB_TOKEN, fenceToken: env.FENCE_GITHUB_TOKEN }),
    owner, sourceSha: env.RELEASE_SOURCE_SHA, version: env.RELEASE_VERSION, releaseCommitSha: env.RELEASE_COMMIT_SHA,
    repoRoot: resolve(process.cwd()), readToken: env.GITHUB_TOKEN });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`Publication authorization refused: ${error.message}`); process.exitCode = 1; });
}
