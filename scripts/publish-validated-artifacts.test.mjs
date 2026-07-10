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

test('fails when registry verification still reports a package missing', () => {
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
          runNpm: (args) => (args[0] === 'publish' ? '' : null),
          log: () => {},
        },
      ),
    /Registry verification failed/,
  );
});
