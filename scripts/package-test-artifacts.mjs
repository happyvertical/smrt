import { spawnSync } from 'node:child_process';

/** Test artifacts are not runtime files; preserve helpers such as test-support.js. */
export function isTestArtifact(path) {
  const normalized = path.replaceAll('\\', '/');
  return /(?:^|\/)(?:__tests__|test-stubs)(?:\/|$)/.test(normalized) ||
    /\.(?:test|spec)\.[^/]+$/.test(normalized);
}

/** Inspect the actual tarball rather than approximating npm's files/ignore rules. */
export function assertNoPackedTests(tarballPath) {
  const result = spawnSync('tar', ['-tzf', tarballPath], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`Cannot inspect publish artifact ${tarballPath}: ${result.error?.message ?? result.stderr}`);
  }
  const tests = result.stdout.split('\n').filter(isTestArtifact);
  if (tests.length) {
    throw new Error(`Publish artifact contains test files:\n${tests.join('\n')}`);
  }
}
