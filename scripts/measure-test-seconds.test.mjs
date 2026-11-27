import assert from 'node:assert/strict';
import test from 'node:test';

import {
  median,
  medianUnitSeconds,
  parseUnitSeconds,
  unitKey,
} from './measure-test-seconds.mjs';

const stamp = (time) => `2026-11-26T${time}.1234567Z`;
const block = (title, finish, startAt) =>
  [
    `${stamp(finish)} ##[group]${title}`,
    `${stamp(finish)} cache miss, executing abc`,
    ...(startAt
      ? [`${stamp(finish)}    Start at  ${startAt}`, `${stamp(finish)}    Duration  1.00s (tests 2s)`]
      : []),
    `${stamp(finish)} ##[endgroup]`,
  ].join('\n');

test('unitKey names plain packages and split units, and skips other tasks', () => {
  assert.equal(unitKey('@happyvertical/smrt-chat:test'), '@happyvertical/smrt-chat');
  assert.equal(
    unitKey('@happyvertical/smrt-app-shell:test:unit:1of2'),
    '@happyvertical/smrt-app-shell#test:unit:1of2',
  );
  // app-shell's aggregate `test` never runs in CI, and builds are not tests.
  assert.equal(unitKey('@happyvertical/smrt-app-shell:test'), null);
  assert.equal(unitKey('@happyvertical/smrt-chat:build'), null);
  assert.equal(unitKey('@happyvertical/smrt-content:generate:test'), null);
  assert.equal(unitKey('smrt-workbench-host:test'), 'smrt-workbench-host');
});

test('parseUnitSeconds takes finish minus Vitest start, per task', () => {
  const log = [
    block('@happyvertical/smrt-types:build', '20:43:50', null),
    // Two tasks overlap on the two lanes; each block carries its own times.
    block('@happyvertical/smrt-a:test', '20:46:00', '20:44:30'),
    block('@happyvertical/smrt-b:test', '20:47:00', '20:44:40'),
    block('@happyvertical/smrt-app-shell:test:configs', '20:50:00', '20:48:00'),
  ].join('\n');
  assert.deepEqual([...parseUnitSeconds(log)], [
    ['@happyvertical/smrt-a', 90],
    ['@happyvertical/smrt-b', 140],
    ['@happyvertical/smrt-app-shell#test:configs', 120],
  ]);
});

test('parseUnitSeconds strips colour codes, uses the first Start at, and wraps midnight', () => {
  const log = [
    `${stamp('00:01:00')} ##[group]\u001b[36m@happyvertical/smrt-a:test\u001b[0m`,
    `${stamp('00:01:00')}    Start at  23:58:30`,
    `${stamp('00:01:00')}    Start at  00:00:30`,
    `${stamp('00:01:00')} ##[endgroup]`,
  ].join('\n');
  assert.equal(parseUnitSeconds(log).get('@happyvertical/smrt-a'), 150);
});

test('median and medianUnitSeconds handle odd, even and partial samples', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 10]), 2.5);
  assert.deepEqual(
    medianUnitSeconds([
      new Map([['a', 100], ['b', 7]]),
      new Map([['a', 300]]),
      new Map([['a', 200], ['b', 9]]),
    ]),
    { a: 200, b: 8 },
  );
});

test('parseUnitSeconds skips a replayed cache-hit block', () => {
  const log = [
    `${stamp('20:46:00')} ##[group]@happyvertical/smrt-a:test`,
    `${stamp('20:46:00')} cache hit, replaying logs abc`,
    `${stamp('20:46:00')}    Start at  09:00:00`,
    `${stamp('20:46:00')} ##[endgroup]`,
    block('@happyvertical/smrt-b:test', '20:47:00', '20:45:00'),
  ].join('\n');
  assert.deepEqual([...parseUnitSeconds(log)], [['@happyvertical/smrt-b', 120]]);
});
