import assert from 'node:assert/strict';
import test from 'node:test';
import { decideScope, scopeFromGit } from './merge-group-scope.mjs';

const plan = (overrides = {}) => ({
  full: false,
  inventoryComplete: true,
  reasons: [],
  packages: [],
  suites: { test: [], 'test:postgres': [{ name: '@x/b' }, { name: '@x/a' }] },
  ...overrides,
});

test('a leaf change is affected and carries sorted PostgreSQL packages', () => {
  assert.deepEqual(decideScope(plan()), { mode: 'affected', postgres: ['@x/a', '@x/b'], reasons: [] });
});

test('a full plan is full for every lane', () => {
  const scope = decideScope(plan({ full: true, reasons: ['Global or unowned input: turbo.json'] }));
  assert.equal(scope.mode, 'full');
  assert.equal(scope.postgres, 'all');
});

test('an unusable plan never selects affected', () => {
  for (const bad of [undefined, null, {}, plan({ inventoryComplete: false }), plan({ full: undefined }), plan({ packages: null }), plan({ suites: {} })]) {
    const scope = decideScope(bad);
    assert.equal(scope.mode, 'full');
    assert.equal(scope.postgres, 'all');
  }
});

test('an empty base or unreadable commit falls back to full', () => {
  for (const base of ['', undefined, 'main', 'c'.repeat(40)]) {
    const scope = scopeFromGit({ base, head: 'd'.repeat(40) });
    assert.equal(scope.mode, 'full');
    assert.equal(scope.postgres, 'all');
  }
});
