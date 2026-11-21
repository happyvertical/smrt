/**
 * Served-surface gate (scripts/check-served-surface.mjs). Each package's
 * served operations are computed in a fresh process from its built manifest
 * plus its smrtDependencies closure, using the transports' own emitted lists
 * (MCP tools, CLI commands) and the shared REST resolvers. Needs built core
 * and cli (`pnpm build`).
 */
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
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  checkParityKnownAgainst,
  classifyChanges,
  collectServedSurface,
  parseSurfaceFile,
  planEntry,
  runServedSurface,
  surfaceFileName,
} from '../lib/served-surface.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const corePath = path.join(repo, 'packages/core/dist/index.js');
const cliPath = path.join(repo, 'packages/cli/dist/generator.js');
const { ManifestGenerator } = await import(
  pathToFileURL(path.join(repo, 'packages/core/dist/scanner/manifest-generator.js'))
    .href
);

function fixtureRoot(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'served-surface-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true }),
  );
  return root;
}

const def = (className, extra = {}) => ({
  name: className.toLowerCase(),
  className,
  collection: `${className.toLowerCase()}s`,
  filePath: `/fixture/src/${className}.ts`,
  fields: { title: { type: 'text' } },
  methods: {},
  decoratorConfig: {},
  ...extra,
});

const method = (name, extra = {}) => ({
  name,
  async: true,
  parameters: [],
  returnType: 'Promise<void>',
  isStatic: false,
  isPublic: true,
  ...extra,
});

/** Writes packages/<dir> with a manifest built by the real generator. */
function writePackage(root, dir, packageName, defs, deps = [], tweak) {
  const manifest = new ManifestGenerator().generateManifest(
    [
      {
        filePath: `/fixture/${dir}/src`,
        objects: defs.map((d) => ({ ...d, packageName })),
        errors: [],
      },
    ],
    { packageName, smrtDependencies: deps },
  );
  manifest.smrtDependencies = deps;
  tweak?.(manifest);
  const pkgDir = path.join(root, 'packages', dir);
  mkdirSync(path.join(pkgDir, 'dist'), { recursive: true });
  writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: packageName, version: '0.0.0', type: 'module' }),
  );
  writeFileSync(
    path.join(pkgDir, 'dist/manifest.json'),
    JSON.stringify(manifest, null, 2),
  );
  return manifest;
}

const coreDist = path.dirname(corePath);
const collect = (root, options = {}) =>
  collectServedSurface({ root, corePath, coreDist, cliPath, ...options });

function entriesOf(result, packageName) {
  const text = result.files[packageName];
  assert.ok(text, `no file for ${packageName}: ${result.errors.join('\n')}`);
  return parseSurfaceFile(text);
}

const entry = (parsed, key) => {
  const found = parsed.entries.get(key);
  assert.ok(found, `no entry ${key}`);
  return found;
};

const A = '@served/alpha';
const B = '@served/beta';

test('same input twice and shuffled manifest order give identical bytes', async (t) => {
  const root = fixtureRoot(t);
  writePackage(root, 'alpha', A, [
    def('Note', { decoratorConfig: { api: { include: ['list', 'get'] } } }),
    def('Tag'),
    def('Label', { decoratorConfig: { mcp: false } }),
  ]);
  const first = await collect(root);
  assert.deepEqual(first.errors, []);
  const second = await collect(root);
  assert.equal(second.files[A], first.files[A]);

  const file = path.join(root, 'packages/alpha/dist/manifest.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  manifest.objects = Object.fromEntries(
    Object.entries(manifest.objects).reverse(),
  );
  writeFileSync(file, JSON.stringify(manifest));
  const shuffled = await collect(root);
  assert.equal(shuffled.files[A], first.files[A]);
});

test('package without dist fails', async (t) => {
  const root = fixtureRoot(t);
  writePackage(root, 'alpha', A, [def('Note')]);
  const src = path.join(root, 'packages/beta/src');
  mkdirSync(src, { recursive: true });
  writeFileSync(
    path.join(src, 'thing.ts'),
    "import { smrt, SmrtObject } from '@happyvertical/smrt-core';\n@smrt()\nexport class Thing extends SmrtObject {}\n",
  );
  // A test-fixture package that never builds publishes nothing to serve.
  writeFileSync(
    path.join(root, 'packages/beta/package.json'),
    JSON.stringify({ name: B, version: '0.0.0', private: true }),
  );
  assert.deepEqual((await collect(root)).errors, []);
  // One that builds must have its manifest.
  writeFileSync(
    path.join(root, 'packages/beta/package.json'),
    JSON.stringify({ name: B, version: '0.0.0', scripts: { build: 'vite build' } }),
  );
  const result = await collect(root);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /@served\/beta.*no built manifest/);
});

test('local run builds first; --no-build refused unless CI=true', () => {
  assert.deepEqual(planEntry([], {}), { build: true, write: false, loaderParity: false, repin: false });
  assert.deepEqual(planEntry(['--write'], {}), { build: true, write: true, loaderParity: false, repin: false });
  assert.match(planEntry(['--no-build'], {}).error, /CI=true/);
  assert.deepEqual(planEntry(['--no-build'], { CI: 'true' }), {
    build: false,
    write: false,
    loaderParity: false,
    repin: false,
  });
  assert.equal(planEntry(['--loader-parity'], {}).loaderParity, true);
  assert.equal(planEntry(['--loader-parity', '--repin'], {}).repin, true);
  assert.match(planEntry(['--repin'], {}).error, /only applies with --loader-parity/);
  assert.deepEqual(planEntry(['--against', 'abc123'], {}), { against: 'abc123' });
  assert.match(planEntry(['--against'], {}).error, /git ref/);
});

test('duplicate qualified key across manifests fails', async (t) => {
  const root = fixtureRoot(t);
  writePackage(root, 'alpha', A, [def('Note')]);
  writePackage(root, 'beta', B, [def('Other')], [], (manifest) => {
    manifest.objects[`${A}:Note`] = {
      ...manifest.objects[`${B}:Other`],
      className: 'Note',
      qualifiedName: `${A}:Note`,
      packageName: A,
    };
  });
  const result = await collect(root);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /duplicate qualified key @served\/alpha:Note/);
});

