import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasAffectedCoreTest,
  parseShard,
  selectAffectedTestPackages,
} from './affected-test-shard.mjs';

test('selectAffectedTestPackages keeps every affected non-core test task once', () => {
  const dryRun = {
    tasks: [
      { task: 'build', package: '@happyvertical/smrt-alpha' },
      { task: 'test', package: '@happyvertical/smrt-zeta' },
      { task: 'test', package: '@happyvertical/smrt-core' },
      { task: 'test', package: '@happyvertical/smrt-alpha' },
      { task: 'test', package: '@happyvertical/smrt-zeta' },
      { task: 'test', package: '@happyvertical/smrt-beta' },
    ],
  };

  assert.deepEqual(selectAffectedTestPackages(dryRun, { index: 1, count: 2 }), {
    packages: [
      '@happyvertical/smrt-alpha',
      '@happyvertical/smrt-beta',
      '@happyvertical/smrt-zeta',
    ],
    shard: ['@happyvertical/smrt-alpha', '@happyvertical/smrt-zeta'],
  });
  assert.deepEqual(selectAffectedTestPackages(dryRun, { index: 2, count: 2 }).shard, [
    '@happyvertical/smrt-beta',
  ]);
});

test('hasAffectedCoreTest follows Turbo selection rather than changed paths', () => {
  assert.equal(
    hasAffectedCoreTest({
      tasks: [{ task: 'test', package: '@happyvertical/smrt-core' }],
    }),
    true,
  );
  assert.equal(
    hasAffectedCoreTest({ tasks: [] }),
    false,
  );
});

test('parseShard rejects malformed and out-of-range shard selectors', () => {
  for (const selector of ['', '0/3', '4/3', '1/0', '1/3/4']) {
    assert.throws(() => parseShard(selector), /Invalid shard/);
  }
});

test('selectAffectedTestPackages rejects malformed Turbo output', () => {
  assert.throws(
    () => selectAffectedTestPackages({}, { index: 1, count: 3 }),
    /tasks array/,
  );
});
