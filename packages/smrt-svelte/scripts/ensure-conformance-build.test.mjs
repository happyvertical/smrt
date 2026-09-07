import assert from 'node:assert/strict';
import test from 'node:test';

import { needsStandaloneBuild } from './ensure-conformance-build.mjs';

test('requires the consumer build outside a Turbo task', () => {
  assert.equal(needsStandaloneBuild({}), true);
});

test('uses Turbo-managed build dependencies inside a Turbo task', () => {
  assert.equal(needsStandaloneBuild({ TURBO_HASH: 'task-hash' }), false);
});