test('cross-package STI parent, registration order irrelevant', async (t) => {
  const root = fixtureRoot(t);
  // `a-memo` sorts before `z-doc`: directory order must not matter.
  writePackage(root, 'z-doc', A, [
    def('Doc', { decoratorConfig: { tableStrategy: 'sti', tableName: 'docs' } }),
  ]);
  writePackage(
    root,
    'a-memo',
    B,
    [def('Memo', { extends: 'Doc', extendsQualified: `${A}:Doc` })],
    [A],
  );
  const result = await collect(root);
  assert.deepEqual(result.errors, []);
  const memo = entry(entriesOf(result, B), `${B}:Memo`);
  assert.deepEqual(memo.api.crud, ['create', 'delete', 'get', 'list', 'update']);
  assert.equal(entriesOf(result, B).entries.has(`${A}:Doc`), false);
});

test('simple-name collision keyed by qualified name (support/timesheets pair)', async (t) => {
  const root = fixtureRoot(t);
  writePackage(root, 'alpha', A, [def('Comment')]);
  writePackage(root, 'beta', B, [
    def('Comment', { decoratorConfig: { api: { include: ['list'] } } }),
  ]);
  const result = await collect(root);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(entry(entriesOf(result, A), `${A}:Comment`).api.crud.length, 5);
  assert.deepEqual(entry(entriesOf(result, B), `${B}:Comment`).api.crud, ['list']);
});

test('resolver change with no model edits shows a diff', async (t) => {
  const root = fixtureRoot(t);
  writePackage(root, 'alpha', A, [
    def('Note', { decoratorConfig: { api: { include: ['list'] }, mcp: false } }),
  ]);
  const baseline = await collect(root);
  assert.deepEqual(baseline.errors, []);
  // A core whose resolver opens everything, with the same manifests.
  const patched = path.join(root, 'patched-core.mjs');
  writeFileSync(
    patched,
    [
      `export * from ${JSON.stringify(pathToFileURL(corePath).href)};`,
      `import { ObjectRegistry } from ${JSON.stringify(pathToFileURL(corePath).href)};`,
      'const original = ObjectRegistry.getConfig.bind(ObjectRegistry);',
      'ObjectRegistry.getConfig = (name) => ({ ...original(name), api: true, mcp: true });',
      '',
    ].join('\n'),
  );
  const widened = await collect(root, { corePath: patched });
  assert.deepEqual(widened.errors, []);
  const changes = classifyChanges(baseline.files[A], widened.files[A]);
  assert.ok(
    changes.some((c) => c.class === 'WIDEN' && c.key === `${A}:Note`),
    JSON.stringify(changes),
  );
});

test('runtime-only model never appears', async (t) => {
  const root = fixtureRoot(t);
  writePackage(root, 'alpha', A, [def('Note')]);
  const result = await collect(root);
  assert.deepEqual([...entriesOf(result, A).entries.keys()], [`${A}:Note`]);
});

