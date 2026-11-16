import assert from 'node:assert/strict';
import test from 'node:test';

import { decide, watch } from './merge-group-fail-fast.mjs';

const names = { self: 'Merge Group Fail Fast', aggregate: 'Required CI' };
const job = (name, conclusion = null) => ({
  name,
  status: conclusion ? 'completed' : 'in_progress',
  conclusion,
});
const self = job(names.self);

test('decide waits while every finished job succeeded or was skipped', () => {
  assert.deepEqual(
    decide([self, job('Lint', 'success'), job('Docs Site Build', 'skipped'), job('Build')], names),
    { action: 'wait' },
  );
});

test('decide cancels on a failed, timed-out or cancelled job', () => {
  for (const conclusion of ['failure', 'timed_out', 'cancelled']) {
    assert.deepEqual(decide([self, job('Lint', 'success'), job('Audit', conclusion)], names), {
      action: 'cancel',
      job: 'Audit',
    });
  }
});

test('decide ignores its own job and stops once the aggregate has started', () => {
  assert.deepEqual(decide([job(names.self, 'cancelled')], names), { action: 'wait' });
  assert.deepEqual(decide([self, job('Audit', 'failure'), job(names.aggregate)], names), {
    action: 'done',
  });
});

test('watch cancels once, after polling through healthy and unreadable states', async () => {
  const polls = [
    () => [self, job('Build')],
    () => {
      throw new Error('502');
    },
    () => [self, job('Build', 'failure')],
  ];
  const log = [];
  let cancelled = 0;
  const outcome = await watch({
    listJobs: async () => polls.shift()(),
    cancel: async () => {
      cancelled += 1;
    },
    sleep: async () => {},
    log: (message) => log.push(message),
    names,
  });
  assert.equal(outcome, 'cancelled');
  assert.equal(cancelled, 1);
  assert.ok(log.some((message) => message.startsWith('::warning::')));
  assert.ok(log.some((message) => message.includes('"Build" did not succeed')));
});

test('watch never cancels a run that finishes green, and gives up at its deadline', async () => {
  const cancel = async () => assert.fail('must not cancel');
  const sleep = async () => {};
  assert.equal(
    await watch({ listJobs: async () => [self, job(names.aggregate)], cancel, sleep, log: () => {}, names }),
    'done',
  );
  assert.equal(
    await watch({ listJobs: async () => [self, job('Build')], cancel, sleep, log: () => {}, names, maxPolls: 3 }),
    'deadline',
  );
});

test('watch survives a refused cancel', async () => {
  let attempts = 0;
  const outcome = await watch({
    listJobs: async () => (attempts++ === 0 ? [self, job('Build', 'failure')] : [self, job(names.aggregate)]),
    cancel: async () => {
      throw new Error('409');
    },
    sleep: async () => {},
    log: () => {},
    names,
  });
  assert.equal(outcome, 'done');
});
