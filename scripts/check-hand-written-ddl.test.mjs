import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluate, findStatements, scanPackages } from './check-hand-written-ddl.mjs';

const script = fileURLToPath(new URL('./check-hand-written-ddl.mjs', import.meta.url));

function repo(files, baseline) {
  const root = mkdtempSync(join(tmpdir(), 'hand-written-ddl-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  if (baseline) {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(
      join(root, 'scripts/hand-written-ddl-baseline.json'),
      JSON.stringify({ statements: baseline }),
    );
  }
  return root;
}
const run = (root, ...args) =>
  spawnSync(process.execPath, [script, '--root', root, ...args], { encoding: 'utf8' });
const cleanup = (...roots) => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
};

const SQL = `export const up = (db) => db.exec(\`
  CREATE TABLE IF NOT EXISTS widgets (id TEXT PRIMARY KEY);
  ALTER TABLE "widgets" ADD COLUMN size INTEGER;
\`);
`;

test('finds create, alter and drop statements and their tables', () => {
  const found = findStatements(`
    db.exec('CREATE TABLE IF NOT EXISTS a (id TEXT)');
    db.exec(\`alter table \${q(name)} add column x text\`);
    db.exec("DROP TABLE IF EXISTS \\"b\\"");
    // CREATE TABLE ignored (id TEXT)
    /* ALTER TABLE ignored */
    throw new Error("Failed to create table 'x'");
  `);
  assert.equal(found.length, 3);
  assert.deepEqual(
    found.map((f) => [f.verb, f.table.replace(/\\/g, '')]),
    [
      ['CREATE', 'a'],
      ['ALTER', '${q(name)}'],
      ['DROP', '"b"'],
    ],
  );
});

test('a new hand-written statement outside the migrator fails with file and line', () => {
  const root = repo({ 'packages/p/src/store.ts': `\n${SQL}` }, {});
  try {
    const out = run(root);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /packages\/p\/src\/store\.ts:\d+ hand-written CREATE TABLE widgets/);
  } finally {
    cleanup(root);
  }
});

test('statements in the migrator, the system tables, tests and generated files are not flagged', () => {
  const root = repo(
    {
      'packages/core/src/migrations/foo.ts': SQL,
      'packages/core/src/schema/generator.ts': SQL,
      'packages/core/src/system/schema.ts': SQL,
      'packages/cli/src/commands/db-migrate-x.ts': SQL,
      'packages/p/src/store.test.ts': SQL,
      'packages/p/src/__tests__/store.ts': SQL,
      'packages/p/src/gen.ts': `/** Auto-generated. DO NOT EDIT */\n${SQL}`,
    },
    {},
  );
  try {
    assert.equal(scanPackages(root).size, 0);
    assert.equal(run(root).status, 0);
  } finally {
    cleanup(root);
  }
});

test('baseline entries pass; a second statement beyond the baseline count fails', () => {
  const files = { 'packages/p/src/store.ts': SQL };
  const base = {
    'packages/p/src/store.ts::CREATE TABLE widgets': 1,
    'packages/p/src/store.ts::ALTER TABLE "widgets"': 1,
  };
  const ok = repo(files, base);
  const grown = repo(
    { 'packages/p/src/store.ts': `${SQL}\n${SQL}` },
    base,
  );
  try {
    assert.equal(run(ok).status, 0);
    const out = run(grown);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /packages\/p\/src\/store\.ts:\d+ hand-written CREATE TABLE widgets/);
  } finally {
    cleanup(ok, grown);
  }
});

test('removing a baseline entry whose statement is still there fails', () => {
  const root = repo({ 'packages/p/src/store.ts': SQL }, {
    'packages/p/src/store.ts::CREATE TABLE widgets': 1,
  });
  try {
    const out = run(root);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /hand-written ALTER TABLE "widgets"/);
  } finally {
    cleanup(root);
  }
});

test('a stale entry fails and --prune removes it', () => {
  const root = repo({ 'packages/p/src/store.ts': 'export const x = 1;\n' }, {
    'packages/p/src/store.ts::CREATE TABLE widgets': 1,
  });
  try {
    const out = run(root);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /Stale baseline entry/);
    assert.equal(run(root, '--prune').status, 0);
    assert.deepEqual(
      JSON.parse(readFileSync(join(root, 'scripts/hand-written-ddl-baseline.json'), 'utf8')).statements,
      {},
    );
    assert.equal(run(root).status, 0);
  } finally {
    cleanup(root);
  }
});

test('the baseline cannot grow: --init refuses once it exists, and evaluate flags growth against a base', () => {
  const root = repo({ 'packages/p/src/store.ts': SQL });
  try {
    assert.equal(run(root, '--init').status, 0);
    assert.equal(run(root, '--init').status, 1);
  } finally {
    cleanup(root);
  }
  const found = new Map([['k', { key: 'k', file: 'f', lines: [1, 2] }]]);
  assert.deepEqual(evaluate(found, { k: 2 }, { k: 2 }).errors, []);
  assert.match(evaluate(found, { k: 2 }, { k: 1 }).errors[0], /Baseline grew: k/);
  assert.match(evaluate(found, { k: 2 }, {}).errors[0], /Baseline grew: k/);
});

test('the repository passes its own check', () => {
  const out = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
});
