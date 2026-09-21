import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findTrustedPublishProblems,
  MIN_NPM_VERSION,
} from './check-trusted-publish-preflight.mjs';

const readyEnv = {
  RUNNER_ENVIRONMENT: 'github-hosted',
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid/oidc',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token',
};

test('a hosted runner with OIDC and a current npm passes', () => {
  assert.deepEqual(
    findTrustedPublishProblems({ env: readyEnv, npmVersion: MIN_NPM_VERSION }),
    [],
  );
  assert.deepEqual(
    findTrustedPublishProblems({ env: readyEnv, npmVersion: '11.19.0' }),
    [],
  );
});

test('a self-hosted runner is rejected', () => {
  const problems = findTrustedPublishProblems({
    env: { ...readyEnv, RUNNER_ENVIRONMENT: 'self-hosted' },
    npmVersion: '11.19.0',
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /GitHub-hosted runners/);
});

test('a missing OIDC endpoint is rejected', () => {
  const problems = findTrustedPublishProblems({
    env: { RUNNER_ENVIRONMENT: 'github-hosted' },
    npmVersion: '11.19.0',
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /id-token: write/);
});

test('an npm too old for OIDC is rejected numerically, not lexically', () => {
  for (const npmVersion of ['11.5.0', '10.9.9', '9.12.0']) {
    const problems = findTrustedPublishProblems({ env: readyEnv, npmVersion });
    assert.equal(problems.length, 1, npmVersion);
    assert.match(problems[0], /cannot publish by OIDC/);
  }
  assert.deepEqual(
    findTrustedPublishProblems({ env: readyEnv, npmVersion: '11.10.0' }),
    [],
  );
});

test('an unreadable npm version is rejected', () => {
  const problems = findTrustedPublishProblems({ env: readyEnv, npmVersion: '' });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /could not read the npm version/);
});