test('widening via dependency bump surfaces in the dependent’s file', async (t) => {
  const root = fixtureRoot(t);
  writePackage(root, 'alpha', A, [
    def('Base', { decoratorConfig: { api: { include: ['list'] } } }),
  ]);
  writePackage(
    root,
    'beta',
    B,
    [def('Child', { extends: 'Base', extendsQualified: `${A}:Base` })],
    [A],
  );
  const before = await collect(root);
  assert.deepEqual(before.errors, []);
  assert.deepEqual(entry(entriesOf(before, B), `${B}:Child`).api.crud, ['list']);
  // The dependency's next release opens its model; the dependent did not change.
  const file = path.join(root, 'packages/alpha/dist/manifest.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  manifest.objects[`${A}:Base`].decoratorConfig.api = true;
  writeFileSync(file, JSON.stringify(manifest));
  const after = await collect(root);
  const changes = classifyChanges(before.files[B], after.files[B]);
  assert.ok(
    changes.some((c) => c.class === 'WIDEN' && c.key === `${B}:Child`),
    JSON.stringify(changes),
  );
});

function timesheetsPair(root) {
  writePackage(root, 'timesheets', A, [
    def('ServiceTimeEntry', {
      methods: {
        record: method('record'),
        submit: method('submit'),
        approve: method('approve'),
      },
      decoratorConfig: {
        api: { include: ['list', 'get', 'record', 'submit', 'approve'] },
        mcp: { include: ['list', 'get'] },
        cli: { include: ['list', 'get'] },
      },
    }),
  ]);
  writePackage(
    root,
    'support',
    B,
    [
      def('ServiceTimeEntry', {
        extends: 'ServiceTimeEntry',
        extendsQualified: `${A}:ServiceTimeEntry`,
        decoratorConfig: {
          replaceParent: true,
          api: { include: ['list', 'get'] },
          mcp: { include: ['list', 'get'] },
          cli: { include: ['list', 'get'] },
        },
      }),
    ],
    [A],
  );
}

test('timesheets file serves record/submit/approve; support file derives the shadow with list/get', async (t) => {
  const root = fixtureRoot(t);
  timesheetsPair(root);
  const result = await collect(root);
  assert.deepEqual(result.errors, []);
  const ts = entry(entriesOf(result, A), `${A}:ServiceTimeEntry`);
  assert.deepEqual(Object.keys(ts.api.actions).sort(), ['approve', 'record', 'submit']);
  const support = entriesOf(result, B);
  assert.equal(support.entries.has(`${A}:ServiceTimeEntry`), false);
  const shadow = support.shadows.find((s) => s.shadow === `${A}:ServiceTimeEntry`);
  assert.ok(shadow, result.files[B]);
  assert.equal(shadow.owner, `${B}:ServiceTimeEntry`);
  assert.deepEqual(shadow.api.crud, ['get', 'list']);
  assert.equal(shadow.api.actions, undefined);
});

test('real tree: committed timesheets and support files carry the derived shadow', () => {
  const dir = path.join(repo, 'served-surface');
  const timesheets = parseSurfaceFile(
    readFileSync(path.join(dir, surfaceFileName('@happyvertical/smrt-timesheets')), 'utf8'),
  );
  const support = parseSurfaceFile(
    readFileSync(path.join(dir, surfaceFileName('@happyvertical/smrt-support')), 'utf8'),
  );
  // timesheets declares its workflow actions on the collection class.
  const own = timesheets.entries.get(
    '@happyvertical/smrt-timesheets:ServiceTimeEntryCollection',
  );
  for (const action of ['record', 'submit', 'approve'])
    assert.ok(own.api.actions?.[action], action);
  const shadow = support.shadows.find(
    (s) => s.shadow === '@happyvertical/smrt-timesheets:ServiceTimeEntry',
  );
  assert.equal(shadow?.owner, '@happyvertical/smrt-support:ServiceTimeEntry');
  assert.deepEqual(shadow.api.crud, ['get', 'list']);
});

test('expose:false removed WIDEN; non-wireable NARROW; lifecycle no op; collection has no REST CRUD; abstract MCP list/get; public read→true WIDEN; same action POST→GET under public read WIDEN; sensitive model keeps MCP writes while its collection is read-only; collection include gains a custom method → CLI delta', async (t) => {
  const build = (variant) => {
    const root = fixtureRoot(t);
    const v = (a, b) => (variant === 'after' ? b : a);
    writePackage(root, 'alpha', A, [
      def('Ticket', {
        methods: {
          close: method('close', {
            decoratorConfig: v({ expose: false }, {}),
          }),
          archive: method('archive', {
            parameters: v(
              [{ name: 'reason', type: 'string', optional: false }],
              [{ name: 'reason', type: 'any', typeUnresolved: true, optional: false }],
            ),
          }),
          withTransaction: method('withTransaction'),
          peek: method('peek', {
            decoratorConfig: { httpMethod: v('POST', 'GET') },
          }),
        },
        decoratorConfig: {
          api: { public: v('read', true) },
        },
      }),
      def('Draft', { decoratorConfig: { abstract: true } }),
      def('Secret', { decoratorConfig: { sensitive: true } }),
      def('SecretCollection', {
        extends: 'SmrtCollection',
        extendsTypeArg: 'Secret',
        fields: {},
      }),
      def('Widget'),
      def('WidgetCollection', {
        extends: 'SmrtCollection',
        extendsTypeArg: 'Widget',
        fields: {},
        methods: { sweep: method('sweep') },
        decoratorConfig: {
          cli: { include: v(['list'], ['list', 'sweep']) },
        },
      }),
    ]);
    return root;
  };
  const before = await collect(build('before'));
  const after = await collect(build('after'));
  assert.deepEqual(before.errors, []);
  assert.deepEqual(after.errors, []);
  const b = entriesOf(before, A);
  const a = entriesOf(after, A);

  assert.equal(b.entries.get(`${A}:Ticket`).api.actions.close, undefined);
  assert.ok(a.entries.get(`${A}:Ticket`).api.actions.close);
  assert.ok(b.entries.get(`${A}:Ticket`).api.actions.archive);
  assert.equal(a.entries.get(`${A}:Ticket`).api.actions.archive, undefined);
  assert.equal(b.entries.get(`${A}:Ticket`).api.actions.withTransaction, undefined);
  assert.equal(b.entries.get(`${A}:Ticket`).mcp.ops.includes('withTransaction'), false);
  // The CLI still emits a `withTransaction` command (a known per-transport
  // divergence); the snapshot records what each transport emits, so it shows.
  assert.equal(b.entries.get(`${A}:Ticket`).cli.ops.includes('withTransaction'), true);
  assert.deepEqual(b.entries.get(`${A}:Ticket`).api.actions.peek, {
    verb: 'POST',
    scope: 'item',
    route: 'tickets/[id]/peek',
    auth: 'required',
    permission: 'tickets.peek',
  });
  assert.deepEqual(a.entries.get(`${A}:Ticket`).api.actions.peek, {
    verb: 'GET',
    scope: 'item',
    route: 'tickets/[id]/peek',
    auth: 'open',
    permission: false,
  });
  assert.equal(b.entries.get(`${A}:WidgetCollection`).api.crud, undefined);
  assert.deepEqual(b.entries.get(`${A}:Draft`).mcp.ops, ['get', 'list']);
  assert.ok(b.entries.get(`${A}:Secret`).mcp.ops.includes('create'));
  assert.deepEqual(b.entries.get(`${A}:SecretCollection`).mcp.ops, ['get', 'list']);
  assert.deepEqual(b.entries.get(`${A}:WidgetCollection`).cli.ops, ['list']);
  assert.deepEqual(a.entries.get(`${A}:WidgetCollection`).cli.ops, ['list', 'sweep']);

  const changes = classifyChanges(before.files[A], after.files[A]);
  const has = (cls, key, pattern) =>
    changes.some(
      (c) => c.class === cls && c.key === `${A}:${key}` && pattern.test(c.detail),
    );
  assert.ok(has('WIDEN', 'Ticket', /api action close/), JSON.stringify(changes));
  assert.ok(has('NARROW', 'Ticket', /api action archive/), JSON.stringify(changes));
  assert.ok(has('WIDEN', 'Ticket', /public read -> true/), JSON.stringify(changes));
  assert.ok(has('WIDEN', 'Ticket', /api action peek.*POST -> GET/), JSON.stringify(changes));
  assert.ok(has('WIDEN', 'WidgetCollection', /cli \+sweep/), JSON.stringify(changes));
});

test('crossPackageJunction and junctionItemUnresolved listed and flagged', async (t) => {
  const root = fixtureRoot(t);
  writePackage(
    root,
    'alpha',
    A,
    [
      def('Owner'),
      def('OwnerAssets', { extends: 'SmrtJunction', extendsTypeArg: 'Asset', fields: {} }),
      def('Loose', { extends: 'SmrtJunction', extendsTypeArg: 'Ghost', fields: {} }),
    ],
    [],
    (manifest) => {
      const ownerAssets = manifest.objects[`${A}:OwnerAssets`];
      delete ownerAssets.junctionItemUnresolved;
      Object.assign(ownerAssets, {
        junction: true,
        junctionOf: '@served/elsewhere:Asset',
        crossPackageJunction: true,
      });
      Object.assign(manifest.objects[`${A}:Loose`], {
        junction: true,
        junctionItemUnresolved: true,
      });
    },
  );
  const result = await collect(root);
  assert.deepEqual(result.errors, []);
  const parsed = entriesOf(result, A);
  assert.deepEqual(entry(parsed, `${A}:OwnerAssets`).flags, ['crossPackageJunction']);
  assert.deepEqual(entry(parsed, `${A}:Loose`).flags, ['junctionItemUnresolved']);
  assert.ok(parsed.ambiguous.includes(`${A}:Loose`));
});

test('P → Q → R with a replacement in R: P’s file has only P’s keys and correct owners', async (t) => {
  const root = fixtureRoot(t);
  const R = '@served/r';
  const Q = '@served/q';
  const P = '@served/p';
  writePackage(root, 'r', R, [def('Thing')]);
  writePackage(
    root,
    'q',
    Q,
    [
      def('Thing', {
        extends: 'Thing',
        extendsQualified: `${R}:Thing`,
        decoratorConfig: { replaceParent: true, api: { include: ['list'] } },
      }),
    ],
    [R],
  );
  writePackage(root, 'p', P, [def('Widget')], [Q]);
  const result = await collect(root);
  assert.deepEqual(result.errors, []);
  const p = entriesOf(result, P);
  assert.deepEqual([...p.entries.keys()], [`${P}:Widget`]);
  assert.deepEqual(p.shadows, []);
  const q = entriesOf(result, Q);
  assert.equal(q.shadows[0]?.shadow, `${R}:Thing`);
  assert.equal(q.shadows[0]?.owner, `${Q}:Thing`);
});

test('installed STI sibling outside P’s closure is not registered; a forced one fails as out-of-profile', async (t) => {
  const root = fixtureRoot(t);
  writePackage(root, 'alpha', A, [
    def('Doc', { decoratorConfig: { tableStrategy: 'sti', tableName: 'docs' } }),
  ]);
  writePackage(
    root,
    'beta',
    B,
    [def('Memo', { extends: 'Doc', extendsQualified: `${A}:Doc` })],
    [A],
  );
  const clean = await collect(root);
  assert.deepEqual(clean.errors, []);
  assert.deepEqual([...entriesOf(clean, A).entries.keys()], [`${A}:Doc`]);

  const forced = await collect(root, {
    extraManifests: { [A]: [path.join(root, 'packages/beta/dist/manifest.json')] },
  });
  assert.equal(forced.ok, false);
  assert.match(forced.errors.join('\n'), /out-of-profile registration @served\/beta:Memo/);
});

test('unmarked dependency manifest and ambiguous entry are listed', async (t) => {
  const root = fixtureRoot(t);
  writePackage(root, 'alpha', A, [def('Base')]);
  writePackage(
    root,
    'beta',
    B,
    [def('Child', { extends: 'Base', extendsQualified: `${A}:Base` })],
    [A],
  );
  const result = await collect(root);
  assert.deepEqual(entriesOf(result, B).unmarked, [A]);
  assert.deepEqual(entriesOf(result, A).unmarked, []);

  // A marked dependency is not listed.
  const file = path.join(root, 'packages/alpha/dist/manifest.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  manifest.exposureRules = { internalModel: 1 };
  writeFileSync(file, JSON.stringify(manifest));
  const marked = await collect(root);
  assert.deepEqual(entriesOf(marked, B).unmarked, []);
  const changes = classifyChanges(marked.files[B], result.files[B]);
  assert.ok(
    changes.some((c) => c.class === 'WIDEN' && /lost its exposure-rule marker/.test(c.detail)),
    JSON.stringify(changes),
  );
});

function writeRoot(root, dir, packageName, source, exportsMap) {
  const pkgDir = path.join(root, 'packages', dir);
  const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  pkg.exports = exportsMap ?? { '.': { import: './dist/index.js' } };
  writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(pkg));
  writeFileSync(path.join(pkgDir, 'dist/index.js'), source);
}

/** Writes served-surface/loader-parity-known.json. */
function knownList(root, divergences) {
  mkdirSync(path.join(root, 'served-surface'), { recursive: true });
  writeFileSync(
    path.join(root, 'served-surface/loader-parity-known.json'),
    JSON.stringify({ divergences }),
  );
}

/** The divergence difference the check printed (one divergence expected). */
function differenceOf(result) {
  const found = [...result.errors.join('\n').matchAll(/Difference: (\{.*\})$/gm)];
  assert.equal(found.length, 1, result.errors.join('\n'));
  return JSON.parse(found[0][1]);
}

/** A built root that registers Note with `config` (a JS object literal). */
const noteRoot = (config) =>
  [
    `import { smrt, SmrtObject } from ${JSON.stringify(pathToFileURL(corePath).href)};`,
    'export class Note extends SmrtObject { title = ""; }',
    `smrt({ packageName: ${JSON.stringify(A)}, ...${config} })(Note);`,
    '',
  ].join('\n');

test('loader parity: manifest-only and built-root inventories equal; a decorator-only divergence fails', async (t) => {
  const root = fixtureRoot(t);
  const core = JSON.stringify(pathToFileURL(corePath).href);
  writePackage(root, 'alpha', A, [
    def('Note', { decoratorConfig: { api: { include: ['list', 'get'] } } }),
  ]);
  writeRoot(
    root,
    'alpha',
    A,
    [
      `import { smrt, SmrtObject } from ${core};`,
      'export class Note extends SmrtObject { title = ""; }',
      `smrt({ packageName: ${JSON.stringify(A)}, api: { include: ['list', 'get'] } })(Note);`,
      '',
    ].join('\n'),
  );
  knownList(root, {});
  const clean = await collect(root, { loaderParity: true });
  assert.deepEqual(clean.errors, []);

  writeRoot(
    root,
    'alpha',
    A,
    [
      `import { smrt, SmrtObject } from ${core};`,
      'export class Note extends SmrtObject { title = ""; }',
      `smrt({ packageName: ${JSON.stringify(A)}, api: true })(Note);`,
      '',
    ].join('\n'),
  );
  const diverged = await collect(root, { loaderParity: true });
  assert.equal(diverged.ok, false);
  assert.match(diverged.errors.join('\n'), /loader parity.*@served\/alpha:Note/);

  // A reviewed known divergence, pinned to the divergence it reviewed, is
  // accepted ...
  knownList(root, { [`${A}:Note`]: { issue: 1, difference: differenceOf(diverged), cause: 'fixture' } });
  assert.deepEqual((await collect(root, { loaderParity: true })).errors, []);

  // ... and once fixed, its entry must be deleted: the list only shrinks.
  writeRoot(
    root,
    'alpha',
    A,
    [
      `import { smrt, SmrtObject } from ${core};`,
      'export class Note extends SmrtObject { title = ""; }',
      `smrt({ packageName: ${JSON.stringify(A)}, api: { include: ['list', 'get'] } })(Note);`,
      '',
    ].join('\n'),
  );
  const stale = await collect(root, { loaderParity: true });
  assert.equal(stale.ok, false);
  assert.match(stale.errors.join('\n'), /@served\/alpha:Note no longer diverges/);
});

test('a new replaceParent pair appears with no list edit; two dependents shadowing one key are both shown and printed', async (t) => {
  const root = fixtureRoot(t);
  timesheetsPair(root);
  const C = '@served/gamma';
  writePackage(
    root,
    'gamma',
    C,
    [
      def('ServiceTimeEntry', {
        extends: 'ServiceTimeEntry',
        extendsQualified: `${A}:ServiceTimeEntry`,
        decoratorConfig: { replaceParent: true, api: { include: ['list'] } },
      }),
    ],
    [A],
  );
  const result = await collect(root);
  assert.deepEqual(result.errors, []);
  for (const pkg of [B, C])
    assert.equal(
      entriesOf(result, pkg).shadows[0]?.shadow,
      `${A}:ServiceTimeEntry`,
    );
  assert.match(
    result.warnings.join('\n'),
    /@served\/alpha:ServiceTimeEntry is replaced by .*@served\/beta.*@served\/gamma/,
  );
});

/** A core module that re-exports the built core after `patch` (source text). */
function patchedCore(root, patch) {
  const file = path.join(root, 'patched-core.mjs');
  const href = JSON.stringify(pathToFileURL(corePath).href);
  writeFileSync(
    file,
    [`export * from ${href};`, `import * as core from ${href};`, patch, ''].join('\n'),
  );
  return file;
}

test('loader parity: a listed key that diverges any other way fails, and so does an entry no parity run checks', async (t) => {
  const root = fixtureRoot(t);
  writePackage(root, 'alpha', A, [
    def('Note', { decoratorConfig: { api: { include: ['list', 'get'] } } }),
  ]);
  writeRoot(root, 'alpha', A, noteRoot("{ api: { include: ['list', 'get'] }, cli: false }"));
  knownList(root, {});
  const reviewed = await collect(root, { loaderParity: true });
  const difference = differenceOf(reviewed);
  knownList(root, { [`${A}:Note`]: { issue: 1, difference, cause: 'CLI only' } });
  assert.deepEqual((await collect(root, { loaderParity: true })).errors, []);

  // The decorator path now also opens REST writes on the same key.
  writeRoot(root, 'alpha', A, noteRoot('{ api: true, cli: false }'));
  const further = await collect(root, { loaderParity: true });
  assert.equal(further.ok, false);
  assert.match(
    further.errors.join('\n'),
    /@served\/alpha:Note diverges differently from its reviewed entry .*api builtRootOnly \+\[.*crud create.*re-pin it with pnpm check:served-surface --loader-parity --repin/,
  );

  writeRoot(root, 'alpha', A, noteRoot("{ api: { include: ['list', 'get'] }, cli: false }"));
  knownList(root, {
    [`${A}:Note`]: { issue: 1, difference, cause: 'CLI only' },
    [`${A}:Renamed`]: { issue: 1, difference, cause: 'a key that no longer exists' },
  });
  const orphan = await collect(root, { loaderParity: true });
  assert.equal(orphan.ok, false);
  assert.match(orphan.errors.join('\n'), /lists @served\/alpha:Renamed, which no loader-parity run checks/);
});

test('loader parity pins only the difference: an unrelated change to a listed key passes, a moved difference fails naming what moved, --repin rewrites listed ids only', async (t) => {
  const root = fixtureRoot(t);
  const manifestNote = (api) =>
    writePackage(root, 'alpha', A, [def('Note', { decoratorConfig: { api } })]);
  manifestNote({ include: ['list', 'get'] });
  writeRoot(root, 'alpha', A, noteRoot("{ api: { include: ['list', 'get'] }, cli: false }"));
  knownList(root, {});
  const difference = differenceOf(await collect(root, { loaderParity: true }));
  knownList(root, { [`${A}:Note`]: { issue: 1, difference, cause: 'CLI only' } });
  assert.deepEqual((await collect(root, { loaderParity: true })).errors, []);

  // Unrelated: both sides narrow REST alike; the CLI difference is the same.
  manifestNote({ include: ['list'] });
  writeRoot(root, 'alpha', A, noteRoot("{ api: { include: ['list'] }, cli: false }"));
  assert.deepEqual((await collect(root, { loaderParity: true })).errors, []);

  // New difference on the same key: the decorator path also closes MCP.
  writeRoot(root, 'alpha', A, noteRoot("{ api: { include: ['list'] }, cli: false, mcp: false }"));
  const moved = await collect(root, { loaderParity: true });
  assert.equal(moved.ok, false);
  assert.match(
    moved.errors.join('\n'),
    /@served\/alpha:Note diverges differently from its reviewed entry .*mcp manifestOnly \+\[.*op list.*tool note_list -> list.*--repin/,
  );

  // --repin rewrites the listed id's difference, and nothing else.
  const repinned = await collect(root, { loaderParity: true, repin: true });
  assert.deepEqual(repinned.errors, []);
  assert.match(repinned.warnings.join('\n'), /re-pinned in served-surface\/loader-parity-known\.json: @served\/alpha:Note/);
  const file = JSON.parse(
    readFileSync(path.join(root, 'served-surface/loader-parity-known.json'), 'utf8'),
  );
  assert.deepEqual(Object.keys(file.divergences), [`${A}:Note`]);
  assert.equal(file.divergences[`${A}:Note`].cause, 'CLI only');
  assert.ok(file.divergences[`${A}:Note`].difference.mcp);
  assert.deepEqual((await collect(root, { loaderParity: true })).errors, []);

  // --repin never adds an id.
  knownList(root, {});
  const unlisted = await collect(root, { loaderParity: true, repin: true });
  assert.equal(unlisted.ok, false);
  assert.match(unlisted.errors.join('\n'), /@served\/alpha:Note serves .* Fix the divergence/);
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(root, 'served-surface/loader-parity-known.json'), 'utf8')).divergences,
    {},
  );
});

