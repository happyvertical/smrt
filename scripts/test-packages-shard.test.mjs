import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = new URL('./test-packages-shard.mjs', import.meta.url).pathname;
const DEDICATED = '--filter=@happyvertical/smrt-template-sveltekit';

function shard(arg) {
  const result = spawnSync('node', [script, arg], { encoding: 'utf8' });
  return { status: result.status, filters: result.stdout.split(' ').filter(Boolean) };
}

test('the dedicated package runs alone on the last of four shards (#4990)', () => {
  assert.deepEqual(shard('4/4').filters, [DEDICATED]);
});

test('four shards cover every package exactly once and no other shard runs the dedicated one', () => {
  const shards = ['1/4', '2/4', '3/4', '4/4'].map((arg) => shard(arg).filters);
  const all = shards.flat();
  assert.equal(new Set(all).size, all.length, 'no package is in two shards');
  assert.deepEqual([...new Set(all)].sort(), shard('1/1').filters.sort());
  for (const shared of shards.slice(0, 3)) {
    assert.ok(shared.length > 0);
    assert.ok(!shared.includes(DEDICATED));
  }
});

test('a single shard still runs everything', () => {
  assert.ok(shard('1/1').filters.includes(DEDICATED));
});

test('malformed shard arguments are rejected', () => {
  for (const arg of ['', '0/4', '5/4', '1/3/4', 'x']) {
    assert.equal(shard(arg).status, 1, arg);
  }
});
