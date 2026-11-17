import assert from 'node:assert/strict';
import test from 'node:test';

import {
  balanceShards,
  DEDICATED_PACKAGES,
  selectShard,
} from './test-shard-balance.mjs';

const [DEDICATED] = DEDICATED_PACKAGES;
const seconds = { slow: 800, medium: 400, steady: 300 };
const names = ['a', 'b', 'c', 'd', 'medium', 'slow', 'steady'];

test('balanceShards puts every name in exactly one shard, in any input order', () => {
  const shards = balanceShards(names, 3, seconds);
  assert.deepEqual(shards.flat().sort(), names);
  assert.deepEqual(balanceShards([...names].reverse(), 3, seconds), shards);
  assert.deepEqual(balanceShards([...names, 'slow'], 3, seconds), shards);
});

test('balanceShards separates the longest packages', () => {
  const shards = balanceShards(names, 3, seconds);
  const home = (name) => shards.findIndex((shard) => shard.includes(name));
  assert.equal(new Set([home('slow'), home('medium'), home('steady')]).size, 3);
  // The unmeasured packages fill the lighter shards, not the slowest one.
  assert.deepEqual(shards[home('slow')], ['slow']);
});

test('balanceShards leaves surplus shards empty and rejects a bad count', () => {
  assert.deepEqual(balanceShards(['a'], 3, {}), [['a'], [], []]);
  assert.throws(() => balanceShards(['a'], 0, {}), /Invalid shard count/);
});

test('selectShard reserves the trailing shard for the dedicated package', () => {
  const all = [...names, DEDICATED];
  assert.deepEqual(selectShard(all, { index: 4, count: 4 }, seconds), [DEDICATED]);
  const shared = [1, 2, 3].map((index) => selectShard(all, { index, count: 4 }, seconds));
  assert.deepEqual(shared.flat().sort(), names);
  // An affected closure without the dedicated package leaves its shard empty.
  assert.deepEqual(selectShard(names, { index: 4, count: 4 }, seconds), []);
});

test('selectShard balances everything together when no shard can be reserved', () => {
  assert.deepEqual(
    selectShard([...names, DEDICATED], { index: 1, count: 1 }, seconds),
    [...names, DEDICATED].sort(),
  );
});