test('loader parity list against the base: an added id fails, a re-pinned id passes as a review item, a missing or unreadable list fails', (t) => {
  const root = fixtureRoot(t);
  const d = (op) => ({ cli: { manifestOnly: [`op ${op}`], builtRootOnly: [] } });
  const at = { text: JSON.stringify({ divergences: { a: { difference: d('list') }, b: { difference: d('get') } } }) };
  const options = {
    root,
    ref: 'base',
    readAtRef: () => at.text,
    refResolves: () => true,
  };
  // Addition: fails.
  knownList(root, { a: { difference: d('list') }, b: { difference: d('get') }, c: { difference: d('create') } });
  assert.match(checkParityKnownAgainst(options).errors.join('\n'), /c is not listed at base/);
  // Re-pin of an existing id: accepted, reported for review.
  knownList(root, { a: { difference: d('delete') } });
  const repin = checkParityKnownAgainst(options);
  assert.deepEqual(repin.errors, []);
  assert.equal(repin.ok, true);
  assert.equal(repin.reviewItems.length, 1);
  assert.match(repin.reviewItems[0], /^a: re-pinned since base: cli manifestOnly \+\[op delete\], cli manifestOnly -\[op list\]/);
  // Unchanged pin: passes with nothing to review.
  knownList(root, { a: { difference: d('list') } });
  assert.deepEqual(checkParityKnownAgainst(options).errors, []);
  assert.deepEqual(checkParityKnownAgainst(options).reviewItems, []);
  // Removing an id passes.
  knownList(root, {});
  assert.deepEqual(checkParityKnownAgainst(options).errors, []);
  // A base without the file (a successful tree lookup) passes.
  at.text = null;
  assert.deepEqual(checkParityKnownAgainst(options).errors, [], 'new at the base');
  assert.equal(checkParityKnownAgainst({ ...options, refResolves: () => false }).ok, false);
  // A failed read of the base file is never a missing file.
  const unreadable = checkParityKnownAgainst({
    ...options,
    readAtRef: () => {
      throw new Error('fatal: bad object');
    },
  });
  assert.equal(unreadable.ok, false);
  assert.match(unreadable.errors.join('\n'), /cannot read served-surface\/loader-parity-known\.json at base/);
  // Deleting the list fails, whatever the base holds.
  at.text = JSON.stringify({ divergences: {} });
  rmSync(path.join(root, 'served-surface/loader-parity-known.json'));
  const deleted = checkParityKnownAgainst(options);
  assert.equal(deleted.ok, false);
  assert.match(deleted.errors.join('\n'), /loader-parity-known\.json is missing/);
});

