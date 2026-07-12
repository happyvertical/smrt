#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
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

  if (missing.length > 0) {
    throw new Error(
      `Registry verification failed for: ${missing.map((entry) => entry.name).join(', ')}`,
    );
  }

  log(
    `✅ Published and verified ${release.packages.length} artifacts for ${release.releaseVersion}`,
  );
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
    publishValidatedArtifacts(artifactDir);
  } catch (error) {
    console.error(`❌ ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
