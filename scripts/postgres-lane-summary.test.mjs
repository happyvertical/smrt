import assert from 'node:assert/strict';
import test from 'node:test';
import { renderMarkdown, summarizeRun } from './postgres-lane-summary.mjs';

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
      result: 'not run',
      exitCode: null,
      seconds: null,
    },
    {
      package: '@happyvertical/smrt-core',
      result: 'passed',
      exitCode: 0,
      seconds: 10,
    },
    {
      package: '@happyvertical/smrt-users',
      result: 'failed',
      exitCode: 1,
      seconds: 41,
    },
  ]);
});

test('renders a table without environment details', () => {
  const markdown = renderMarkdown(summarizeRun(summary));
  assert.match(markdown, /1\/3 package suites passed/);
  assert.match(markdown, /\| `@happyvertical\/smrt-users` \| failed \| 1 \| 41 \|/);
  assert.doesNotMatch(markdown, /DATABASE_URL/);
});
