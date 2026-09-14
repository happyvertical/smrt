import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  publishRelease,
  reportUnverifiedPackages,
} from './publish-validated-artifacts.mjs';

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

test('skips existing versions with matching content, publishes the missing tarball, and verifies all', () => {
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

  publishRelease(release(), {
    runNpm,
    log: () => {},
    verifyExistingContentMatches: () => true,
  });

  assert.equal(
    calls.filter((args) => args[0] === 'publish').length,
    1,
  );
  assert.deepEqual(published, new Set([
    '@happyvertical/smrt-a@0.40.0',
    '@happyvertical/smrt-b@0.40.0',
  ]));
});

test('republishes instead of skipping when an existing version has different content', () => {
  const calls = [];
  const runNpm = (args) => {
    calls.push(args);
    if (args[0] === 'view') return '0.40.0';
    return '';
  };

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
      runNpm,
      log: () => {},
      // Simulates a version that already exists on the registry but was
      // built from different content than this run's verified artifact —
      // the resumable "skip already-published" path must not trust that
      // as a match.
      verifyExistingContentMatches: () => false,
    },
  );

  assert.deepEqual(
    calls.find((args) => args[0] === 'publish'),
    [
      'publish',
      '/artifacts/a.tgz',
      '--registry',
      'https://registry.npmjs.org/',
      '--access',
      'public',
    ],
  );
});

test('default content verification throws on a registry/local shasum mismatch instead of silently skipping', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'publish-validated-artifacts-'));
  const artifactPath = join(tmpDir, 'a.tgz');
  writeFileSync(artifactPath, 'local tarball bytes');
  const localShasum = createHash('sha1')
    .update(readFileSync(artifactPath))
    .digest('hex');

  try {
    assert.throws(
      () =>
        publishRelease(
          {
            releaseVersion: '0.40.0',
            packages: [
              {
                name: '@happyvertical/smrt-a',
                version: '0.40.0',
                path: artifactPath,
              },
            ],
          },
          {
            log: () => {},
            runNpm: (args) => {
              if (args[2] === 'dist.shasum') return 'not-the-same-shasum';
              if (args[0] === 'view') return '0.40.0';
              throw new Error('unexpected npm publish attempt');
            },
          },
        ),
      new RegExp(
        `does not match this run's verified local artifact sha1 ${localShasum}`,
      ),
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
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
      verifyExistingContentMatches: () => true,
    },
  );

  assert.ok(
    viewCalls.every((args) => args.includes('--prefer-online')),
    'npm view calls must bypass stale negative cache entries',
  );
});

test('verifies every already-existing package before publishing anything new, so a mismatch on one artifact cannot leave an earlier artifact newly (and irreversibly) published first', () => {
  const publishCalls = [];
  const runNpm = (args) => {
    if (args[0] === 'publish') {
      publishCalls.push(args[1]);
      return '';
    }
    return '0.40.0';
  };

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
            {
              name: '@happyvertical/smrt-b',
              version: '0.40.0',
              path: '/artifacts/b.tgz',
            },
          ],
        },
        {
          runNpm,
          log: () => {},
          // Only @happyvertical/smrt-b (later in the list) mismatches.
          verifyExistingContentMatches: (artifact) => {
            if (artifact.name === '@happyvertical/smrt-b') {
              throw new Error(`does not match for ${artifact.name}`);
            }
            return true;
          },
        },
      ),
    /does not match/,
  );

  assert.deepEqual(
    publishCalls,
    [],
    'no package should have been published before the pre-flight content check ran for every existing artifact',
  );
});

test('tolerates a transient registry error during post-publish verification instead of crashing the step', () => {
  const logs = [];
  let viewCount = 0;

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
      log: (message) => logs.push(message),
      runNpm: (args) => {
        if (args[0] === 'publish') return '';
        viewCount += 1;
        // First view is the pre-publish existence check (not found, so we
        // publish). Every view during the verification loop after that
        // simulates a transient registry error (5xx/timeout), never a
        // clean 404.
        if (viewCount === 1) return null;
        throw new Error('npm ERR! 503 Service Unavailable');
      },
      verificationAttempts: 2,
      initialVerificationDelayMs: 1,
      wait: () => {},
    },
  );

  assert.deepEqual(result.unverified, ['@happyvertical/smrt-a']);
  assert.ok(
    logs.some((message) => /errored .*treating as not yet confirmed/.test(message)),
    'expected the transient verification error to be logged, not thrown',
  );
});

