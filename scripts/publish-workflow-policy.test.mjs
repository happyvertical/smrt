import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/publish.yml', import.meta.url),
  'utf8',
);
const batchWorkflow = readFileSync(
  new URL('../.github/workflows/on-merge-main.yml', import.meta.url),
  'utf8',
);
const publishDryRunWorkflow = readFileSync(
  new URL('../.github/workflows/publish-dry-run.yml', import.meta.url),
  'utf8',
);

function job(name, source = workflow) {
  const match = source.match(
    new RegExp(
      `^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:\\n|(?![\\s\\S]))`,
      'm',
    ),
  );
  assert.ok(match, `workflow job ${name} must exist`);
  return match[0];
}

test('publish dry-run summary terminalizes cancellation without using metal', () => {
  const summary = job('publish-dry-run-summary', publishDryRunWorkflow);

  assert.match(summary, /^      !cancelled\(\) && always\(\) &&$/m);
  assert.match(summary, /^    runs-on: ubuntu-latest$/m);
  assert.match(summary, /^    timeout-minutes: 10$/m);
  assert.doesNotMatch(summary, /arc-happyvertical/);
});

test('final publisher skips workspace installation and allows recovery headroom', () => {
  const publisher = job('publish-release');

  assert.match(publisher, /^    timeout-minutes: 45$/m);
  assert.match(
    publisher,
    /- name: Setup Environment[\s\S]*?install-deps: 'false'/,
  );
});

test('routine releases batch instead of publishing after every main push', () => {
  const publisher = job('publish-release');

  assert.doesNotMatch(batchWorkflow, /^  push:/m);
  assert.match(batchWorkflow, /^  schedule:\n    - cron: '17 7 \* \* \*'$/m);
  assert.match(batchWorkflow, /^  workflow_dispatch:$/m);
  assert.match(batchWorkflow, /^  queue-idle:$/m);
  assert.match(batchWorkflow, /needs: \[queue-idle, test, build, docs-scope\]/);
  assert.match(
    batchWorkflow,
    /needs\.queue-idle\.result == 'success'/,
  );
  assert.match(
    batchWorkflow,
    /needs\.docs-scope\.result == 'success'/,
  );
  assert.match(
    batchWorkflow,
    /run: node scripts\/check-merge-queue-idle\.mjs/,
  );
  assert.match(batchWorkflow, /^  docs-scope:$/m);
  assert.match(batchWorkflow, /fetch-depth: 0/);
  assert.match(batchWorkflow, /git tag --merged HEAD --list 'v\*'/);
  assert.doesNotMatch(
    batchWorkflow,
    /git tag --merged HEAD --list 'v\*' --sort=-version:refname \| head -n 1/,
  );
  assert.match(batchWorkflow, /tag=\$\{tag%%\$'\\n'\*\}/);
  assert.match(
    batchWorkflow,
    /base: \$\{\{ steps\.release-base\.outputs\.ref \}\}/,
  );
  assert.match(
    batchWorkflow,
    /github\.event_name == 'schedule' && needs\.docs-scope\.outputs\.docs == 'true'/,
  );
  assert.match(
    publisher,
    /- name: Recheck merge queue before publication[\s\S]*?run: node scripts\/check-merge-queue-idle\.mjs/,
  );
  assert.ok(
    publisher.lastIndexOf('node scripts/check-merge-queue-idle.mjs') <
      publisher.indexOf('node scripts/publish-validated-artifacts.mjs'),
  );
});
