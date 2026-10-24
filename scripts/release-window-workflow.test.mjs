import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { CONTEXT } from './release-admission.mjs';

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const batch = read('.github/workflows/on-merge-main.yml');
const publish = read('.github/workflows/publish.yml');
const admission = read('.github/workflows/release-admission.yml');
const postgres = read('.github/workflows/postgres-tests.yml');

function job(source, name) {
  const match = source.match(new RegExp(`^  ${name}:\\n[\\s\\S]*?(?=^  [a-z][a-z0-9-]*:\\n|(?![\\s\\S]))`, 'm'));
  assert.ok(match, `missing workflow job ${name}`);
  return match[0];
}

function steps(source) {
  return [...source.matchAll(/^      - name: ([^\n]+)\n([\s\S]*?)(?=^      - |(?![\s\S]))/gm)]
    .map((match) => ({ name: match[1], source: match[0] }));
}

function step(source, name) {
  const selected = steps(source).find((entry) => entry.name === name);
  assert.ok(selected, `missing workflow step ${name}`);
  return selected.source;
}

test('reserved source snapshot flows through the release DAG and every publish checkout', () => {
  const reserve = job(batch, 'queue-idle');
  assert.match(reserve, /snapshot_sha:.*steps\.window\.outputs\.snapshot_sha/);
  assert.match(reserve, /close --timeout-minutes 90 --drain-minutes 30/);
  const docs = job(batch, 'docs-scope');
  assert.match(docs, /needs: queue-idle/);
  assert.match(docs, /ref: \$\{\{ needs\.queue-idle\.outputs\.snapshot_sha \}\}/);
  const caller = job(batch, 'publish');
  assert.match(caller, /needs: \[queue-idle, test, build, docs-scope\]/);
  assert.match(caller, /needs\.queue-idle\.result == 'success'/);
  assert.match(caller, /checkout_ref: \$\{\{ needs\.queue-idle\.outputs\.snapshot_sha \}\}/);
  assert.match(publish, /CHECKOUT_REF: \$\{\{ inputs\.checkout_ref \|\| github\.sha \}\}/);
  assert.match(publish, /RELEASE_SOURCE_SHA: \$\{\{ inputs\.checkout_ref \|\| github\.sha \}\}/);
  const checkouts = steps(publish).filter((entry) => /uses: actions\/checkout@/.test(entry.source));
  assert.ok(checkouts.length >= 5);
  for (const checkout of checkouts) {
    assert.match(checkout.source, /ref: \$\{\{ env\.CHECKOUT_REF \}\}/, checkout.name);
  }
});

