import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { metadataOnly, parseChanges, planFromGit, planImpact } from './ci-impact.mjs';

const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const workspaceConfig = "packages:\n  - 'packages/*'\n  - 'packages/smrt-playground/host'\n  - 'packages/smrt-workbench/host'\n\n";
function snapshot(definitions) {
  const manifests = {};
  const files = ['pnpm-workspace.yaml'];
  for (const [root, overrides] of Object.entries(definitions)) {
    const manifest = { name: root, scripts: { test: 'test', 'test:postgres': 'test' }, ...overrides };
    manifests[`${root}/package.json`] = manifest;
    files.push(`${root}/package.json`, `${root}/src/index.ts`);
  }
  return { workspaceConfig, files, manifests };
}
const graph = () => snapshot({
  'packages/ui': {},
  'packages/users': { dependencies: { 'packages/ui': 'workspace:*' } },
  'packages/ingestion': { peerDependencies: { 'packages/ui': '*' } },
  'packages/commerce': { devDependencies: { 'packages/ui': 'workspace:*' } },
  'packages/other': {},
});
const run = (before, after, paths, status = 'M') => planImpact({ base, head, baseSnapshot: before, headSnapshot: after, changes: [{ status, paths }] });
const selected = (plan, suite = 'test') => plan.suites[suite].map((pkg) => pkg.name);

test('shared UI runtime selects all consumers including PostgreSQL and dev/peer edges', () => {
  const tree = graph();
  const plan = run(tree, tree, ['packages/ui/src/index.ts']);
  assert.equal(plan.full, false);
  assert.deepEqual(selected(plan), ['packages/commerce', 'packages/ingestion', 'packages/ui', 'packages/users']);
  assert.deepEqual(selected(plan, 'test:postgres'), selected(plan));
});

test('union graph retains removed dependency edges and new optional edges', () => {
  const before = graph();
  const after = graph();
  delete after.manifests['packages/users/package.json'].dependencies;
  after.manifests['packages/other/package.json'].optionalDependencies = { 'packages/ui': '*' };
  const plan = run(before, after, ['packages/ui/src/index.ts']);
  assert.equal(selected(plan).length, 5);
});

test('deleted package still selects surviving former consumers', () => {
  const before = graph();
  const after = graph();
  after.files = after.files.filter((path) => !path.startsWith('packages/ui/'));
  delete after.manifests['packages/ui/package.json'];
  // A removed workspace dependency cannot remain unresolved in the head tree.
  delete after.manifests['packages/users/package.json'].dependencies;
  delete after.manifests['packages/commerce/package.json'].devDependencies;
  delete after.manifests['packages/ingestion/package.json'].peerDependencies;
  const plan = run(before, after, ['packages/ui/src/index.ts'], 'D');
  assert.equal(plan.full, false);
  assert.deepEqual(selected(plan), ['packages/commerce', 'packages/ingestion', 'packages/users']);
});

test('renames preserve both owners and consumers; deletions remain affected', () => {
  const before = graph();
  const after = graph();
  after.files = after.files.filter((path) => path !== 'packages/ui/src/index.ts');
  const plan = run(before, after, ['packages/ui/src/index.ts', 'packages/other/src/index.ts'], 'R100');
  assert.equal(selected(plan).length, 5);
  assert.deepEqual(parseChanges('R100\0old.ts\0new.ts\0D\0gone.ts\0'), [{ status: 'R100', paths: ['old.ts', 'new.ts'] }, { status: 'D', paths: ['gone.ts'] }]);
  assert.throws(() => parseChanges('M\0missing'));
  assert.throws(() => parseChanges('Q\0unknown\0'));
});

test('only parsed nonsemantic manifest fields avoid source suites', () => {
  const before = graph();
  const after = graph();
  after.manifests['packages/ui/package.json'].description = 'new description';
  let plan = run(before, after, ['packages/ui/package.json']);
  assert.deepEqual(selected(plan), []);
  assert.equal(plan.packaging, true);
  assert.equal(plan.knowledge, true);
  assert.equal(plan.full, false);
  for (const [field, value] of Object.entries({ exports: { '.': './dist/index.js' }, scripts: { test: 'changed' }, engines: { node: '>=26' }, files: ['dist'], customBuild: true })) {
    const changed = graph();
    changed.manifests['packages/ui/package.json'][field] = value;
    plan = run(before, changed, ['packages/ui/package.json']);
    assert.ok(selected(plan).includes('packages/users'), field);
  }
  assert.equal(metadataOnly(null, {}), false);
});