test('tolerates a transient registry error during the pre-publish existence check and still publishes', () => {
  const logs = [];
  const calls = [];
  let versionViewCount = 0;

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
      log: (message) => logs.push(message),
      runNpm: (args) => {
        calls.push(args);
        if (args[0] === 'publish') return '';
        if (args[0] === 'view' && args[2] === 'version') {
          versionViewCount += 1;
          // Only the pre-publish existence check (the first version view)
          // errors transiently; the post-publish verification loop (every
          // subsequent version view) confirms cleanly so this test isn't
          // exercising that already-covered retry/backoff path.
          if (versionViewCount === 1) {
            throw new Error('npm ERR! network EAI_AGAIN registry.npmjs.org');
          }
          return '0.40.0';
        }
        return '0.40.0';
      },
      verificationAttempts: 1,
      wait: () => {},
    },
  );

  assert.deepEqual(
    calls.find((args) => args[0] === 'publish'),
    [
      'publish',
      '/artifacts/a.tgz',
      '--registry',
      'https://registry.npmjs.org/',
      '--access',
      'public',
    ],
    'a transient pre-publish read error must not block the publish attempt',
  );
  assert.ok(
    logs.some((message) =>
      /Pre-publish existence check .* errored .* treating as not yet published/.test(
        message,
      ),
    ),
    'expected the transient pre-publish read error to be logged, not thrown',
  );
  assert.deepEqual(result.published, ['@happyvertical/smrt-a']);
});

test('treats an npm publish-conflict on an already-published version as success once content is verified to match', () => {
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
      log: (message) => logs.push(message),
      // The pre-publish check missed it (transient read error, treated as
      // "not yet published" per the test above), so the publish loop
      // attempts to publish; npm's own conflict is authoritative.
      runNpm: (args) => {
        if (args[0] === 'view') {
          throw new Error('npm ERR! network EAI_AGAIN registry.npmjs.org');
        }
        if (args[0] === 'publish') {
          throw new Error(
            'npm error 403 403 Forbidden - PUT https://registry.npmjs.org/@happyvertical%2fsmrt-a - You cannot publish over the previously published versions: 0.40.0.',
          );
        }
        throw new Error(`unexpected npm invocation: ${args.join(' ')}`);
      },
      verifyExistingContentMatches: () => true,
      verificationAttempts: 1,
      wait: () => {},
    },
  );

  assert.deepEqual(result.published, ['@happyvertical/smrt-a']);
  assert.ok(
    logs.some((message) =>
      /reported a publish conflict.*content verified matching/.test(message),
    ),
    'expected the publish conflict to be logged as an already-complete match',
  );
});

test('still fails an npm publish-conflict on an already-published version whose content does not match', () => {
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
          log: () => {},
          runNpm: (args) => {
            if (args[0] === 'view') {
              throw new Error('npm ERR! network EAI_AGAIN registry.npmjs.org');
            }
            if (args[0] === 'publish') {
              throw new Error(
                'npm error 403 403 Forbidden - You cannot publish over the previously published versions: 0.40.0.',
              );
            }
            throw new Error(`unexpected npm invocation: ${args.join(' ')}`);
          },
          // Registry content does not match this run's artifact — the
          // conflict must not be silently treated as "already complete".
          verifyExistingContentMatches: () => false,
        },
      ),
    /You cannot publish over the previously published versions/,
  );
});

test('a genuine publish failure unrelated to an existing version stays fatal', () => {
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
          log: () => {},
          runNpm: (args) => {
            if (args[0] === 'view') return null;
            throw new Error('npm publish EAUTH: authentication failed');
          },
        },
      ),
    /EAUTH/,
  );
});

test('reportUnverifiedPackages is best-effort: an unwritable job summary is logged, not thrown', () => {
  const logs = [];
  const warnings = [];
  const previousSummaryPath = process.env.GITHUB_STEP_SUMMARY;
  process.env.GITHUB_STEP_SUMMARY = '/unwritable/summary.md';

  try {
    assert.doesNotThrow(() => {
      reportUnverifiedPackages(
        {
          releaseVersion: '0.40.0',
          published: ['@happyvertical/smrt-a'],
          unverified: ['@happyvertical/smrt-a'],
        },
        {
          appendSummary: () => {
            throw new Error('EACCES: permission denied');
          },
          log: (message) => logs.push(message),
          warn: (message) => warnings.push(message),
        },
      );
    });
  } finally {
    if (previousSummaryPath === undefined) {
      delete process.env.GITHUB_STEP_SUMMARY;
    } else {
      process.env.GITHUB_STEP_SUMMARY = previousSummaryPath;
    }
  }

  assert.ok(
    logs.some((message) => /::warning::/.test(message)),
    'expected the advisory annotation to still be logged',
  );
  assert.ok(
    warnings.some((message) =>
      /Could not write the advisory job-summary note/.test(message),
    ),
    'expected the summary-write failure to be logged as a warning, not thrown',
  );
});

test('reportUnverifiedPackages is a no-op when nothing is unverified', () => {
  const logs = [];
  reportUnverifiedPackages(
    { releaseVersion: '0.40.0', published: ['@happyvertical/smrt-a'], unverified: [] },
    {
      appendSummary: () => {
        throw new Error('should not be called');
      },
      log: (message) => logs.push(message),
    },
  );
  assert.deepEqual(logs, []);
});