test('trusted-main initialization works with flag off while ordinary disabled jobs stay dormant', () => {
  const controller = job(admission, 'reconcile');
  const expression = controller.match(/^    if: >-\n([\s\S]*?)(?=^    \S)/m)?.[1].trim();
  assert.ok(expression);
  const allowed = (flag, command, event = 'workflow_dispatch', ref = 'refs/heads/main') =>
    runInNewContext(expression, {
      vars: { CI_RELEASE_WINDOW_ENABLED: flag }, inputs: { command },
      github: { ref, event_name: event },
    }, { timeout: 100 });
  assert.equal(allowed('false', 'init'), true);
  assert.equal(allowed('false', 'reconcile'), false);
  assert.equal(allowed('false', '', 'schedule'), false);
  assert.equal(allowed('false', 'init', 'workflow_dispatch', 'refs/heads/candidate'), false);
  assert.equal(allowed('true', 'reconcile'), true);
  assert.equal(allowed('true', 'ack-grant'), true);
  assert.equal(allowed('false', 'ack-grant'), false);
  assert.equal(allowed('true', 'ack-grant', 'workflow_dispatch', 'refs/heads/candidate'), false);
  assert.equal(allowed('true', 'recover'), false);
  assert.match(step(controller, 'Checkout trusted default branch only'), /ref: refs\/heads\/main/);
  assert.doesNotMatch(controller, /ref:.*(?:head_sha|head_branch|workflow_run)/);
  assert.doesNotMatch(controller, /^\s+(?:run:.*(?:pnpm|npm install)|uses:.*setup-environment)/m);
  assert.match(controller, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(controller, /RELEASE_GITHUB_TOKEN: \$\{\{ steps\.app\.outputs\.token \}\}/);
});

test('callbacks and manual recovery preserve the original source attempt', () => {
  const controller = job(admission, 'reconcile');
  assert.match(controller, /SOURCE_RUN_ID: \$\{\{ github\.event\.workflow_run\.id \}\}/);
  assert.match(controller, /SOURCE_RUN_ATTEMPT: \$\{\{ github\.event\.workflow_run\.run_attempt \}\}/);
  assert.match(controller, /finish-run --run-id "\$SOURCE_RUN_ID" --run-attempt "\$SOURCE_RUN_ATTEMPT"/);
  assert.match(admission, /cron: '\*\/10 \* \* \* \*'/);
  assert.match(controller, /node scripts\/release-admission\.mjs reconcile/);
  assert.match(controller, /GRANT_SHA: \$\{\{ inputs\.grant-sha \}\}/);
  assert.match(controller, /GRANT_ID: \$\{\{ inputs\.grant-id \}\}/);
  assert.match(controller, /WRITER_RUN_ID: \$\{\{ inputs\.writer-run-id \}\}/);
  assert.match(controller, /WRITER_RUN_ATTEMPT: \$\{\{ inputs\.writer-run-attempt \}\}/);
  assert.match(controller, /release-admission\.mjs ack-grant[\s\S]*--sha "\$GRANT_SHA" --grant-id "\$GRANT_ID"[\s\S]*--writer-run-id "\$WRITER_RUN_ID" --writer-run-attempt "\$WRITER_RUN_ATTEMPT"/);
  const recovery = job(admission, 'recover');
  assert.match(recovery, /OWNER_RUN_ID: \$\{\{ inputs\.owner-run-id \}\}/);
  assert.match(recovery, /OWNER_RUN_ATTEMPT: \$\{\{ inputs\.owner-run-attempt \}\}/);
  assert.match(recovery, /recover-release\.mjs --owner-run-id "\$OWNER_RUN_ID" --owner-run-attempt "\$OWNER_RUN_ATTEMPT"/);
  assert.match(step(recovery, 'Checkout trusted recovery code'), /ref: refs\/heads\/main/);
  assert.doesNotMatch(recovery, /OWNER_RUN_ATTEMPT:.*github\.run_attempt/);
});

test('immutable per-attempt packs and Git bundle survive thirty days before publication begins', () => {
  const packs = step(publish, 'Upload verified package artifacts');
  assert.match(packs, /name: publish-release-pack-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-\$\{\{ matrix\.shard-index \}\}/);
  assert.match(packs, /retention-days: 30/);
  const publisher = job(publish, 'publish-release');
  const prepare = step(publisher, 'Prepare exact release commit');
  assert.match(prepare, /git bundle create release-candidate\.bundle HEAD "\^\$RELEASE_SOURCE_SHA"/);
  assert.match(prepare, /RELEASE_PUSH_DRY_RUN=true node scripts\/push-release-refs\.mjs/);
  const bundle = step(publisher, 'Preserve exact release commit for recovery');
  assert.match(bundle, /name: release-candidate-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(bundle, /retention-days: 30/);
  assert.match(bundle, /if-no-files-found: error/);
  const ordered = steps(publisher).map((entry) => entry.name);
  assert.ok(ordered.indexOf('Prepare exact release commit') < ordered.indexOf('Preserve exact release commit for recovery'));
  assert.ok(ordered.indexOf('Preserve exact release commit for recovery') < ordered.indexOf('Publish validated release'));
  const irreversible = step(publisher, 'Publish validated release');
  const begin = irreversible.indexOf('release-admission.mjs begin-publishing');
  const registry = irreversible.indexOf('node scripts/publish-validated-artifacts.mjs');
  const refs = irreversible.indexOf('node scripts/push-release-refs.mjs');
  const complete = irreversible.indexOf('release-admission.mjs complete');
  assert.ok(begin >= 0 && begin < registry && registry < refs && refs < complete);
});

test('standalone publishing cannot bypass a reserved window and primary completion precedes the mirror', () => {
  const reserve = step(job(publish, 'prepare-release'), 'Verify reserved release snapshot');
  assert.match(reserve, /vars\.CI_RELEASE_WINDOW_ENABLED == 'true'/);
  assert.match(reserve, /node scripts\/release-admission\.mjs assert-window/);
  assert.match(reserve, /test "\$PUBLISH_MODE" = artifacts/);
  assert.match(step(job(publish, 'publish-release'), 'Recheck reserved snapshot before publication'), /assert-window/);
  const mirror = job(publish, 'mirror-npmjs');
  assert.match(mirror, /needs: \[prepare-release, publish-release\]/);
  assert.match(mirror, /continue-on-error: true/);
  assert.doesNotMatch(mirror, /release-admission\.mjs complete/);
});

test('PostgreSQL aggregate rejects any failed, cancelled or skipped selected shard', () => {
  const suites = job(postgres, 'postgres');
  assert.match(suites, /shard: \[ingestion, remaining\]/);
  assert.match(suites, /fail-fast: false/);
  const aggregate = job(postgres, 'postgres-required');
  assert.match(aggregate, /name: postgres-required/);
  assert.match(aggregate, /needs: \[scope, postgres\]/);
  assert.match(aggregate, /if: always\(\)/);
  assert.match(aggregate, /POSTGRES: \$\{\{ needs\.postgres\.result \}\}/);
  const shell = step(aggregate, 'Require every PostgreSQL suite to pass')
    .match(/^        run: \|\n([\s\S]*)/m)?.[1].replace(/^          /gm, '');
  assert.ok(shell);
  for (const result of ['success', 'failure', 'cancelled', 'skipped', '']) {
    const run = spawnSync('bash', ['-c', shell], {
      env: { SCOPE: 'success', TRUSTED: 'true', RUN: 'true', POSTGRES: result },
      encoding: 'utf8',
    });
    assert.equal(run.status === 0, result === 'success', `${result}: ${run.stdout}${run.stderr}`);
  }
});

test('documented additive rules bind the App without replacing existing checks', () => {
  const guide = read('.github/release-window.md');
  const rulesets = [...guide.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]));
  assert.equal(rulesets.length, 2);
  for (const ruleset of rulesets) {
    assert.equal(ruleset.enforcement, 'active');
    assert.deepEqual(ruleset.bypass_actors, [{ actor_id: 2315871, actor_type: 'Integration', bypass_mode: 'always' }]);
    assert.deepEqual(ruleset.conditions.ref_name.exclude, []);
  }
  const state = rulesets.find((rule) => rule.conditions.ref_name.include.includes('refs/heads/hv-release-admission'));
  assert.deepEqual(new Set(state.rules.map((rule) => rule.type)), new Set(['creation', 'update', 'deletion', 'non_fast_forward']));
  const main = rulesets.find((rule) => rule.conditions.ref_name.include.includes('refs/heads/main'));
  assert.deepEqual(main.rules[0].parameters.required_status_checks, [{ context: CONTEXT, integration_id: 2315871 }]);
  const required = job(read('.github/workflows/on-pull-request.yml'), 'required-ci');
  assert.match(required, /name: Required CI/);
  assert.match(required, /if: always\(\)/);
  assert.match(required, /- ci-control-plane/);
});
