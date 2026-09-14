#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { verifyPublishArtifacts } from './publish-artifacts-lib.mjs';

const registry = 'https://registry.npmjs.org/';
const defaultVerificationAttempts = 6;
const defaultInitialVerificationDelayMs = 5_000;
const defaultMaxVerificationDelayMs = 30_000;

function npm(args, { allowNotFound = false } = {}) {
  const result = spawnSync('npm', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (allowNotFound && /E404|404 Not Found/.test(result.stderr)) return null;
    throw new Error(result.stderr.trim() || `npm ${args.join(' ')} failed`);
  }
  return result.stdout.trim();
}

function existsOnRegistry(name, version, runNpm) {
  return (
    runNpm(
      [
        'view',
        `${name}@${version}`,
        'version',
        '--registry',
        registry,
        '--prefer-online',
      ],
      {
        allowNotFound: true,
      },
    ) !== null
  );
}

function waitSynchronously(delayMs) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}

export function publishRelease(
  release,
  {
    initialVerificationDelayMs = defaultInitialVerificationDelayMs,
    log = console.log,
    maxVerificationDelayMs = defaultMaxVerificationDelayMs,
    runNpm = npm,
    verificationAttempts = defaultVerificationAttempts,
    wait = waitSynchronously,
  } = {},
) {
  for (const artifact of release.packages) {
    if (existsOnRegistry(artifact.name, artifact.version, runNpm)) {
      log(`↪ ${artifact.name}@${artifact.version} already exists`);
      continue;
    }
    log(`📤 Publishing ${artifact.name}@${artifact.version}`);
    runNpm([
      'publish',
      artifact.path,
      '--registry',
      registry,
      '--access',
      'public',
    ]);
  }

  let missing = [];
  for (let attempt = 1; attempt <= verificationAttempts; attempt += 1) {
    missing = release.packages.filter(
      (artifact) =>
        !existsOnRegistry(artifact.name, artifact.version, runNpm),
    );

    if (missing.length === 0) break;
    if (attempt === verificationAttempts) continue;

    const delayMs = Math.min(
      initialVerificationDelayMs * 2 ** (attempt - 1),
      maxVerificationDelayMs,
    );
    log(
      `⏳ Registry verification attempt ${attempt}/${verificationAttempts} missing ${missing
        .map((entry) => entry.name)
        .join(', ')}; retrying in ${delayMs}ms`,
    );
    wait(delayMs);
  }

  // Every `npm publish` call above either succeeded or threw, so by this
  // point the release is already on the registry as far as npm is
  // concerned — publication is irreversible and complete. A `npm view`
  // miss here reflects registry read-path propagation lag, not a failed
  // publish, so it must never fail the run and strand the commit/tag that
  // depend on this step succeeding. Report it and let the caller record
  // the release; a later, separate check can keep confirming propagation
  // without gating anything.
  if (missing.length > 0) {
    log(
      `⚠️ Registry verification did not observe ${missing
        .map((entry) => entry.name)
        .join(', ')} after ${verificationAttempts} attempts. Publication already happened and is irreversible; treating this as propagation lag, not a failure. Recording the release and continuing.`,
    );
  } else {
    log(
      `✅ Published and verified ${release.packages.length} artifacts for ${release.releaseVersion}`,
    );
  }

  return {
    releaseVersion: release.releaseVersion,
    published: release.packages.map((artifact) => artifact.name),
    unverified: missing.map((artifact) => artifact.name),
  };
}

export function publishValidatedArtifacts(
  artifactDir,
  { verify = verifyPublishArtifacts, ...options } = {},
) {
  return publishRelease(verify(artifactDir), options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const artifactDir = process.argv[2];
    if (!artifactDir) {
      throw new Error(
        'Usage: publish-validated-artifacts.mjs <artifact-directory>',
      );
    }
    const result = publishValidatedArtifacts(artifactDir);
    if (result.unverified.length > 0) {
      // Advisory only: the packages are already published and that cannot
      // be undone. Surface it as a workflow annotation so it stays visible
      // without failing a run whose commit/tag recording must still happen.
      console.log(
        `::warning::Registry read-path did not confirm ${result.unverified.join(', ')} for v${result.releaseVersion} within the retry budget; publication is already complete on npm. If this persists after the run finishes, re-check manually — do not re-run the batch.`,
      );
      const summaryPath = process.env.GITHUB_STEP_SUMMARY;
      if (summaryPath) {
        appendFileSync(
          summaryPath,
          `\n### ⚠️ Registry verification lag for v${result.releaseVersion}\n\nNot yet visible via \`npm view\` after retries (publish already succeeded):\n\n${result.unverified.map((name) => `- ${name}`).join('\n')}\n`,
        );
      }
    }
  } catch (error) {
    console.error(`❌ ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
