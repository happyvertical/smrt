import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

// #4846: the docs site lane in on-pull-request.yml builds Docusaurus before
// merge when its inputs change. These tests pin the scope filter against
// representative changes and the Required CI handling of the lane's result.

const source = readFileSync(
  new URL('../.github/workflows/on-pull-request.yml', import.meta.url),
  'utf8',
);
const workflow = parse(source);
const jobs = workflow.jobs;

function docsRules() {
  const filter = jobs['docs-scope'].steps.find((step) => step.id === 'filter');
  assert.ok(filter, 'docs-scope must have a paths filter step');
  assert.match(filter.uses, /^dorny\/paths-filter@[0-9a-f]{40}$/);
  const rules = parse(filter.with.filters).docs;
  assert.ok(Array.isArray(rules) && rules.length > 0);
  return rules.map((rule) => {
    if (typeof rule === 'string') return { types: null, pattern: rule };
    const [[types, pattern]] = Object.entries(rule);
    return { types: types.split('|'), pattern };
  });
}

// dorny/paths-filter matches with picomatch({ dot: true }). The filter only
// uses literal segments, `*` and `**`, which this translation reproduces; the
// first test refuses any other glob syntax so the model cannot drift.
function globToRegExp(pattern) {
  let expression = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*' && pattern[index + 1] === '*') {
      index += 1;
      if (pattern[index + 1] === '/') {
        index += 1;
        expression += '(?:.*/)?';
      } else {
        expression += '.*';
      }
    } else if (character === '*') {
      expression += '[^/]*';
    } else {
      expression += character.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
    }
  }
  return new RegExp(`^${expression}$`);
}

function selected(changes) {
  const rules = docsRules();
  return changes.some(({ path, status = 'modified' }) =>
    rules.some(
      ({ types, pattern }) =>
        (types === null || types.includes(status)) && globToRegExp(pattern).test(path),
    ),
  );
}

test('docs scope filter uses only the glob syntax the matcher models', () => {
  for (const { types, pattern } of docsRules()) {
    assert.doesNotMatch(pattern, /[?[\]{}!()+@]/, pattern);
    for (const type of types ?? []) assert.ok(['added', 'modified', 'deleted'].includes(type), type);
  }
});

test('docs scope selects changes to the site and its copied inputs', () => {
  for (const path of [
    'docs/content/inference.md',
    'docs/docusaurus.config.ts',
    'docs/sidebars.ts',
    'docs/scripts/copy-readmes.js',
    'docs/data-surface-conformance.md',
    'docs/pnpm-lock.yaml',
    'packages/core/README.md',
    'packages/smrt-playground/host/README.md',
    'packages/smrt-workbench/host/README.md',
    'pnpm-workspace.yaml',
    'scripts/workspaces.mjs',
    '.github/workflows/on-pull-request.yml',
  ]) {
    assert.equal(selected([{ path }]), true, path);
  }
  // A new workspace makes copy-readmes require its README.
  assert.equal(selected([{ path: 'packages/new-thing/package.json', status: 'added' }]), true);
  // A README or doc may link to any deleted (or renamed-away) path.
  assert.equal(selected([{ path: 'packages/core/src/index.ts', status: 'deleted' }]), true);
  assert.equal(selected([{ path: '.github/CODEOWNERS', status: 'deleted' }]), true);
});

test('docs scope skips code-only changes', () => {
  for (const path of [
    'packages/core/src/index.ts',
    'packages/core/package.json',
    'packages/core/src/README.md',
    'packages/core/agents/inference.md',
    'scripts/check-standards.mjs',
    'pnpm-lock.yaml',
    'package.json',
    'AGENTS.md',
    '.github/workflows/test-suite.yml',
  ]) {
    assert.equal(selected([{ path }]), false, path);
    // An added workspace manifest is a new workspace, selected above.
    if (!path.endsWith('/package.json')) {
      assert.equal(selected([{ path, status: 'added' }]), false, `${path} (added)`);
    }
  }
});

test('docs site build mirrors the deploy build and runs for PRs and merge groups', () => {
  const scope = jobs['docs-scope'];
  const build = jobs['docs-site-build'];
  // Same trusted admission as the planner lane: merge groups and
  // same-repository PRs. Fork PRs go through the maintainer approval gate.
  assert.equal(scope.if, jobs['planner-scope'].if);
  assert.match(scope.if, /github\.event_name == 'merge_group'/);
  assert.equal(build.needs, 'docs-scope');
  assert.equal(build.if, "needs.docs-scope.outputs.docs == 'true'");
  assert.equal(build['runs-on'], 'ubuntu-latest');
  const runs = build.steps.map((step) => step.run).filter(Boolean);
  assert.deepEqual(runs, ['pnpm --dir docs install --frozen-lockfile', 'pnpm docs:site:build']);
  const root = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(root.scripts['docs:site:build'], 'pnpm --dir docs build');
  assert.doesNotMatch(JSON.stringify(build), /secrets\.|upload-pages-artifact|deploy-pages/);
});

test('Required CI fails on a selected docs build that did not succeed', () => {
  const required = jobs['required-ci'];
  assert.ok(required.needs.includes('docs-scope'));
  assert.ok(required.needs.includes('docs-site-build'));
  const step = required.steps.find((candidate) => candidate.name === 'Require full validation success');
  const env = {};
  for (const name of Object.keys(step.env)) env[name] = 'success';
  Object.assign(env, {
    EVENT_NAME: 'pull_request',
    PUBLISH_DRY_RUN: 'skipped',
    VISUAL_SELECTED: 'false',
    VISUAL_RESULT: 'skipped',
    PLANNER_SELECTED: 'false',
    PLANNER_RESULT: 'skipped',
  });
  const run = (overrides) =>
    spawnSync('bash', ['-c', step.run], { env: { ...env, ...overrides }, encoding: 'utf8' }).status;

  for (const result of ['success', 'failure', 'cancelled', 'skipped', '']) {
    assert.equal(run({ DOCS_SELECTED: 'true', DOCS_RESULT: result }) === 0, result === 'success', result);
    assert.equal(run({ DOCS_SELECTED: 'false', DOCS_RESULT: result }) === 0, result === 'skipped', result);
  }
  assert.equal(run({ DOCS_SCOPE: 'failure', DOCS_SELECTED: '', DOCS_RESULT: 'skipped' }) === 0, false);
  assert.equal(run({ DOCS_SCOPE: 'skipped', DOCS_SELECTED: '', DOCS_RESULT: 'skipped' }), 0);
});
