/**
 * app-shell's `test:postgres` script runs 12 PostgreSQL files in one process;
 * CI runs them as the file-list units in SPLIT_POSTGRES_UNITS (#5664). These
 * tests pin that the units' files are exactly the unsplit file list, each once,
 * that Turbo knows each unit, and that the aggregate still runs the whole suite.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  POSTGRES_TEST_SECONDS,
  SPLIT_POSTGRES_UNITS,
  unitId,
} from './test-shard-balance.mjs';

const APP_SHELL = '@happyvertical/smrt-app-shell';
const root = new URL('../', import.meta.url);
const manifest = JSON.parse(
  readFileSync(new URL('packages/app-shell/package.json', root), 'utf8'),
);
const turbo = JSON.parse(readFileSync(new URL('turbo.json', root), 'utf8'));
const config = readFileSync(
  new URL('packages/app-shell/vitest.postgres.config.ts', root),
  'utf8',
);

/** `POSTGRES_SUITES` from the Vitest config: the unsplit file list. */
export function suiteFiles(source) {
  const body = /POSTGRES_SUITES\s*=\s*\[([^\]]*)\]/.exec(source)?.[1] ?? '';
  return [...body.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

/** The file arguments a unit script hands to `vitest run -c <postgres config>`. */
export function unitFiles(script) {
  const run = /vitest run -c vitest\.postgres\.config\.ts(.*)$/.exec(script);
  if (!run) throw new Error(`not a postgres vitest run: ${script}`);
  return run[1].trim().split(/\s+/).filter(Boolean);
}

const tasks = SPLIT_POSTGRES_UNITS[APP_SHELL];
const unitScripts = tasks.map((task) => ({ task, script: manifest.scripts[task] }));
const wanted = suiteFiles(config);

test('the unsplit file list is read from the config', () => {
  assert.ok(wanted.length >= 12, 'POSTGRES_SUITES lost files; update this test');
  assert.equal(new Set(wanted).size, wanted.length);
});

test('every unit is a hard-coded script through the CI database wrapper', () => {
  assert.ok(tasks.length > 1);
  for (const { task, script } of unitScripts) {
    assert.equal(typeof script, 'string', `${task} is missing from package.json`);
    assert.match(
      script,
      /^node \.\.\/\.\.\/scripts\/run-with-ci-postgres\.mjs -- pnpm exec vitest run -c vitest\.postgres\.config\.ts src\//,
      task,
    );
    assert.doesNotMatch(script, /passWithNoTests|pass-with-no-tests|--shard/, task);
  }
});

test('the union of the units equals the unsplit file list, each file once', () => {
  const files = unitScripts.flatMap(({ script }) => unitFiles(script));
  assert.deepEqual([...files].sort(), [...wanted].sort());
  assert.equal(new Set(files).size, files.length, 'a file is in two units');
  for (const { task, script } of unitScripts) {
    assert.ok(unitFiles(script).length > 0, `${task} is empty`);
  }
});

test('a file missing from every unit, or in two, fails the coverage check', () => {
  const files = unitScripts.flatMap(({ script }) => unitFiles(script));
  const extra = [...wanted, 'src/engine/new-postgres.test.ts'];
  assert.notDeepEqual([...files].sort(), [...extra].sort());
  const doubled = [...files, files[0]];
  assert.notEqual(new Set(doubled).size, doubled.length);
});

test('the aggregate test:postgres still runs the whole suite in one process', () => {
  assert.equal(
    manifest.scripts['test:postgres'],
    'node ../../scripts/run-with-ci-postgres.mjs -- pnpm exec vitest run -c vitest.postgres.config.ts',
  );
});

test('turbo.json registers each unit like test:postgres', () => {
  for (const task of tasks) {
    assert.deepEqual(turbo.tasks[task], turbo.tasks['test:postgres'], task);
  }
});

test('every unit has a measured weight, and the package has no whole weight', () => {
  for (const task of tasks) {
    assert.ok(POSTGRES_TEST_SECONDS[unitId(APP_SHELL, task)] > 0, task);
  }
  assert.equal(POSTGRES_TEST_SECONDS[APP_SHELL], undefined);
});

test('Vitest file filters are substrings: each unit selects exactly its own files', () => {
  for (const { task, script } of unitScripts) {
    const args = unitFiles(script);
    const selected = wanted.filter((file) => args.some((arg) => file.includes(arg)));
    assert.deepEqual(selected.sort(), [...args].sort(), task);
  }
});