test('the loader-parity list persists: an empty list passes, a deleted one fails the parity run', async (t) => {
  const root = fixtureRoot(t);
  writePackage(root, 'alpha', A, [
    def('Note', { decoratorConfig: { api: { include: ['list', 'get'] } } }),
  ]);
  writeRoot(root, 'alpha', A, noteRoot("{ api: { include: ['list', 'get'] } }"));
  knownList(root, {});
  assert.deepEqual((await collect(root, { loaderParity: true })).errors, []);
  rmSync(path.join(root, 'served-surface/loader-parity-known.json'));
  const deleted = await collect(root, { loaderParity: true });
  assert.equal(deleted.ok, false);
  assert.match(deleted.errors.join('\n'), /loader-parity-known\.json is missing/);
});

test('loader parity fails when the root import registers a model of a package outside the closure', async (t) => {
  const root = fixtureRoot(t);
  writePackage(root, 'alpha', A, [def('Note')]);
  writePackage(root, 'beta', B, [def('Memo')]);
  const href = JSON.stringify(pathToFileURL(corePath).href);
  writeRoot(
    root,
    'alpha',
    A,
    [
      `import { smrt, SmrtObject } from ${href};`,
      'export class Note extends SmrtObject { title = ""; }',
      `smrt({ packageName: ${JSON.stringify(A)} })(Note);`,
      'class Stray extends SmrtObject { title = ""; }',
      `smrt({ packageName: ${JSON.stringify(B)} })(Stray);`,
      '',
    ].join('\n'),
  );
  knownList(root, {});
  const result = await collect(root, { loaderParity: true, packages: [A] });
  assert.equal(result.ok, false);
  assert.match(
    result.errors.join('\n'),
    /importing @served\/alpha's built root registers @served\/beta:Stray of @served\/beta, outside its smrtDependencies closure/,
  );
});

