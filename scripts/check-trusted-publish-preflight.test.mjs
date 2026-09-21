import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeExchangeFailures,
  findTrustedPublishProblems,
  findUntrustedPackages,
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

function fakeRegistry({ idTokenStatus = 200, trusted }) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.startsWith(readyEnv.ACTIONS_ID_TOKEN_REQUEST_URL)) {
      return {
        ok: idTokenStatus === 200,
        status: idTokenStatus,
        json: async () => ({ value: 'github-id-token' }),
      };
    }
    const name = decodeURIComponent(url.split('/package/')[1]);
    return trusted.includes(name)
      ? { ok: true, status: 201, json: async () => ({ token: 'npm_short' }) }
      : {
          ok: false,
          status: 404,
          json: async () => ({ message: 'no trusted publisher' }),
        };
  };
  return { calls, fetchImpl };
}

test('every package is exchanged with the GitHub ID token, as the npm CLI does', async () => {
  const names = ['@happyvertical/smrt-ads', '@happyvertical/smrt-core'];
  const { calls, fetchImpl } = fakeRegistry({ trusted: names });

  assert.deepEqual(
    await findUntrustedPackages({ names, env: readyEnv, fetchImpl }),
    { untrusted: [], unreachable: [] },
  );
  assert.equal(
    calls[0].url,
    'https://example.invalid/oidc?audience=npm%3Aregistry.npmjs.org',
  );
  assert.equal(calls[0].init.headers.Authorization, 'Bearer request-token');
  assert.equal(
    calls[1].url,
    'https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/@happyvertical%2fsmrt-ads',
  );
  assert.equal(calls[1].init.method, 'POST');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer github-id-token');
  assert.equal(calls.length, 3);
});

test('an unregistered package is reported without stopping at the first one', async () => {
  const { fetchImpl } = fakeRegistry({ trusted: ['@happyvertical/smrt-core'] });

  assert.deepEqual(
    await findUntrustedPackages({
      names: [
        '@happyvertical/smrt-ads',
        '@happyvertical/smrt-core',
        '@happyvertical/smrt-new',
      ],
      env: readyEnv,
      fetchImpl,
    }),
    {
      untrusted: [
        '@happyvertical/smrt-ads (HTTP 404: no trusted publisher)',
        '@happyvertical/smrt-new (HTTP 404: no trusted publisher)',
      ],
      unreachable: [],
    },
  );
});

test('a refused GitHub ID token fails instead of reporting every package', async () => {
  const { fetchImpl } = fakeRegistry({ idTokenStatus: 403, trusted: [] });

  await assert.rejects(
    findUntrustedPackages({
      names: ['@happyvertical/smrt-core'],
      env: readyEnv,
      fetchImpl,
    }),
    /did not issue an OIDC ID token \(HTTP 403\)/,
  );
});

test('a transient registry error is retried, then reported as unreachable, never as unregistered', async () => {
  const statuses = { '@happyvertical/smrt-flaky': [502, 201], '@happyvertical/smrt-down': [503, 429, 500] };
  const delays = [];
  const fetchImpl = async (url) => {
    if (url.startsWith(readyEnv.ACTIONS_ID_TOKEN_REQUEST_URL)) {
      return { ok: true, status: 200, json: async () => ({ value: 'id' }) };
    }
    const status = statuses[decodeURIComponent(url.split('/package/')[1])].shift();
    return {
      ok: status < 300,
      status,
      json: async () => (status < 300 ? { token: 'npm_short' } : {}),
    };
  };

  assert.deepEqual(
    await findUntrustedPackages({
      names: Object.keys(statuses),
      env: readyEnv,
      fetchImpl,
      sleep: async (ms) => delays.push(ms),
      retryDelayMs: 10,
    }),
    { untrusted: [], unreachable: ['@happyvertical/smrt-down (HTTP 500)'] },
  );
  assert.deepEqual(delays, [10, 10, 20]);
});

test('failure messages separate availability, run identity, and missing registration', () => {
  const env = { GITHUB_WORKFLOW_REF: 'happyvertical/smrt/.github/workflows/publish.yml@refs/heads/main' };

  const [availability] = describeExchangeFailures({
    untrusted: [], unreachable: ['a (HTTP 503)'], total: 3, env,
  });
  assert.match(availability, /not a registration problem/);

  const [identity] = describeExchangeFailures({
    untrusted: ['a (HTTP 404)', 'b (HTTP 404)'], unreachable: [], total: 2, env,
  });
  assert.match(identity, /ALL 2 packages/);
  assert.match(identity, /workflows\/publish\.yml@refs\/heads\/main/);
  assert.doesNotMatch(identity, /register happyvertical\/smrt \+/);

  const [registration] = describeExchangeFailures({
    untrusted: ['a (HTTP 404)'], unreachable: [], total: 2, env,
  });
  assert.match(registration, /1 of 2 packages; register happyvertical\/smrt/);

  assert.deepEqual(
    describeExchangeFailures({ untrusted: [], unreachable: [], total: 2, env }),
    [],
  );
});
