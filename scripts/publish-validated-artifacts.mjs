#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { verifyPublishArtifacts } from './publish-artifacts-lib.mjs';

const registry = 'https://registry.npmjs.org/';

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
    runNpm(['view', `${name}@${version}`, 'version', '--registry', registry], {
      allowNotFound: true,
    }) !== null
  );
}

export function publishRelease(
  release,
  { runNpm = npm, log = console.log } = {},
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

  const missing = release.packages.filter(
    (artifact) =>
      !existsOnRegistry(artifact.name, artifact.version, runNpm),
  );
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
