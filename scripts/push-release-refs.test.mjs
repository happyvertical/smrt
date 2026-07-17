import assert from 'node:assert/strict';
import test from 'node:test';

import { pushReleaseRefs } from './push-release-refs.mjs';

test('resets inherited authentication before the atomic release push', () => {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stderr: '', stdout: '' };
  };

  pushReleaseRefs({
    baseBranch: 'main',
    githubToken: 'installation-token',
    releaseVersion: '0.39.3',
    spawn,
  });

  assert.deepEqual(
    calls.map(({ command, args }) => [command, ...args]),
    [
      [
        'git',
        'push',
        '--no-verify',
        '--atomic',
        'origin',
        'HEAD:refs/heads/main',
        'refs/tags/v0.39.3:refs/tags/v0.39.3',
      ],
    ],
  );

  for (const { options } of calls) {
    assert.equal(options.env.GIT_CONFIG_COUNT, '2');
    assert.equal(
      options.env.GIT_CONFIG_KEY_0,
      'http.https://github.com/.extraheader',
    );
    assert.equal(options.env.GIT_CONFIG_VALUE_0, '');
    assert.equal(
      options.env.GIT_CONFIG_KEY_1,
      'http.https://github.com/.extraheader',
    );
    assert.equal(
      options.env.GIT_CONFIG_VALUE_1,
      `AUTHORIZATION: basic ${Buffer.from(
        'x-access-token:installation-token',
      ).toString('base64')}`,
    );
  }
});

test('can preflight the exact atomic push without updating refs', () => {
  const calls = [];

  pushReleaseRefs({
    baseBranch: 'main',
    dryRun: true,
    githubToken: 'installation-token',
    releaseVersion: '0.40.7',
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stderr: '', stdout: '' };
    },
  });

  assert.deepEqual(
    calls.map(({ command, args }) => [command, ...args]),
    [
      [
        'git',
        'push',
        '--dry-run',
        '--no-verify',
        '--atomic',
        'origin',
        'HEAD:refs/heads/main',
        'refs/tags/v0.40.7:refs/tags/v0.40.7',
      ],
    ],
  );
});

test('fails before pushing when the GitHub App token is missing', () => {
  assert.throws(
    () =>
      pushReleaseRefs({
        baseBranch: 'main',
        githubToken: '',
        releaseVersion: '0.39.3',
        spawn: () => assert.fail('git must not run without authentication'),
      }),
    /RELEASE_GITHUB_TOKEN is required/,
  );
});

test('fails before pushing when the release version is missing', () => {
  assert.throws(
    () =>
      pushReleaseRefs({
        githubToken: 'installation-token',
        releaseVersion: '',
        spawn: () => assert.fail('git must not run without a release version'),
      }),
    /RELEASE_VERSION is required/,
  );
});

test('reports an atomic push failure without attempting a second write', () => {
  let calls = 0;

  assert.throws(
    () =>
      pushReleaseRefs({
        baseBranch: 'main',
        githubToken: 'installation-token',
        releaseVersion: '0.39.3',
        spawn: () => {
          calls += 1;
          return { status: 128, stderr: 'authentication failed', stdout: '' };
        },
      }),
    /Failed to atomically push release v0.39.3 to main/,
  );

  assert.equal(calls, 1);
});
