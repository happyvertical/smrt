import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  isGeneratedKnowledgePath,
  offendingPaths,
} from './check-generated-knowledge-untouched.mjs';

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  'check-generated-knowledge-untouched.mjs',
);

test('classifies generated and hand-authored knowledge paths', () => {
  for (const path of [
    'docs/knowledge/index.md',
    'docs/knowledge/components/index.md',
    'docs/knowledge/components/smrt-core.md',
  ]) {
    assert.equal(isGeneratedKnowledgePath(path), true, path);
  }
  for (const path of [
    'docs/knowledge/maintenance.md',
    'docs/knowledge/intents/index.md',
    'docs/knowledge/solutions/x.md',
    'docs/content/knowledge/index.md',
  ]) {
    assert.equal(isGeneratedKnowledgePath(path), false, path);
  }
  assert.deepEqual(offendingPaths(['a.md', 'docs/knowledge/index.md']), [
    'docs/knowledge/index.md',
  ]);
});

function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'smrt-gen-knowledge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'docs/knowledge/components'), { recursive: true });
  mkdirSync(join(dir, 'docs/knowledge/intents'), { recursive: true });
  writeFileSync(join(dir, 'docs/knowledge/components/a.md'), 'a');
  writeFileSync(join(dir, 'docs/knowledge/intents/i.md'), 'i');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'pr');
  return { dir, git };
}

function run(dir) {
  try {
    execFileSync('node', [SCRIPT, 'main'], { cwd: dir, stdio: 'pipe' });
    return 0;
  } catch (error) {
    return error.status;
  }
}

test('passes for hand-authored edits and for main moving ahead, fails for generated edits', (t) => {
  const { dir, git } = repo(t);
  writeFileSync(join(dir, 'docs/knowledge/intents/i.md'), 'edited');
  git('commit', '-q', '-am', 'intent');
  assert.equal(run(dir), 0);

  git('checkout', '-q', 'main');
  writeFileSync(join(dir, 'docs/knowledge/components/a.md'), 'regenerated');
  git('commit', '-q', '-am', 'regen on main');
  git('checkout', '-q', 'pr');
  assert.equal(run(dir), 0, 'main-only changes are not the PR');

  writeFileSync(join(dir, 'docs/knowledge/components/b.md'), 'new');
  git('add', 'docs/knowledge/components/b.md');
  git('commit', '-q', '-m', 'generated');
  assert.equal(run(dir), 1);
});

test('--files-from reads the pull request file list', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'smrt-gen-files-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const list = join(dir, 'files.txt');
  writeFileSync(list, 'README.md\ndocs/knowledge/intents/i.md\n');
  const ok = execFileSync('node', [SCRIPT, '--files-from', list]);
  assert.match(String(ok), /No generated/);
  writeFileSync(list, 'docs/knowledge/components/smrt-core.md\n');
  assert.throws(() => execFileSync('node', [SCRIPT, '--files-from', list], { stdio: 'pipe' }));
});
