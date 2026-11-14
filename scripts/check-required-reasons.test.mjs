import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  evaluate,
  findRequiredFields,
  maskComments,
  scanPackages,
} from './check-required-reasons.mjs';

const script = fileURLToPath(new URL('./check-required-reasons.mjs', import.meta.url));

function repo(files, baseline) {
  const root = mkdtempSync(join(tmpdir(), 'required-reasons-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  if (baseline) {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(
      join(root, 'scripts/required-reasons-baseline.json'),
      JSON.stringify({ unexplained: baseline }),
    );
  }
  return root;
}

const run = (root, ...args) =>
  spawnSync(process.execPath, [script, '--root', root, ...args], { encoding: 'utf8' });

const MODEL = (field) => `import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
@smrt()
export class Thing extends SmrtObject {
  ${field}
  name: string = '';
}
`;

test('finds required fields across decorator shapes', () => {
  const found = findRequiredFields(`
class Order {
  @field({ required: true }) a = '';
  @field({ type: 'text', required: true, requiredFor: 'identity' })
  private readonly b: string = '';
  @foreignKey('Customer', { required: true }) customerId = '';
  @crossPackageRef('@x/y:Z', {
    required: true,
    description: 'a, b: {c}',
  })
  override ownerId = '';
  @field({ pattern: /^[a-z,"']+$/, required: true }) pat = '';
  @field({ ui: { required: true } }) nested = '';
  @field({ required: false }) off = '';
  // @field({ required: true }) commented = '';
  @field({ required: true })
  @other()
  stacked = '';
}`);
  assert.deepEqual(
    found.map((f) => [f.class, f.field, f.requiredFor]),
    [
      ['Order', 'a', null],
      ['Order', 'b', 'identity'],
      ['Order', 'customerId', null],
      ['Order', 'ownerId', null],
      ['Order', 'pat', null],
      ['Order', 'stacked', null],
    ],
  );
});

test('masks comments but keeps strings that look like comments', () => {
  const masked = maskComments(`const a = 'http://x'; // gone\n/* gone */ b`);
  assert.ok(masked.includes("'http://x'"));
  assert.ok(!masked.includes('gone'));
});