test('the CRUD permission collection is recorded; changing it with the route fixed changes the file', async (t) => {
  const build = (permissionCollection) => {
    const root = fixtureRoot(t);
    writePackage(root, 'alpha', A, [def('Case')], [], (manifest) => {
      if (permissionCollection)
        manifest.objects[`${A}:Case`].permissionCollection = permissionCollection;
    });
    return root;
  };
  const plain = await collect(build(undefined));
  assert.deepEqual(plain.errors, []);
  const api = entry(entriesOf(plain, A), `${A}:Case`).api;
  assert.equal(api.path, 'cases');
  assert.equal(api.crudPermission, 'cases');
  const hosted = await collect(build('records'));
  assert.deepEqual(hosted.errors, []);
  assert.equal(entry(entriesOf(hosted, A), `${A}:Case`).api.crudPermission, 'records');
  const changes = classifyChanges(plain.files[A], hosted.files[A]).map(
    (c) => `${c.class} ${c.key}: ${c.detail}`,
  );
  assert.ok(
    changes.includes(`WIDEN ${A}:Case: api crud permission cases -> records`),
    changes.join('\n'),
  );
});

test('tools and commands are recorded as address -> operation pairs; a reassignment changes the file', async (t) => {
  const root = fixtureRoot(t);
  writePackage(root, 'alpha', A, [def('Note')]);
  const result = await collect(root);
  assert.deepEqual(result.errors, []);
  const note = entry(entriesOf(result, A), `${A}:Note`);
  assert.equal(note.mcp.tools.note_get, 'get');
  assert.equal(note.cli.commands['note:list'], 'list');
  assert.equal(note.cli.commands['note:delete'], 'delete');
  const line = (commands) =>
    JSON.stringify({ key: 'k', kind: 'model', api: false, mcp: false, cli: { commands, ops: ['delete', 'list'] } });
  const changes = classifyChanges(
    line({ 'w:list': 'list', 'w:ls': 'list', 'w:delete': 'delete', 'w:rm': 'delete' }),
    line({ 'w:list': 'list', 'w:ls': 'delete', 'w:delete': 'delete', 'w:rm': 'list' }),
  ).map((c) => `${c.class} ${c.key}: ${c.detail}`);
  assert.ok(changes.includes('CHANGED k: cli command w:ls now runs delete (was list)'), changes.join('\n'));
  assert.ok(changes.includes('CHANGED k: cli command w:rm now runs list (was delete)'), changes.join('\n'));
});

test('two packages whose names differ only in scope cannot share one snapshot file', async (t) => {
  const root = fixtureRoot(t);
  writePackage(root, 'one', '@one/same', [def('Note')]);
  writePackage(root, 'two', '@two/same', [def('Memo')]);
  const result = await runServedSurface({ root, corePath, cliPath, write: true });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /served-surface\/same\.txt would hold both @one\/same and @two\/same/);
  assert.equal(existsSync(path.join(root, 'served-surface/same.txt')), false);
});

