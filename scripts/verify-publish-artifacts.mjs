#!/usr/bin/env node

import { verifyPublishArtifacts } from './publish-artifacts-lib.mjs';

try {
  const artifactDir = process.argv[2];
  if (!artifactDir) {
    throw new Error('Usage: verify-publish-artifacts.mjs <artifact-directory>');
  }
  const result = verifyPublishArtifacts(artifactDir);
  console.log(
    `✅ Verified ${result.packages.length} package artifacts for ${result.releaseVersion}`,
  );
} catch (error) {
  console.error(`❌ ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
