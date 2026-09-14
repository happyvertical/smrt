import assert from 'node:assert/strict';
import test from 'node:test';
import { publishRelease } from './publish-validated-artifacts.mjs';

function release() {
  return {
    releaseVersion: '0.40.0',
    packages: [
      {
        name: '@happyvertical/smrt-a',
        version: '0.40.0',
        path: '/artifacts/a.tgz',
      },
      {
        name: '@happyvertical/smrt-b',
        version: '0.40.0',
        path: '/artifacts/b.tgz',
      },
    ],
  };
}

test('skips existing versions, publishes the missing tarball, and verifies all', () => {
  const published = new Set(['@happyvertical/smrt-a@0.40.0']);
  const calls = [];
  const runNpm = (args) => {
    calls.push(args);
    if (args[0] === 'view') {
      const packageVersion = args[1];
      return published.has(packageVersion) ? '0.40.0' : null;
    }
    assert.deepEqual(args, [
      'publish',
      '/artifacts/b.tgz',
      '--registry',
      'https://registry.npmjs.org/',
      '--access',
      'public',
    ]);
    published.add('@happyvertical/smrt-b@0.40.0');
    return '';
  };

  publishRelease(release(), { runNpm, log: () => {} });

  assert.equal(
    calls.filter((args) => args[0] === 'publish').length,
    1,
  );
  assert.deepEqual(published, new Set([
    '@happyvertical/smrt-a@0.40.0',
    '@happyvertical/smrt-b@0.40.0',
  ]));
});

test('reports but does not fail when registry verification still reports a package missing', () => {
  const waits = [];
  const logs = [];

  const result = publishRelease(
    {
      releaseVersion: '0.40.0',
      packages: [
        {
          name: '@happyvertical/smrt-a',
          version: '0.40.0',
          path: '/artifacts/a.tgz',
        },
      ],
    },
    {
      runNpm: (args) => (args[0] === 'publish' ? '' : null),
      log: (message) => logs.push(message),
      initialVerificationDelayMs: 1,
      maxVerificationDelayMs: 1,
      verificationAttempts: 3,
      wait: (delayMs) => waits.push(delayMs),
    },
  );

  assert.deepEqual(waits, [1, 1]);
  assert.deepEqual(result.unverified, ['@happyvertical/smrt-a']);
  assert.deepEqual(result.published, ['@happyvertical/smrt-a']);
  assert.ok(
    logs.some((message) => /propagation lag, not a failure/.test(message)),
    'expected a non-fatal propagation-lag warning to be logged',
  );
});

test('publish command failures remain fatal even though verification misses are not', () => {
  assert.throws(
    () =>
      publishRelease(
        {
          releaseVersion: '0.40.0',
          packages: [
            {
              name: '@happyvertical/smrt-a',
              version: '0.40.0',
              path: '/artifacts/a.tgz',
            },
          ],
        },
        {
          runNpm: (args) => {
            if (args[0] === 'view') return null;
            throw new Error('npm publish EAUTH: authentication failed');
          },
          log: () => {},
        },
      ),
    /EAUTH/,
  );
});

test('retries delayed registry visibility before failing the release', () => {
  let viewCount = 0;
  const waits = [];

  publishRelease(
    {
      releaseVersion: '0.40.0',
      packages: [
        {
          name: '@happyvertical/smrt-a',
          version: '0.40.0',
          path: '/artifacts/a.tgz',
        },
      ],
    },
    {
      initialVerificationDelayMs: 10,
      log: () => {},
      runNpm: (args) => {
        if (args[0] === 'publish') return '';
        viewCount += 1;
        return viewCount >= 4 ? '0.40.0' : null;
      },
      verificationAttempts: 3,
      wait: (delayMs) => waits.push(delayMs),
    },
  );

  assert.deepEqual(waits, [10, 20]);
  assert.equal(viewCount, 4);
});

test('forces registry views to revalidate cached package metadata', () => {
  const viewCalls = [];

  publishRelease(
    {
      releaseVersion: '0.40.0',
      packages: [
        {
          name: '@happyvertical/smrt-a',
          version: '0.40.0',
          path: '/artifacts/a.tgz',
        },
      ],
    },
    {
      log: () => {},
      runNpm: (args) => {
        if (args[0] === 'view') viewCalls.push(args);
        return '0.40.0';
      },
    },
  );

  assert.ok(
    viewCalls.every((args) => args.includes('--prefer-online')),
    'npm view calls must bypass stale negative cache entries',
  );
});