test('a required field with no reason fails and names file, class and field', () => {
  const root = repo({ 'packages/p/src/Thing.ts': MODEL(`@field({ required: true })\n  slug: string = '';`) }, []);
  try {
    const out = run(root);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /packages\/p\/src\/Thing\.ts:\d+ Thing\.slug is required with no reason/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a required field with a reason passes', () => {
  const root = repo(
    { 'packages/p/src/Thing.ts': MODEL(`@field({ required: true, requiredFor: 'identity' })\n  slug: string = '';`) },
    [],
  );
  try {
    const out = run(root);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /1 required field\(s\) state a reason; 0 unexplained/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unexplained field in the baseline passes; removing it from the baseline fails', () => {
  const files = { 'packages/p/src/Thing.ts': MODEL(`@field({ required: true })\n  slug: string = '';`) };
  const key = 'packages/p/src/Thing.ts#Thing.slug';
  const withEntry = repo(files, [key]);
  const without = repo(files, []);
  try {
    assert.equal(run(withEntry).status, 0);
    const out = run(without);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /Thing\.slug is required with no reason/);
  } finally {
    rmSync(withEntry, { recursive: true, force: true });
    rmSync(without, { recursive: true, force: true });
  }
});

test('a baseline entry whose field now has a reason is stale and --prune removes it', () => {
  const root = repo(
    { 'packages/p/src/Thing.ts': MODEL(`@field({ required: true, requiredFor: 'idempotency' })\n  slug: string = '';`) },
    ['packages/p/src/Thing.ts#Thing.slug', 'packages/p/src/Gone.ts#Gone.x'],
  );
  try {
    const out = run(root);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /Stale baseline entry packages\/p\/src\/Thing\.ts#Thing\.slug/);
    assert.match(out.stderr, /Stale baseline entry packages\/p\/src\/Gone\.ts#Gone\.x/);
    assert.equal(run(root, '--prune').status, 0);
    assert.deepEqual(
      JSON.parse(readFileSync(join(root, 'scripts/required-reasons-baseline.json'), 'utf8')).unexplained,
      [],
    );
    assert.equal(run(root).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects an unknown reason, a non-literal reason and a reason on an optional field', () => {
  for (const [decl, pattern] of [
    [`@field({ required: true, requiredFor: 'because' })\n  a: string = '';`, /'because' is not one of/],
    [`@field({ required: true, requiredFor: REASON })\n  a: string = '';`, /must be a string literal/],
    [`@field({ requiredFor: 'identity' })\n  a: string = '';`, /not required: true/],
  ]) {
    const root = repo({ 'packages/p/src/Thing.ts': MODEL(decl) }, []);
    try {
      const out = run(root);
      assert.equal(out.status, 1);
      assert.match(out.stderr, pattern);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('ignores tests, fixtures and dist', () => {
  const field = MODEL(`@field({ required: true })\n  slug: string = '';`);
  const root = repo(
    {
      'packages/p/src/Thing.test.ts': field,
      'packages/p/src/__tests__/Thing.ts': field,
      'packages/p/src/fixtures/Thing.ts': field,
      'packages/p/dist/Thing.ts': field,
    },
    [],
  );
  try {
    assert.equal(scanPackages(root).entries.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('evaluate flags a baseline that grew past the base baseline', () => {
  const scan = {
    entries: [{ key: 'a#A.x', file: 'a', line: 1, class: 'A', field: 'x', explained: false }],
    problems: [],
  };
  assert.deepEqual(evaluate(scan, ['a#A.x'], ['a#A.x']).errors, []);
  const grown = evaluate(scan, ['a#A.x'], []);
  assert.match(grown.errors[0], /Baseline grew: a#A\.x/);
});

test('--init refuses once a baseline exists', () => {
  const root = repo({ 'packages/p/src/Thing.ts': MODEL(`@field({ required: true })\n  slug: string = '';`) });
  try {
    assert.equal(run(root, '--init').status, 0);
    assert.equal(run(root).status, 0);
    const again = run(root, '--init');
    assert.equal(again.status, 1);
    assert.match(again.stderr, /may only shrink/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the repository passes its own check', () => {
  const out = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
});

test('covers the fields a caller must supply, written or inferred (#4935)', () => {
  const found = findRequiredFields(`
class Order {
  @field({ required: true }) written = '';
  @field({ required: true }) status: string = 'active';
  @field({ required: true }) count = 0;
  @field({ required: true }) flag: boolean = false;
  @field({ type: 'text', required: true, default: 'x' }) decoratorDefault!: string;
  @field() inferred!: string;
  @field() withInitializer: string = 'a';
  @field() maybe?: string;
  @field({ type: 'text', default: 'x' }) hasDefaultOption!: string;
  @field({ nullable: true }) nullableField!: string;
  @foreignKey('Customer') customerId!: string;
  @foreignKey('Customer') optionalFk?: string;
  @crossPackageRef('@x/y:Z')
  @field({ required: true })
  stackedRef: string = '';
  @tenantId() tenantId!: string;
  @tenantId({ nullable: true }) looseTenant!: string;
  @field({ required: true, requiredFor: 'identity' }) reasoned: string = 'k';
  get fake() { return 1; }
}`);
  const by = Object.fromEntries(found.map((f) => [f.field, f]));
  const demanded = found.filter((f) => f.demanded).map((f) => f.field).sort();
  assert.deepEqual(demanded, [
    'customerId',
    'decoratorDefault',
    'inferred',
    'stackedRef',
    'tenantId',
    'written',
  ]);
  // A real class initializer satisfies the save check: not demanded.
  for (const f of ['status', 'count', 'flag', 'reasoned']) assert.equal(by[f].demanded, false, f);
  assert.equal(by.tenantId.implicit, true);
  assert.equal(by.reasoned.requiredFor, 'identity');
  for (const f of ['withInitializer', 'maybe', 'hasDefaultOption', 'nullableField', 'optionalFk', 'looseTenant']) {
    assert.equal(by[f], undefined, `${f} is not required`);
  }
});

test('a calculated field is not demanded of the caller (#4915)', () => {
  const found = findRequiredFields(`
class Line {
  @field({ type: 'integer', required: true, generated: { op: 'mul', left: { col: 'qty' }, right: { col: 'price' } } })
  total!: number;
  @field({ type: 'integer', generated: { op: 'add', left: { col: 'qty' }, right: { value: 1 } } })
  inferredTotal!: number;
  @field({ required: true }) written!: string;
}`);
  const by = Object.fromEntries(found.map((f) => [f.field, f]));
  assert.equal(by.total.required, true);
  assert.equal(by.total.demanded, false);
  assert.equal(by.inferredTotal.demanded, false);
  assert.equal(by.written.demanded, true);
  const root = repo(
    {
      'packages/a/src/thing.ts': MODEL(
        `@field({ type: 'integer', required: true, generated: { op: 'add', left: { col: 'qty' }, right: { value: 1 } } })\n  total!: number;`,
      ),
    },
    [],
  );
  assert.equal(run(root).status, 0);
  rmSync(root, { recursive: true });
});

test('a field a real initializer satisfies needs neither a reason nor a baseline entry', () => {
  const root = repo(
    {
      'packages/a/src/thing.ts': MODEL(`@field({ required: true })\n  status: string = 'active';`),
    },
    [],
  );
  assert.equal(run(root).status, 0);
  rmSync(root, { recursive: true });
});

test('an inferred required field with no reason fails and names the field', () => {
  const root = repo(
    { 'packages/a/src/thing.ts': MODEL(`@field()\n  owner!: string;`) },
    [],
  );
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /thing\.ts:\d+ Thing\.owner is required with no reason/);
  rmSync(root, { recursive: true });
});
