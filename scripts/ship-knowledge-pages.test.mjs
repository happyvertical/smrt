import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  SHIPPED_COMPONENT_PAGE,
  shipAllKnowledge,
  shipPackageKnowledge,
} from './ship-knowledge-pages.mjs';

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'smrt-ship-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs/knowledge/components'), { recursive: true });
  mkdirSync(join(root, 'docs/knowledge/intents'), { recursive: true });
  writeFileSync(join(root, 'docs/knowledge/intents/index.md'), 'index');
  writeFileSync(join(root, 'docs/knowledge/intents/background-work.md'), 'bg');
  return root;
}

function pkg(root, dir, manifest, { dist = true } = {}) {
  const path = join(root, 'packages', dir);
  mkdirSync(dist ? join(path, 'dist') : path, { recursive: true });
  writeFileSync(join(path, 'package.json'), JSON.stringify(manifest));
  return path;
}

test('copies the committed page into dist, keyed by the unscoped package name', (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'docs/knowledge/components/smrt-jobs.md'), 'jobs page');
  const dir = pkg(root, 'jobs', { name: '@happyvertical/smrt-jobs' });

  assert.deepEqual(shipPackageKnowledge(dir, root), [
    join('dist', SHIPPED_COMPONENT_PAGE),
  ]);
  assert.equal(
    readFileSync(join(dir, 'dist', SHIPPED_COMPONENT_PAGE), 'utf8'),
    'jobs page',
  );
});

test('ships the intent pages with smrt-cli only, replacing stale ones', (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'docs/knowledge/components/smrt-cli.md'), 'cli page');
  const dir = pkg(root, 'cli', { name: '@happyvertical/smrt-cli' });
  const stale = join(dir, 'dist/knowledge/intents/retired.md');
  mkdirSync(join(dir, 'dist/knowledge/intents'), { recursive: true });
  writeFileSync(stale, 'old');

  shipPackageKnowledge(dir, root);

  assert.equal(existsSync(stale), false);
  assert.equal(
    readFileSync(join(dir, 'dist/knowledge/intents/background-work.md'), 'utf8'),
    'bg',
  );
});

test('ships the full intent set with smrt-dev-mcp too, and with no other package', (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'docs/knowledge/components/smrt-dev-mcp.md'), 'mcp');
  writeFileSync(join(root, 'docs/knowledge/components/smrt-jobs.md'), 'jobs');
  const mcp = pkg(root, 'smrt-dev-mcp', { name: '@happyvertical/smrt-dev-mcp' });
  const jobs = pkg(root, 'jobs', { name: '@happyvertical/smrt-jobs' });

  shipPackageKnowledge(mcp, root);
  shipPackageKnowledge(jobs, root);

  assert.equal(
    readFileSync(join(mcp, 'dist/knowledge/intents/index.md'), 'utf8'),
    'index',
  );
  assert.equal(existsSync(join(jobs, 'dist/knowledge/intents')), false);
});

test('skips private and dist-less packages but fails on a public package without a page', (t) => {
  const root = workspace(t);
  const priv = pkg(root, 'priv', { name: '@happyvertical/smrt-priv', private: true });
  const noDist = pkg(root, 'tpl', { name: '@happyvertical/smrt-tpl' }, { dist: false });
  assert.deepEqual(shipPackageKnowledge(priv, root), []);
  assert.deepEqual(shipPackageKnowledge(noDist, root), []);

  pkg(root, 'orphan', { name: '@happyvertical/smrt-orphan' });
  assert.throws(() => shipAllKnowledge(root), /pnpm knowledge:okf/);
});
