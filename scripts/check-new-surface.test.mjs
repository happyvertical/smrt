import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHECK = join(ROOT, 'scripts', 'check-new-surface.mjs');
const GENERATE = join(ROOT, 'scripts', 'generate-surface-ledger.mjs');

const SCHEMA = (tables) =>
  `export const A = \`\n${tables
    .map((t) => `CREATE TABLE IF NOT EXISTS ${t} (\n  id TEXT PRIMARY KEY\n);\n`)
    .join('\n')}\`;\n// CREATE TABLE IF NOT EXISTS is idempotent; _smrt_prose is only mentioned.\n`;

/** A throwaway repository: core with two system tables and a model, one more package. */
function fixture(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'new-surface-'));
  const put = (path, body) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  };
  put(
    'packages/core/package.json',
    JSON.stringify({
      name: '@x/core',
      exports: { '.': './dist/index.js', './browser': './dist/browser.js' },
    }),
  );
  put('packages/core/src/system/schema.ts', SCHEMA(['_smrt_ai_runs', '_smrt_ai_usage']));
  put(
    'packages/core/src/Thing.ts',
    "import { smrt } from './decorators';\n@smrt({\n  api: { include: ['list'] },\n})\nexport class Thing {}\n",
  );
  put(
    'packages/core/src/Aliased.ts',
    "import { smrt as model } from './decorators';\n\n@model()\n@other('x')\nexport default class Aliased {}\n",
  );
  put(
    'packages/core/src/Noise.ts',
    "// @smrt() class Ghost {}\n/**\n@smrt()\nclass Ghost2 {}\n*/\nconst t = `\n@smrt()\nclass Ghost3 {}\n`;\n",
  );
  put('packages/core/src/__tests__/T.ts', '@smrt()\nclass TestOnly {}\n');
  put('packages/core/src/T.test.ts', '@smrt()\nclass TestOnly2 {}\n');
  put('packages/prompts/package.json', JSON.stringify({ name: '@x/prompts', exports: { '.': './dist/index.js' } }));
  for (const [path, body] of Object.entries(extra)) {
    if (body === null) rmSync(join(root, path), { force: true });
    else put(path, body);
  }
  return root;
}