test('nested workspace host has its own identity rather than parent ownership', () => {
  const tree = snapshot({ 'packages/smrt-workbench': {}, 'packages/smrt-workbench/host': {}, 'packages/other': {} });
  const plan = run(tree, tree, ['packages/smrt-workbench/host/src/index.ts']);
  assert.deepEqual(selected(plan), ['packages/smrt-workbench/host']);
});

test('global, unknown, malformed and harness inputs fail closed', () => {
  for (const path of ['pnpm-lock.yaml', '.github/workflows/ci.yml', 'scripts/helper.mjs', 'package.json', 'tsconfig.json', 'unknown/new.ts', 'packages/unknown/file.ts']) {
    const tree = graph();
    tree.files.push(path);
    const plan = run(tree, tree, [path]);
    assert.equal(plan.full, true, path);
    assert.equal(selected(plan).length, 5);
  }
  for (const root of ['packages/core', 'packages/scanner', 'packages/vitest']) {
    const tree = snapshot({ [root]: {}, 'packages/other': {} });
    assert.equal(run(tree, tree, [`${root}/src/index.ts`]).full, true);
  }
  const tree = graph();
  assert.equal(run(tree, tree, ['packages/ui/not-in-tree.ts']).full, true);
  assert.equal(planImpact({ base, head, baseSnapshot: tree, headSnapshot: tree, changes: null }).full, true);
  const unknownLayout = { ...tree, workspaceConfig: `${workspaceConfig}packages: ['new/*']\n` };
  // A changed workspace file always forces full; layout header changes do too.
  assert.equal(run(tree, unknownLayout, ['pnpm-workspace.yaml']).full, true);
  assert.equal(run(tree, { ...tree, workspaceConfig: "packages: ['new/*']" }, ['packages/ui/src/index.ts']).full, true);
  const malformed = graph();
  malformed.manifests['packages/ui/package.json'] = null;
  assert.equal(run(tree, malformed, ['packages/ui/src/index.ts']).inventoryComplete, false);
});

test('Git adapter uses exact trees, sees deletion, and fails broad on missing history', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'smrt-ci-impact-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(cwd, 'pnpm-workspace.yaml'), workspaceConfig);
    for (const [path, manifest] of Object.entries(graph().manifests)) {
      mkdirSync(join(cwd, path, '..'), { recursive: true });
      writeFileSync(join(cwd, path), JSON.stringify(manifest));
    }
    mkdirSync(join(cwd, 'packages/ui/src'), { recursive: true });
    writeFileSync(join(cwd, 'packages/ui/src/index.ts'), 'export {};');
    git('add', '.'); git('commit', '-m', 'base');
    const exactBase = git('rev-parse', 'HEAD');
    rmSync(join(cwd, 'packages/ui/src/index.ts'));
    git('add', '.'); git('commit', '-m', 'head');
    const exactHead = git('rev-parse', 'HEAD');
    const plan = planFromGit({ cwd, base: exactBase, head: exactHead });
    assert.equal(plan.full, false);
    assert.ok(selected(plan).includes('packages/users'));
    const missing = planFromGit({ cwd, base, head: exactHead });
    assert.equal(missing.full, true);
    assert.equal(missing.inventoryComplete, true);
    assert.equal(selected(missing).length, 5);
    assert.equal(planFromGit({ cwd, base: 'HEAD~1', head: exactHead }).full, true);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('package identity changes select both graph identities and current package', () => {
  const before = snapshot({ 'packages/a': { name: 'old-name' }, 'packages/b': { dependencies: { 'old-name': '*' } } });
  const after = snapshot({ 'packages/a': { name: 'new-name' }, 'packages/b': { dependencies: { 'new-name': '*' } } });
  const plan = run(before, after, ['packages/a/package.json']);
  assert.equal(plan.full, false);
  assert.deepEqual(selected(plan), ['new-name', 'packages/b']);
});

test('duplicate workspace config and unresolved local dependencies fail broad', () => {
  const before = graph();
  const duplicate = { ...before, workspaceConfig: `${workspaceConfig}"packages": ['elsewhere/*']\n` };
  assert.equal(run(before, duplicate, ['packages/ui/src/index.ts']).full, true);
  const after = graph();
  after.manifests['packages/ui/package.json'].dependencies = { unexpected: 'link:../other' };
  assert.equal(run(before, after, ['packages/ui/src/index.ts']).full, true);
});
