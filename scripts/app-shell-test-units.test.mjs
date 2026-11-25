/**
 * app-shell's `test` script chains four Vitest configs; CI runs them as the
 * sibling unit tasks in SPLIT_TEST_UNITS so the balancer can spread them
 * (#5647). These tests pin that the units still cover everything `test` runs,
 * that Turbo knows each unit, and that no selector schedules `test` and a unit
 * of the same package together.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { selectAffectedTestPackages } from './affected-test-shard.mjs';
import {
  expandTestUnits,
  SPLIT_TEST_UNITS,
  selectShard,
  TEST_SECONDS,
  unitId,
  unitPackage,
} from './test-shard-balance.mjs';

const APP_SHELL = '@happyvertical/smrt-app-shell';
const root = new URL('../', import.meta.url);
const manifest = JSON.parse(
  readFileSync(new URL('packages/app-shell/package.json', root), 'utf8'),
);
const turbo = JSON.parse(readFileSync(new URL('turbo.json', root), 'utf8'));

/** Vitest invocations of a script: `{ config, shard }` per `vitest run`. */
export function vitestRuns(script) {
  return script
    .split('&&')
    .map((part) => part.trim())
    .filter((part) => /^vitest run\b/.test(part))
    .map((part) => ({
      config: /(?:-c|--config)[ =](\S+)/.exec(part)?.[1] ?? 'vitest.config.ts',
      shard: /--shard[ =](\d+)\/(\d+)/.exec(part)?.slice(1, 3).map(Number),
    }));
}

const unitScripts = SPLIT_TEST_UNITS[APP_SHELL].map((task) => ({
  task,
  script: manifest.scripts[task],
}));

test('every unit task is a hard-coded script that keeps svelte-kit sync', () => {
  assert.equal(unitScripts.length > 1, true);
  for (const { task, script } of unitScripts) {
    assert.equal(typeof script, 'string', `${task} is missing from package.json`);
    assert.match(script, /^svelte-kit sync && vitest run/, task);
    // No passWithNoTests anywhere: an empty unit must fail.
    assert.doesNotMatch(script, /passWithNoTests|pass-with-no-tests/, task);
  }
});

test('every vitest config in the `test` script is covered by a CI unit', () => {
  const wanted = new Set(vitestRuns(manifest.scripts.test).map((run) => run.config));
  assert.ok(wanted.size >= 4, 'test script lost configs; update this test');
  const covered = new Set(
    unitScripts.flatMap(({ script }) => vitestRuns(script).map((run) => run.config)),
  );
  assert.deepEqual([...covered].sort(), [...wanted].sort());
});

test('a config in the `test` script that no unit runs fails the coverage check', () => {
  const withExtra = `${manifest.scripts.test} && vitest run -c vitest.extra.config.ts`;
  const wanted = new Set(vitestRuns(withExtra).map((run) => run.config));
  const covered = new Set(
    unitScripts.flatMap(({ script }) => vitestRuns(script).map((run) => run.config)),
  );
  assert.ok([...wanted].some((config) => !covered.has(config)));
});

test('the sharded default config covers shards 1..n exactly once', () => {
  const shards = unitScripts
    .flatMap(({ script }) => vitestRuns(script))
    .filter((run) => run.shard);
  assert.ok(shards.length > 0);
  const counts = new Set(shards.map((run) => run.shard[1]));
  assert.equal(counts.size, 1, 'one shard count for the default config');
  const [count] = counts;
  assert.ok(shards.every((run) => run.config === 'vitest.config.ts'));
  assert.deepEqual(
    shards.map((run) => run.shard[0]).sort((a, b) => a - b),
    Array.from({ length: count }, (_, i) => i + 1),
  );
  // The default config runs only through its shards, never unsharded too.
  const unsharded = unitScripts
    .flatMap(({ script }) => vitestRuns(script))
    .filter((run) => !run.shard && run.config === 'vitest.config.ts');
  assert.deepEqual(unsharded, []);
});

test('turbo.json registers each unit like `test`', () => {
  for (const { task } of unitScripts) {
    assert.deepEqual(turbo.tasks[task], turbo.tasks.test, task);
  }
});

test('every unit has a measured weight in the balancer table', () => {
  for (const task of SPLIT_TEST_UNITS[APP_SHELL]) {
    assert.ok(TEST_SECONDS[unitId(APP_SHELL, task)] > 0, task);
  }
  assert.equal(TEST_SECONDS[APP_SHELL], undefined, 'whole-package weight is stale');
});

test('expandTestUnits never schedules `test` beside a unit of the same package', () => {
  const units = expandTestUnits([APP_SHELL, '@happyvertical/smrt-tags']);
  assert.deepEqual(units, [
    ...SPLIT_TEST_UNITS[APP_SHELL].map((task) => unitId(APP_SHELL, task)),
    '@happyvertical/smrt-tags#test',
  ].sort());
  assert.ok(!units.includes(unitId(APP_SHELL, 'test')));
});

test('shards over the units cover each exactly once, and app-shell is spread', () => {
  const units = expandTestUnits([APP_SHELL, '@happyvertical/smrt-tags']);
  for (const count of [1, 2, 3, 5]) {
    const shards = Array.from({ length: count }, (_, i) =>
      selectShard(units, { index: i + 1, count }, TEST_SECONDS),
    );
    assert.deepEqual(shards.flat().sort(), units, `count ${count}`);
  }
  const homes = SPLIT_TEST_UNITS[APP_SHELL].map((task) =>
    [1, 2, 3].find((index) =>
      selectShard(units, { index, count: 3 }, TEST_SECONDS).includes(
        unitId(APP_SHELL, task),
      ),
    ),
  );
  assert.ok(new Set(homes).size > 1, 'units landed on one shard');
});

test('affected selection emits app-shell units, not its plain test task', () => {
  const dryRun = {
    tasks: [
      { task: 'test', package: APP_SHELL },
      { task: 'test', package: '@happyvertical/smrt-tags' },
    ],
  };
  const emitted = [1, 2, 3].flatMap(
    (index) => selectAffectedTestPackages(dryRun, { index, count: 3 }).shard,
  );
  assert.deepEqual(emitted.sort(), expandTestUnits([APP_SHELL, '@happyvertical/smrt-tags']));
});

test('sibling units avoid sharing a shard while a free shard exists', () => {
  const units = expandTestUnits([APP_SHELL, '@happyvertical/smrt-ingestion']);
  const siblings = SPLIT_TEST_UNITS[APP_SHELL].map((task) => unitId(APP_SHELL, task));
  // Three units, three shared shards: one per shard, though weights would co-locate.
  const weights = { ...TEST_SECONDS, [siblings[0]]: 1, [siblings[1]]: 1, [siblings[2]]: 1 };
  const shards = [1, 2, 3].map((index) => selectShard(units, { index, count: 4 }, weights));
  assert.deepEqual(shards.flat().sort(), units);
  for (const shard of shards) {
    assert.ok(shard.filter((id) => siblings.includes(id)).length <= 1, shard.join());
  }
  // With fewer shards than units they must share: still exactly once.
  const two = [1, 2].map((index) => selectShard(units, { index, count: 3 }, weights));
  assert.deepEqual(two.flat().sort(), units);
});
