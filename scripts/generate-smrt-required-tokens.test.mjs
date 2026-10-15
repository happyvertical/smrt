import assert from 'node:assert/strict';
import test from 'node:test';
import { computeTokenSets } from './generate-smrt-required-tokens.mjs';

test('keeps consumed preset theme tokens when only smrt-ui consumes them', () => {
  const { required } = computeTokenSets();

  assert(required.includes('--smrt-color-info'));
  assert(required.includes('--smrt-color-info-container'));
});