test('an incomplete closure fails: a dependency with no manifest, a key with no registration', async (t) => {
  const root = fixtureRoot(t);
  writePackage(root, 'alpha', A, [def('Note')]);
  writePackage(root, 'beta', B, [def('Memo')], [A, '@served/ghost']);
  const missing = await collect(root);
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join('\n'), /@served\/beta: smrtDependency @served\/ghost has no built manifest/);

  const root2 = fixtureRoot(t);
  writePackage(root2, 'alpha', A, [def('Note', { decoratorConfig: { api: false } })]);
  const unresolved = await collect(root2, {
    corePath: patchedCore(
      root2,
      [
        'const getClass = core.ObjectRegistry.getClass.bind(core.ObjectRegistry);',
        `core.ObjectRegistry.getClass = (name) => (name === '${A}:Note' ? undefined : getClass(name));`,
      ].join('\n'),
    ),
  });
  assert.equal(unresolved.ok, false);
  assert.match(unresolved.errors.join('\n'), /@served\/alpha:Note has no registration/);
});

test('a collection over an abstract item serves no REST action; the concrete item makes it served', async (t) => {
  const build = (abstract) => {
    const root = fixtureRoot(t);
    writePackage(root, 'alpha', A, [
      def('Shape', { decoratorConfig: abstract ? { abstract: true } : {} }),
      def('ShapeCollection', {
        extends: 'SmrtCollection',
        extendsTypeArg: 'Shape',
        fields: {},
        methods: { recount: method('recount') },
      }),
    ]);
    return root;
  };
  const abstract = await collect(build(true));
  assert.deepEqual(abstract.errors, []);
  assert.equal(entry(entriesOf(abstract, A), `${A}:ShapeCollection`).api, false);
  const concrete = await collect(build(false));
  assert.deepEqual(concrete.errors, []);
  const action = entry(entriesOf(concrete, A), `${A}:ShapeCollection`).api.actions.recount;
  // The collection takes its item's REST collection at generation.
  assert.equal(action.route, 'shapes/recount');
  assert.equal(action.permission, 'shapes.recount', 'the item collection names the permission');
  const changes = classifyChanges(abstract.files[A], concrete.files[A]);
  assert.ok(
    changes.some((c) => c.class === 'WIDEN' && /recount added/.test(c.detail)),
    JSON.stringify(changes),
  );
});

test('the permission slug, the route path and an emitted MCP name are recorded: an alias, a path override and a collision rename each change the file', async (t) => {
  const build = (variant) => {
    const root = fixtureRoot(t);
    writePackage(root, 'alpha', A, [
      def('Thing'),
      ...(variant === 'collision' ? [def('Ticket', { decoratorConfig: { mcp: { include: ['list'] } } })] : []),
    ]);
    writePackage(
      root,
      'beta',
      B,
      [
        def('Ticket', {
          methods: { close: method('close') },
          decoratorConfig: {
            ...(variant === 'alias' ? { operationPermissions: { close: { action: 'update' } } } : {}),
            api: variant === 'path' ? { routes: { close: { path: 'shut' } } } : {},
          },
        }),
      ],
      [A],
    );
    return root;
  };
  const base = await collect(build('base'));
  assert.deepEqual(base.errors, []);
  const close = entry(entriesOf(base, B), `${B}:Ticket`).api.actions.close;
  assert.equal(close.permission, 'tickets.close');
  assert.equal(close.route, 'tickets/[id]/close');
  for (const [variant, pattern] of [
    ['alias', /WIDEN .*permission tickets\.close -> tickets\.update/],
    ['path', /CHANGED .*route tickets\/\[id\]\/close -> tickets\/\[id\]\/shut/],
    ['collision', /CHANGED .*mcp tool name/],
  ]) {
    const result = await collect(build(variant));
    assert.deepEqual(result.errors, [], variant);
    const changes = classifyChanges(base.files[B], result.files[B]).map(
      (c) => `${c.class} ${c.key}: ${c.detail}`,
    );
    assert.ok(changes.some((line) => pattern.test(line)), `${variant}: ${changes.join('\n')}`);
  }
});

test('loader parity imports the root the way a consumer resolves it', async (t) => {
  const root = fixtureRoot(t);
  writePackage(root, 'alpha', A, [
    def('Note', { decoratorConfig: { api: { include: ['list', 'get'] } } }),
  ]);
  // No condition Node uses: no entry resolves, which is an error.
  writeRoot(root, 'alpha', A, noteRoot("{ api: { include: ['list', 'get'] } }"), {
    '.': { browser: './dist/index.js' },
  });
  const none = await collect(root, { loaderParity: true });
  assert.equal(none.ok, false);
  assert.match(none.errors.join('\n'), /loader parity: @served\/alpha: no entry of @served\/alpha resolves/);

  // Node takes the first matching condition in key order: `default` here.
  writeRoot(root, 'alpha', A, noteRoot('{ api: true }'), {
    '.': { default: './dist/index.js', node: './dist/node.js' },
  });
  writeFileSync(
    path.join(root, 'packages/alpha/dist/node.js'),
    noteRoot("{ api: { include: ['list', 'get'] } }"),
  );
  const ordered = await collect(root, { loaderParity: true });
  assert.equal(ordered.ok, false);
  assert.match(ordered.errors.join('\n'), /loader parity: @served\/alpha:Note serves/);
});

test('loader parity compares keys the root import adds and dependency keys, owner included', async (t) => {
  const root = fixtureRoot(t);
  writePackage(root, 'alpha', A, [def('Thing', { decoratorConfig: { api: { include: ['list'] } } })]);
  writePackage(root, 'beta', B, [def('Memo')], [A]);
  const href = JSON.stringify(pathToFileURL(corePath).href);
  writeRoot(
    root,
    'beta',
    B,
    [
      `import { smrt, SmrtObject } from ${href};`,
      'export class Memo extends SmrtObject { title = ""; }',
      `smrt({ packageName: ${JSON.stringify(B)} })(Memo);`,
      'export class Extra extends SmrtObject { title = ""; }',
      `smrt({ packageName: ${JSON.stringify(B)} })(Extra);`,
      'class Thing extends SmrtObject { title = ""; }',
      `smrt({ packageName: ${JSON.stringify(A)}, api: true })(Thing);`,
      '',
    ].join('\n'),
  );
  const result = await collect(root, { loaderParity: true, packages: [B] });
  const text = result.errors.join('\n');
  assert.match(text, /loader parity: @served\/beta:Extra serves null from the manifest/);
  assert.match(text, /loader parity: @served\/alpha:Thing \(under @served\/beta\) serves/);
});

