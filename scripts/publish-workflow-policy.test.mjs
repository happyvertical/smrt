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

test('final publisher authenticates to npm as a trusted publisher', () => {
  const publisher = job('publish-release');

  // npm OIDC rejects self-hosted runners, so this job must not follow ARC.
  assert.match(publisher, /^    runs-on: ubuntu-latest$/m);
  assert.doesNotMatch(publisher, /arc-happyvertical/);
  assert.match(workflow, /^  id-token: write$/m);
  assert.match(batchWorkflow, /^      id-token: write$/m);

  // The preflight runs once npm is installed and before anything irreversible.
  const preflight = publisher.indexOf(
    'node scripts/check-trusted-publish-preflight.mjs',
  );
  assert.ok(preflight > publisher.indexOf('- name: Setup Environment'));
  assert.ok(preflight < publisher.indexOf('git commit -m'));

  // Only the emergency Changesets fallback may receive the long-lived token;
  // an unconditional one lets npm fall back silently when OIDC is broken.
  assert.doesNotMatch(
    publisher,
    /(auth-token|NODE_AUTH_TOKEN|NPM_TOKEN): \$\{\{ secrets\.NPM_TOKEN \}\}/,
  );
  // The preflight is handed the artifacts so it can prove npm accepts the
  // exchange for every package, not only that the runner supports OIDC.
  assert.match(
    publisher,
    /check-trusted-publish-preflight\.mjs publish-pack-output$/m,
  );
  // prepare-release never publishes and must not hard-require the secret; the
  // Changesets fallback still does, before its irreversible phase.
  assert.doesNotMatch(job('prepare-release'), /NPM_TOKEN secret is required/);
  const tokenCheck = publisher.indexOf(
    "if: inputs.publish-mode == 'changesets'\n        env:\n          NPM_TOKEN:",
  );
  assert.ok(tokenCheck > 0 && tokenCheck < publisher.indexOf('git commit -m'));
  assert.match(publisher, /^      CI_ONNX_DEPS_READY: 'true'$/m);
});