function run(script, root, args = []) {
  try {
    const stdout = execFileSync(process.execPath, [script, '--root', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, output: stdout };
  } catch (error) {
    return { code: error.status, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

const ledgerPath = (root) => join(root, 'surface-ledger.json');
const readEntries = (root) => JSON.parse(readFileSync(ledgerPath(root), 'utf8'));
const writeEntries = (root, entries) => writeFileSync(ledgerPath(root), JSON.stringify(entries, null, 2));

/** Fixture whose generated ledger is in place and passing. */
function recorded(extra) {
  const root = fixture(extra);
  assert.equal(run(GENERATE, root).code, 0);
  return root;
}

function withRoot(root, fn) {
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const FULL = {
  kind: 'system-table',
  name: '_smrt_ai_run_events',
  issue: 5005,
  nearest: ['_smrt_ai_runs'],
  reason: 'Ordered per-step events need their own rows and retention.',
};

test('inventory finds packages, exports keys, tables and decorated models only', () =>
  withRoot(recorded(), (root) => {
    const names = readEntries(root).map((e) => `${e.kind} ${e.name}`);
    assert.deepEqual(names, [
      'package @x/core',
      'package @x/prompts',
      'entry-point @x/core#.',
      'entry-point @x/core#./browser',
      'entry-point @x/prompts#.',
      'system-table _smrt_ai_runs',
      'system-table _smrt_ai_usage',
      'model @x/core:Aliased',
      'model @x/core:Thing',
    ]);
    assert.equal(run(CHECK, root).code, 0);
  }));

test('everything recorded passes', () =>
  withRoot(recorded(), (root) => assert.equal(run(CHECK, root).code, 0)));

test('a new package with no entry fails and is named', () =>
  withRoot(recorded(), (root) => {
    mkdirSync(join(root, 'packages/fresh'), { recursive: true });
    writeFileSync(join(root, 'packages/fresh/package.json'), JSON.stringify({ name: '@x/fresh' }));
    const r = run(CHECK, root);
    assert.equal(r.code, 1);
    assert.match(r.output, /unrecorded package: @x\/fresh/);
    assert.match(r.output, /"issue"/);
    assert.match(r.output, /review --directory/);
  }));

test('a new exports key with no entry fails and is named', () =>
  withRoot(recorded(), (root) => {
    writeFileSync(
      join(root, 'packages/prompts/package.json'),
      JSON.stringify({ name: '@x/prompts', exports: { '.': 'a', './runs': 'b' } }),
    );
    const r = run(CHECK, root);
    assert.equal(r.code, 1);
    assert.match(r.output, /unrecorded entry-point: @x\/prompts#\.\/runs/);
  }));

test('a new _smrt_ table with no entry fails; prose mentions do not count', () =>
  withRoot(recorded(), (root) => {
    writeFileSync(
      join(root, 'packages/core/src/system/schema.ts'),
      SCHEMA(['_smrt_ai_runs', '_smrt_ai_usage', '_smrt_inference_design_runs']),
    );
    const r = run(CHECK, root);
    assert.equal(r.code, 1);
    assert.match(r.output, /unrecorded system-table: _smrt_inference_design_runs/);
    assert.doesNotMatch(r.output, /_smrt_prose/);
  }));

test('a new @smrt model with no entry fails and is named', () =>
  withRoot(recorded(), (root) => {
    writeFileSync(join(root, 'packages/core/src/Extra.ts'), '@smrt()\nexport abstract class Extra {}\n');
    const r = run(CHECK, root);
    assert.equal(r.code, 1);
    assert.match(r.output, /unrecorded model: @x\/core:Extra/);
  }));

function withEntry(entry, fn) {
  return withRoot(recorded(), (root) => {
    const entries = readEntries(root);
    writeEntries(root, [...entries, entry].filter(Boolean));
    return fn(root, entries);
  });
}

function withNewTable(mutate) {
  return withRoot(recorded(), (root) => {
    writeFileSync(
      join(root, 'packages/core/src/system/schema.ts'),
      SCHEMA(['_smrt_ai_runs', '_smrt_ai_usage', '_smrt_ai_run_events']),
    );
    const entries = readEntries(root);
    const entry = mutate({ ...FULL });
    writeEntries(root, [...entries, entry]);
    return run(CHECK, root);
  });
}

test('a full entry for a new item passes', () => {
  const r = withNewTable((e) => e);
  assert.equal(r.code, 0, r.output);
});

test('a non-grandfathered entry missing issue fails', () => {
  const r = withNewTable(({ issue, ...rest }) => rest);
  assert.equal(r.code, 1);
  assert.match(r.output, /_smrt_ai_run_events: "issue" must be a positive integer/);
});

test('a non-grandfathered entry with an empty reason fails', () => {
  const r = withNewTable((e) => ({ ...e, reason: '  ' }));
  assert.equal(r.code, 1);
  assert.match(r.output, /"reason" must be a non-empty string/);
});

test('nearest naming an unknown item fails', () => {
  const r = withNewTable((e) => ({ ...e, nearest: ['_smrt_nope'] }));
  assert.equal(r.code, 1);
  assert.match(r.output, /"_smrt_nope", which is not in the ledger/);
});

test('empty nearest without noneBecause fails; with it passes', () => {
  const bad = withNewTable((e) => ({ ...e, nearest: [] }));
  assert.equal(bad.code, 1);
  assert.match(bad.output, /noneBecause/);
  const ok = withNewTable((e) => ({ ...e, nearest: [], noneBecause: 'No event store exists.' }));
  assert.equal(ok.code, 0, ok.output);
});

test('missing nearest fails', () => {
  const r = withNewTable(({ nearest, ...rest }) => rest);
  assert.equal(r.code, 1);
  assert.match(r.output, /"nearest" is required/);
});

test('a grandfathered entry needs no other fields', () =>
  withRoot(recorded(), (root) => {
    assert.ok(readEntries(root).every((e) => Object.keys(e).sort().join() === 'grandfathered,kind,name'));
    assert.equal(run(CHECK, root).code, 0);
  }));

test('an entry for a removed item is stale and fails', () =>
  withRoot(recorded(), (root) => {
    rmSync(join(root, 'packages/prompts'), { recursive: true });
    const r = run(CHECK, root);
    assert.equal(r.code, 1);
    assert.match(r.output, /stale ledger entry: package @x\/prompts/);
  }));

test('malformed JSON fails', () =>
  withRoot(recorded(), (root) => {
    writeFileSync(ledgerPath(root), '{ nope');
    const r = run(CHECK, root);
    assert.equal(r.code, 1);
    assert.match(r.output, /not valid JSON/);
  }));

test('an unknown kind fails', () =>
  withEntry({ kind: 'widget', name: 'x', grandfathered: true }, (root) => {
    const r = run(CHECK, root);
    assert.equal(r.code, 1);
    assert.match(r.output, /unknown kind "widget"/);
  }));

test('a duplicate kind+name fails', () =>
  withEntry({ kind: 'package', name: '@x/core', grandfathered: true }, (root) => {
    const r = run(CHECK, root);
    assert.equal(r.code, 1);
    assert.match(r.output, /duplicate ledger entry for package @x\/core/);
  }));

test('a missing ledger fails', () =>
  withRoot(fixture(), (root) => {
    const r = run(CHECK, root);
    assert.equal(r.code, 1);
    assert.match(r.output, /does not exist/);
  }));

test('the generator is idempotent and keeps full entries', () =>
  withRoot(fixture(), (root) => {
    assert.equal(run(GENERATE, root).code, 0);
    writeFileSync(
      join(root, 'packages/core/src/system/schema.ts'),
      SCHEMA(['_smrt_ai_runs', '_smrt_ai_usage', '_smrt_ai_run_events']),
    );
    // The new table is reported, not added.
    writeEntries(root, [...readEntries(root), FULL]);
    assert.equal(run(GENERATE, root).code, 0);
    const first = readFileSync(ledgerPath(root), 'utf8');
    assert.equal(run(GENERATE, root).code, 0);
    assert.equal(readFileSync(ledgerPath(root), 'utf8'), first);
    assert.deepEqual(readEntries(root).find((e) => e.name === FULL.name), FULL);
    assert.equal(run(CHECK, root).code, 0);
  }));

test('with a ledger, the generator never adds: it fails and the check still fails', () =>
  withRoot(recorded(), (root) => {
    mkdirSync(join(root, 'packages/fresh'), { recursive: true });
    writeFileSync(join(root, 'packages/fresh/package.json'), JSON.stringify({ name: '@x/fresh' }));
    const before = readFileSync(ledgerPath(root), 'utf8');
    const g = run(GENERATE, root);
    assert.equal(g.code, 1);
    assert.match(g.output, /"name": "@x\/fresh"/);
    assert.match(g.output, /"reason"/);
    assert.equal(readFileSync(ledgerPath(root), 'utf8'), before);
    assert.ok(!readEntries(root).some((e) => e.name === '@x/fresh'));
    const c = run(CHECK, root);
    assert.equal(c.code, 1);
    assert.match(c.output, /unrecorded package: @x\/fresh/);
  }));

test('bootstrap with no ledger writes grandfathered entries', () =>
  withRoot(fixture(), (root) => {
    assert.equal(run(GENERATE, root).code, 0);
    assert.ok(readEntries(root).length > 0);
    assert.ok(readEntries(root).every((e) => e.grandfathered === true));
  }));

test('the generator prunes a stale entry and exits 0', () =>
  withRoot(recorded(), (root) => {
    rmSync(join(root, 'packages/prompts'), { recursive: true });
    assert.equal(run(CHECK, root).code, 1);
    assert.equal(run(GENERATE, root).code, 0);
    assert.ok(!readEntries(root).some((e) => e.name.startsWith('@x/prompts')));
    assert.equal(run(CHECK, root).code, 0);
  }));

test('a hand-added grandfathered entry beyond the frozen count fails', () =>
  withRoot(recorded(), (root) => {
    const n = readEntries(root).length;
    assert.equal(run(CHECK, root, ['--frozen-count', String(n)]).code, 0);
    mkdirSync(join(root, 'packages/fresh'), { recursive: true });
    writeFileSync(join(root, 'packages/fresh/package.json'), JSON.stringify({ name: '@x/fresh' }));
    writeEntries(root, [
      ...readEntries(root),
      { kind: 'package', name: '@x/fresh', grandfathered: true },
    ]);
    const r = run(CHECK, root, ['--frozen-count', String(n)]);
    assert.equal(r.code, 1);
    assert.match(r.output, /frozen/);
  }));

test('a one-line CREATE TABLE on the template opening line is inventoried', () =>
  withRoot(recorded(), (root) => {
    writeFileSync(
      join(root, 'packages/core/src/system/schema.ts'),
      "export const CREATE_NEW_TABLE = `CREATE TABLE IF NOT EXISTS _smrt_new (id TEXT PRIMARY KEY);`;\n" +
        SCHEMA(['_smrt_ai_runs', '_smrt_ai_usage']),
    );
    const r = run(CHECK, root);
    assert.equal(r.code, 1);
    assert.match(r.output, /unrecorded system-table: _smrt_new\b/);
  }));

test('a CREATE TABLE mention inside a comment is not a table', () =>
  withRoot(recorded(), (root) => {
    writeFileSync(
      join(root, 'packages/core/src/system/schema.ts'),
      "// CREATE TABLE _smrt_x (old design)\n/* CREATE TABLE IF NOT EXISTS _smrt_y (id) */\n" +
        SCHEMA(['_smrt_ai_runs', '_smrt_ai_usage']).replace('`;', '-- CREATE TABLE _smrt_z (id)\n`;'),
    );
    assert.equal(run(CHECK, root).code, 0);
  }));

test('replay of the design-runs addition (#4954) fails', () =>
  withRoot(recorded(), (root) => {
    writeFileSync(
      join(root, 'packages/core/src/system/schema.ts'),
      SCHEMA(['_smrt_ai_runs', '_smrt_ai_usage', '_smrt_inference_design_runs']),
    );
    mkdirSync(join(root, 'packages/design-runs'), { recursive: true });
    writeFileSync(
      join(root, 'packages/design-runs/package.json'),
      JSON.stringify({ name: '@x/design-runs', exports: { '.': './dist/index.js' } }),
    );
    const r = run(CHECK, root);
    assert.equal(r.code, 1);
    assert.match(r.output, /unrecorded system-table: _smrt_inference_design_runs/);
    assert.match(r.output, /unrecorded package: @x\/design-runs/);
  }));

test('a namespace-qualified @ns.smrt model is inventoried and named', () =>
  withRoot(recorded(), (root) => {
    writeFileSync(
      join(root, 'packages/core/src/Extra.ts'),
      "import * as core from '@x/core';\n@core.smrt({ api: {} })\nexport class Extra {}\n",
    );
    const r = run(CHECK, root);
    assert.equal(r.code, 1);
    assert.match(r.output, /unrecorded model: @x\/core:Extra/);
  }));

test('a table name on the next line is still inventoried', () =>
  withRoot(recorded(), (root) => {
    writeFileSync(
      join(root, 'packages/core/src/system/schema.ts'),
      'export const A = `\nCREATE TABLE IF NOT EXISTS\n  _smrt_new (\n id TEXT\n);\n`;\n',
    );
    const r = run(CHECK, root);
    assert.equal(r.code, 1);
    assert.match(r.output, /unrecorded system-table: _smrt_new/);
  }));

test('lower-case, quoted and schema-qualified table names are inventoried', () =>
  withRoot(recorded(), (root) => {
    writeFileSync(
      join(root, 'packages/core/src/system/schema.ts'),
      'export const A = `\ncreate  table if not exists "_smrt_quoted" (id TEXT);\nCREATE TABLE public._smrt_qualified (id TEXT);\nCREATE TABLE [_smrt_bracket] (id TEXT);\n`;\n',
    );
    const r = run(CHECK, root);
    assert.equal(r.code, 1);
    for (const n of ['_smrt_quoted', '_smrt_qualified', '_smrt_bracket'])
      assert.match(r.output, new RegExp(`unrecorded system-table: ${n}`));
  }));

test('spaced decorator and stacked aliased import forms are inventoried', () =>
  withRoot(recorded(), (root) => {
    writeFileSync(
      join(root, 'packages/core/src/Spaced.ts'),
      "import {\n  type Foo,\n  smrt as m,\n} from '@x/core';\n@ m ()\nexport class Spaced {}\n",
    );
    const r = run(CHECK, root);
    assert.match(r.output, /unrecorded model: @x\/core:Spaced/);
  }));

const SMRT_NS = "import * as smrt from '@x/core';\n@smrt.smrt()\nexport class Extra {}\n";

test('a namespace named smrt: recorded model passes', () =>
  withRoot(recorded({ 'packages/core/src/Extra.ts': SMRT_NS }), (root) => {
    assert.ok(readEntries(root).some((e) => e.name === '@x/core:Extra'));
    assert.equal(run(CHECK, root).code, 0);
  }));

test('a namespace named smrt: unrecorded model is named', () =>
  withRoot(recorded(), (root) => {
    writeFileSync(join(root, 'packages/core/src/Extra.ts'), SMRT_NS);
    const r = run(CHECK, root);
    assert.equal(r.code, 1);
    assert.match(r.output, /unrecorded model: @x\/core:Extra/);
  }));

test('property-access decorators that are not model decorators are ignored', () =>
  withRoot(recorded(), (root) => {
    writeFileSync(
      join(root, 'packages/core/src/Other.ts'),
      "import * as smrt from '@x/core';\nimport * as core from '@x/core';\nclass Other {\n  @smrt.field()\n  a = 1;\n  @core.other()\n  b = 2;\n}\n@core.other()\nexport class Plain {}\n",
    );
    assert.equal(run(CHECK, root).code, 0);
  }));