test('a surface the collector cannot attribute fails: an MCP tool without identity, a CLI command without owner, a throwing resolver', async (t) => {
  const root = fixtureRoot(t);
  writePackage(root, 'alpha', A, [def('Note')]);
  const tool = await collect(root, {
    corePath: patchedCore(
      root,
      [
        'const identity = core.MCPGenerator.prototype.getToolIdentity;',
        "core.MCPGenerator.prototype.getToolIdentity = function (tool) { if (tool.name === 'note_get') throw new Error('target lost'); return identity.call(this, tool); };",
      ].join('\n'),
    ),
  });
  assert.equal(tool.ok, false);
  assert.match(tool.errors.join('\n'), /MCP tool note_get has no model identity: target lost/);

  const cliFile = path.join(root, 'patched-cli.mjs');
  writeFileSync(
    cliFile,
    [
      `import { CLIGenerator as Base } from ${JSON.stringify(pathToFileURL(cliPath).href)};`,
      'export class CLIGenerator extends Base {',
      '  async listCommands() {',
      "    return (await super.listCommands()).map((c) => (c.name === 'note:list' ? { ...c, runtimeModel: undefined } : c));",
      '  }',
      '}',
      '',
    ].join('\n'),
  );
  const command = await collect(root, { cliPath: cliFile });
  assert.equal(command.ok, false);
  assert.match(command.errors.join('\n'), /CLI command note:list cannot be attributed/);

  writePackage(root, 'alpha', A, [def('Note', { methods: { close: method('close') } })]);
  const thrown = await collect(root, {
    corePath: patchedCore(
      root,
      "export const resolveOperationPermissionAlias = () => { throw new Error('alias table unreadable'); };",
    ),
  });
  assert.equal(thrown.ok, false);
  assert.match(thrown.errors.join('\n'), /inventory failed: .*alias table unreadable/);
});

test('a tool or command attributed to an owner no inventoried registration is fails', async (t) => {
  const root = fixtureRoot(t);
  writePackage(root, 'alpha', A, [def('Note')]);
  const tool = await collect(root, {
    corePath: patchedCore(
      root,
      [
        'const identity = core.MCPGenerator.prototype.getToolIdentity;',
        `core.MCPGenerator.prototype.getToolIdentity = function (tool) { const found = identity.call(this, tool); return tool.name === 'note_get' ? { ...found, qualifiedName: ${JSON.stringify(`${A}:Ghost`)} } : found; };`,
      ].join('\n'),
    ),
  });
  assert.equal(tool.ok, false);
  assert.match(tool.errors.join('\n'), /MCP tools note_get are attributed to @served\/alpha:Ghost, which no inventoried registration owns/);

  const cliFile = path.join(root, 'patched-cli-stale.mjs');
  writeFileSync(
    cliFile,
    [
      `import { CLIGenerator as Base } from ${JSON.stringify(pathToFileURL(cliPath).href)};`,
      'export class CLIGenerator extends Base {',
      '  async listCommands() {',
      `    return (await super.listCommands()).map((c) => (c.name === 'note:list' ? { ...c, runtimeModel: { ...c.runtimeModel, qualifiedName: ${JSON.stringify(`${A}:Ghost`)} } } : c));`,
      '  }',
      '}',
      '',
    ].join('\n'),
  );
  const command = await collect(root, { cliPath: cliFile });
  assert.equal(command.ok, false);
  assert.match(command.errors.join('\n'), /CLI commands note:list.* are attributed to @served\/alpha:Ghost, which no inventoried registration owns/);
});

test('a prefix taken by a class that serves no CLI command still masks the later class of that name', async (t) => {
  const root = fixtureRoot(t);
  writePackage(root, 'alpha', A, [def('Account', { decoratorConfig: { cli: false } })]);
  writePackage(root, 'beta', B, [def('Account', { decoratorConfig: { cli: { include: ['list'] } } })], [A]);
  const result = await collect(root);
  assert.deepEqual(result.errors, []);
  const parsed = entriesOf(result, B);
  assert.equal(entry(parsed, `${B}:Account`).cli, false);
  assert.deepEqual(parsed.masked, [
    { masked: `${B}:Account`, surface: 'cli', by: `${A}:Account` },
  ]);
});

test('two closure classes with one simple name: the one whose CLI commands the other serves is marked masked', async (t) => {
  const root = fixtureRoot(t);
  writePackage(root, 'alpha', A, [def('Account')]);
  writePackage(root, 'beta', B, [def('Account', { decoratorConfig: { cli: { include: ['list'] } } })], [A]);
  const result = await collect(root);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(entriesOf(result, B).masked, [
    { masked: `${B}:Account`, surface: 'cli', by: `${A}:Account` },
  ]);
  assert.deepEqual(entriesOf(result, A).masked, []);
});

test('a collection-shaped entry whose ancestry is unresolved is flagged and listed ambiguous', async (t) => {
  const root = fixtureRoot(t);
  writePackage(root, 'alpha', A, [
    def('Tag'),
    def('MysteryLinks', { extends: 'SomeUnknownBase', extendsTypeArg: 'Tag', fields: {} }),
  ]);
  const result = await collect(root);
  assert.deepEqual(result.errors, []);
  const parsed = entriesOf(result, A);
  assert.deepEqual(entry(parsed, `${A}:MysteryLinks`).flags, ['junctionAncestryUnresolved']);
  assert.deepEqual(parsed.ambiguous, [`${A}:MysteryLinks`]);
});

test('WIDEN/NARROW/NEW/GONE; equal → exit 0', async (t) => {
  const root = fixtureRoot(t);
  writePackage(root, 'alpha', A, [
    def('Note', { decoratorConfig: { api: { include: ['list', 'get'] } } }),
    def('Gone'),
  ]);
  const wrote = await runServedSurface({ root, corePath, cliPath, write: true });
  assert.deepEqual(wrote.errors, []);
  const file = path.join(root, 'served-surface', surfaceFileName(A));
  assert.ok(existsSync(file));
  const clean = await runServedSurface({ root, corePath, cliPath });
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.changes, []);

  writePackage(root, 'alpha', A, [
    def('Note', { decoratorConfig: { api: { include: ['list'] }, mcp: { include: ['list', 'get', 'create'] } } }),
    def('Fresh'),
  ]);
  const before = readFileSync(file, 'utf8');
  const changed = await runServedSurface({ root, corePath, cliPath });
  assert.equal(changed.ok, false);
  const classes = new Set(changed.changes.map((c) => `${c.class} ${c.key}`));
  assert.ok(classes.has(`NARROW ${A}:Note`), JSON.stringify(changed.changes));
  assert.ok(classes.has(`NEW ${A}:Fresh`));
  assert.ok(classes.has(`GONE ${A}:Gone`));
  assert.match(changed.errors.join('\n'), /pnpm surface:served/);
  assert.equal(readFileSync(file, 'utf8'), before, 'check never writes');
});
