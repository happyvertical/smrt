import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allSummaries, renderMarkdown, summarizeRun } from './postgres-lane-summary.mjs';

const summary = {
  tasks: [
    {
      task: 'build',
      package: '@happyvertical/smrt-core',
      execution: { exitCode: 0 },
    },
    {
      task: 'test:postgres',
      package: '@happyvertical/smrt-users',
      execution: { startTime: 1_000, endTime: 42_000, exitCode: 1 },
      environmentVariables: { specified: { env: ['DATABASE_URL=abc'] } },
    },
    {
      task: 'test:postgres',
      package: '@happyvertical/smrt-core',
      execution: { startTime: 0, endTime: 9_600, exitCode: 0 },
    },
    { task: 'test:postgres', package: '@happyvertical/smrt-chat' },
  ],
};

test('reports every package suite, including failed and unrun ones', () => {
  assert.deepEqual(summarizeRun(summary), [
    {
      package: '@happyvertical/smrt-chat',
      task: 'test:postgres',
      result: 'not run',
      exitCode: null,
      seconds: null,
    },
    {
      package: '@happyvertical/smrt-core',
      task: 'test:postgres',
      result: 'passed',
      exitCode: 0,
      seconds: 10,
    },
    {
      package: '@happyvertical/smrt-users',
      task: 'test:postgres',
      result: 'failed',
      exitCode: 1,
      seconds: 41,
    },
  ]);
});

test('renders a table without environment details', () => {
  const markdown = renderMarkdown(summarizeRun(summary));
  assert.match(markdown, /1\/3 suite units passed/);
  assert.match(markdown, /\| `@happyvertical\/smrt-users` \| `test:postgres` \| failed \| 1 \| 41 \|/);
  assert.doesNotMatch(markdown, /DATABASE_URL/);
});

test('accepts the core halves and every run file in the step (#5649)', () => {
  const half = (task, exitCode) => ({
    tasks: [{ task, package: '@happyvertical/smrt-core', execution: { startTime: 0, endTime: 5_000, exitCode } }],
  });
  const directory = mkdtempSync(join(tmpdir(), 'smrt-pg-runs-'));
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, '1.json'), JSON.stringify(half('test:postgres:real', 0)));
    writeFileSync(join(directory, '2.json'), JSON.stringify(half('test:postgres:pglite', 1)));
    const rows = summarizeRun(allSummaries(directory));
    assert.deepEqual(rows.map((row) => [row.task, row.result]), [
      ['test:postgres:pglite', 'failed'],
      ['test:postgres:real', 'passed'],
    ]);
    assert.throws(() => allSummaries(join(directory, 'missing')));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
