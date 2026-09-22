import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'verify-manifest-exports.mjs',
);

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Builds a minimal fixture package on disk: a package.json with an
 * `exports` map (root "." plus a "./server" subpath) and a dist tree whose
 * modules export the given names, so the guard can be exercised against a
 * real dynamic import instead of a mock.
 */
function createPackageFixture({ rootExports = [], serverExports = [] }) {
  const packageDir = mkdtempSync(
    join(tmpdir(), 'smrt-verify-manifest-exports-'),
  );

  writeJson(join(packageDir, 'package.json'), {
    name: '@happyvertical/smrt-fixture',
    exports: {
      '.': { import: './dist/index.js' },
      './server': { import: './dist/server.js' },
    },
  });

  mkdirSync(join(packageDir, 'dist'), { recursive: true });
  writeFileSync(
    join(packageDir, 'dist/index.js'),
    rootExports.map((name) => `export class ${name} {}`).join('\n'),
  );
  writeFileSync(
    join(packageDir, 'dist/server.js'),
    serverExports.map((name) => `export class ${name} {}`).join('\n'),
  );

  return packageDir;
}

function writeManifest(packageDir, objects, manifestRelativePath = 'dist/manifest.json') {
  writeJson(join(packageDir, manifestRelativePath), {
    version: '1.0.0',
    objects,
  });
}

function runGuard(packageDir) {
  return spawnSync(process.execPath, [scriptPath, packageDir], {
    encoding: 'utf8',
  });
}

test('verify-manifest-exports (smrt#2845): passes when every manifest object resolves through its importPath', () => {
  const packageDir = createPackageFixture({
    rootExports: ['RootThing'],
    serverExports: ['DataSurfaceActionIdempotencyState'],
  });
  writeManifest(packageDir, {
    rootThing: {
      className: 'RootThing',
      exportName: 'RootThing',
      filePath: 'src/root-thing.ts',
    },
    dataSurfaceActionIdempotencyState: {
      className: 'DataSurfaceActionIdempotencyState',
      exportName: 'DataSurfaceActionIdempotencyState',
      importPath: '@happyvertical/smrt-fixture/server',
      filePath: 'src/server/sql-data-surface-action-state.ts',
    },
  });

  const result = runGuard(packageDir);
  assert.equal(result.status, 0);
});

test('verify-manifest-exports (smrt#2845): fails when the manifest advertises an object the built module does not export', () => {
  const packageDir = createPackageFixture({
    rootExports: ['RootThing'],
    serverExports: [], // DataSurfaceActionIdempotencyState dropped from dist/server.js
  });
  writeManifest(packageDir, {
    dataSurfaceActionIdempotencyState: {
      className: 'DataSurfaceActionIdempotencyState',
      exportName: 'DataSurfaceActionIdempotencyState',
      importPath: '@happyvertical/smrt-fixture/server',
      filePath: 'src/server/sql-data-surface-action-state.ts',
    },
  });

  const result = runGuard(packageDir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DataSurfaceActionIdempotencyState/);
  assert.match(result.stderr, /does not export it/);
});

test('verify-manifest-exports (smrt#2845): warns (does not fail) when the environment cannot load a file type, e.g. a package whose entry re-exports Svelte components', () => {
  // Mirrors @happyvertical/smrt-products: dist/lib/index.js statically
  // imports a .svelte file (transitively, via @happyvertical/smrt-ui),
  // which plain Node import() cannot parse — a bundler/environment
  // limitation, not evidence the manifest is wrong.
  const packageDir = createPackageFixture({
    rootExports: ['RootThing'],
    serverExports: ['DataSurfaceActionIdempotencyState'],
  });
  writeFileSync(
    join(packageDir, 'dist/index.js'),
    "import './Trans.svelte';\nexport class RootThing {}\n",
  );
  writeFileSync(join(packageDir, 'dist/Trans.svelte'), '<div></div>');
  writeManifest(packageDir, {
    rootThing: {
      className: 'RootThing',
      exportName: 'RootThing',
      filePath: 'src/root-thing.ts',
    },
  });

  const result = runGuard(packageDir);
  assert.equal(result.status, 0);
  assert.match(result.stderr, /could not be verified in this environment/);
  assert.match(result.stderr, /ERR_UNKNOWN_FILE_EXTENSION/);
});

test('verify-manifest-exports (smrt#2924): fails (does not warn) when a non-root importPath cannot be loaded under plain Node', () => {
  // The root barrel may legitimately be bundler-only (the test above), but a
  // dedicated "./server" subpath is the specifier the consumer plugin emits
  // verbatim into a generated .smrt/register.js that the smrt CLI loads with
  // a bare import() for db:migrate. Mirrors
  // @happyvertical/smrt-agents@0.51.6, whose ./server entry reached a .svelte
  // component barrel through @happyvertical/smrt-ui/data.
  const packageDir = createPackageFixture({
    rootExports: ['RootThing'],
    serverExports: ['DataSurfaceActionIdempotencyState'],
  });
  writeFileSync(
    join(packageDir, 'dist/server.js'),
    "import './CollectionList.svelte';\nexport class DataSurfaceActionIdempotencyState {}\n",
  );
  writeFileSync(join(packageDir, 'dist/CollectionList.svelte'), '<div></div>');
  writeManifest(packageDir, {
    idempotencyState: {
      className: 'DataSurfaceActionIdempotencyState',
      exportName: 'DataSurfaceActionIdempotencyState',
      importPath: '@happyvertical/smrt-fixture/server',
      filePath: 'src/server/sql-data-surface-action-state.ts',
    },
  });

  const result = runGuard(packageDir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /is not loadable under plain Node/);
  assert.match(result.stderr, /ERR_UNKNOWN_FILE_EXTENSION/);
  assert.match(result.stderr, /Fix \(bundler-only subpath\)/);
  assert.doesNotMatch(
    result.stderr,
    /could not be verified in this environment/,
  );
});

test('verify-manifest-exports (smrt#2924): still checks plain-Node loadability for a FULLY-CLOSED object behind a non-root importPath', () => {
  // Regression for the exact shape of the three real #2924 objects, which the
  // first cut of this guard silently skipped: `SmrtDataSurfaceActionTask`,
  // `DataSurfaceActionTokenState`, and `DataSurfaceActionIdempotencyState` all
  // declare `api: false, cli: false, mcp: false`, so `isFullyClosedSurface`
  // classifies them as excluded. Export-NAME verification is rightly skipped
  // for them (no producer signal distinguishes an intentional non-export), but
  // loadability is an independent question: the consumer plugin still emits
  // their `./server` importPath into `.smrt/register.js`, which the CLI still
  // loads under plain Node. Excluding them from the load attempt let a broken
  // `@happyvertical/smrt-agents/server` pass the guard with exit 0.
  const packageDir = createPackageFixture({
    rootExports: ['RootThing'],
    serverExports: ['DataSurfaceActionIdempotencyState'],
  });
  writeFileSync(
    join(packageDir, 'dist/server.js'),
    "import './CollectionList.svelte';\nexport class DataSurfaceActionIdempotencyState {}\n",
  );
  writeFileSync(join(packageDir, 'dist/CollectionList.svelte'), '<div></div>');
  writeManifest(packageDir, {
    idempotencyState: {
      className: 'DataSurfaceActionIdempotencyState',
      exportName: 'DataSurfaceActionIdempotencyState',
      importPath: '@happyvertical/smrt-fixture/server',
      filePath: 'src/server/sql-data-surface-action-state.ts',
      // The real decorator config, verbatim from
      // packages/agents/dist/manifest.json.
      decoratorConfig: {
        tableName: '_smrt_data_surface_action_idempotency',
        api: false,
        cli: false,
        mcp: false,
      },
    },
  });

  const result = runGuard(packageDir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /is not loadable under plain Node/);
  assert.match(result.stderr, /ERR_UNKNOWN_FILE_EXTENSION/);
  assert.match(result.stderr, /Fix \(bundler-only subpath\)/);
});

test('verify-manifest-exports (smrt#2924 F1): a FULLY-CLOSED object behind a non-root importPath fails on a NON-environment load error too', () => {
  // The unparseable-file-type case is only one way a server entry stops being
  // loadable. `ERR_MODULE_NOT_FOUND` (a mistyped or removed dependency
  // specifier), a missing named export, and any other import-time failure
  // break a consumer's `.smrt/register.js` under plain Node exactly the same
  // way — and every real #2924 object is fully closed, so restricting the
  // non-root check to ENVIRONMENT_LOAD_ERROR_CODES left that whole class
  // silently passing the guard.
  const packageDir = createPackageFixture({
    rootExports: ['RootThing'],
    serverExports: ['DataSurfaceActionIdempotencyState'],
  });
  writeFileSync(
    join(packageDir, 'dist/server.js'),
    "import './does-not-exist.js';\nexport class DataSurfaceActionIdempotencyState {}\n",
  );
  writeManifest(packageDir, {
    idempotencyState: {
      className: 'DataSurfaceActionIdempotencyState',
      exportName: 'DataSurfaceActionIdempotencyState',
      importPath: '@happyvertical/smrt-fixture/server',
      filePath: 'src/server/sql-data-surface-action-state.ts',
      decoratorConfig: { api: false, cli: false, mcp: false },
    },
  });

  const result = runGuard(packageDir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /failed to load/);
  assert.match(result.stderr, /Fix \(load error\)/);
});

test('verify-manifest-exports (smrt#2924 F1): a FULLY-CLOSED object whose non-root importPath matches no exports entry still fails', () => {
  // Same reachability, one step earlier: Node answers
  // ERR_PACKAGE_PATH_NOT_EXPORTED for a subpath the package does not export,
  // so the generated register.js cannot load it. An excluded object has no
  // export name to verify, but the entry it names must still resolve.
  const packageDir = createPackageFixture({
    rootExports: ['RootThing'],
    serverExports: ['DataSurfaceActionIdempotencyState'],
  });
  writeManifest(packageDir, {
    idempotencyState: {
      className: 'DataSurfaceActionIdempotencyState',
      exportName: 'DataSurfaceActionIdempotencyState',
      importPath: '@happyvertical/smrt-fixture/not-a-real-subpath',
      filePath: 'src/server/sql-data-surface-action-state.ts',
      decoratorConfig: { api: false, cli: false, mcp: false },
    },
  });

  const result = runGuard(packageDir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match any package.json "exports" entry/);
});

test('verify-manifest-exports (smrt#2924 F1): a fully-closed object at the ROOT importPath keeps its pre-existing tolerance', () => {
  // The exclusion must survive for the ROOT barrel, which is legitimately
  // bundler-only (the documented smrt-products case). A fully-closed root
  // object whose entry fails to load is still not release-blocking.
  const packageDir = createPackageFixture({
    rootExports: ['RootThing'],
    serverExports: ['Unused'],
  });
  writeFileSync(
    join(packageDir, 'dist/index.js'),
    "import './does-not-exist.js';\nexport class RootThing {}\n",
  );
  writeManifest(packageDir, {
    rootThing: {
      className: 'RootThing',
      exportName: 'RootThing',
      filePath: 'src/root-thing.ts',
      decoratorConfig: { api: false, cli: false, mcp: false },
    },
  });

  const result = runGuard(packageDir);
  assert.equal(result.status, 0);
});

test('verify-manifest-exports (smrt#2924): a fully-closed object behind a LOADABLE non-root importPath still skips export-name verification', () => {
  // The other half of the contract: moving the load attempt ahead of the
  // exclusion must not start enforcing export names on excluded objects. This
  // fixture's ./server module loads cleanly but deliberately does NOT export
  // the advertised class, and that must still pass.
  const packageDir = createPackageFixture({
    rootExports: ['RootThing'],
    serverExports: ['SomethingElse'],
  });
  writeManifest(packageDir, {
    idempotencyState: {
      className: 'DataSurfaceActionIdempotencyState',
      exportName: 'DataSurfaceActionIdempotencyState',
      importPath: '@happyvertical/smrt-fixture/server',
      filePath: 'src/server/sql-data-surface-action-state.ts',
      decoratorConfig: { api: false, cli: false, mcp: false },
    },
  });

  const result = runGuard(packageDir);
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stderr, /does not export it/);
});

test('verify-manifest-exports (smrt#2845): does not verify a SmrtCollection companion class deliberately withheld from the public export surface', () => {
  // Mirrors @happyvertical/smrt-chat: AgentSessionCollection et al. are
  // auto-derived manifest objects (extends: "SmrtCollection") but are
  // intentionally NOT exported (issue #1392 / "S5") — exposing them would
  // let a consumer bypass the authorized ChatService facade. No manifest
  // producer marks that distinction, so the guard must not flag it.
  const packageDir = createPackageFixture({
    rootExports: ['RootThing'], // AgentSessionCollection deliberately absent
  });
  writeManifest(packageDir, {
    rootThing: {
      className: 'RootThing',
      exportName: 'RootThing',
      filePath: 'src/root-thing.ts',
    },
    agentSessionCollection: {
      className: 'AgentSessionCollection',
      exportName: 'AgentSessionCollection',
      extends: 'SmrtCollection',
      extendsTypeArg: 'AgentSession',
      filePath: 'src/collections/AgentSessionCollection.ts',
    },
  });

  const result = runGuard(packageDir);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /1 not checked: collection companion/);
});

test('verify-manifest-exports (smrt#2845): does not verify an object whose @smrt() config closes every interactive surface (api/cli/mcp)', () => {
  // Mirrors @happyvertical/smrt-fields: FieldUsageReportReceipt sets
  // api: { include: [] }, cli: false, mcp: { include: [] } — a real,
  // database-backed SmrtObject that is genuinely never re-exported from
  // src/index.ts. No producer marks this "backend-only" intent with
  // visibility: 'internal', so the manifest still carries it as public.
  const packageDir = createPackageFixture({
    rootExports: ['RootThing'], // FieldUsageReportReceipt deliberately absent
  });
  writeManifest(packageDir, {
    rootThing: {
      className: 'RootThing',
      exportName: 'RootThing',
      filePath: 'src/root-thing.ts',
    },
    fieldUsageReportReceipt: {
      className: 'FieldUsageReportReceipt',
      exportName: 'FieldUsageReportReceipt',
      decoratorConfig: {
        api: { include: [] },
        cli: false,
        mcp: { include: [] },
      },
      filePath: 'src/models/FieldUsageReportReceipt.ts',
    },
  });

  const result = runGuard(packageDir);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /1 not checked: collection companion/);
});

test('verify-manifest-exports (smrt#2845): still verifies an object whose @smrt() config only partially closes its surface', () => {
  // A single closed surface (e.g. cli: false alone) is not the strong
  // "backend-only, no consumer touches this" signal the fully-closed
  // pattern is — it must not become a blanket escape hatch. This object's
  // api/mcp remain open, so it should still be checked and fail here.
  const packageDir = createPackageFixture({
    rootExports: [], // Thing is genuinely missing
  });
  writeManifest(packageDir, {
    thing: {
      className: 'Thing',
      exportName: 'Thing',
      decoratorConfig: { cli: false },
      filePath: 'src/thing.ts',
    },
  });

  const result = runGuard(packageDir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not export it/);
});

test('verify-manifest-exports (smrt#2845): reports a load error distinctly from an export mismatch', () => {
  const packageDir = createPackageFixture({
    rootExports: ['RootThing'],
    serverExports: ['DataSurfaceActionIdempotencyState'],
  });
  // Overwrite dist/server.js with a module that throws on import, simulating
  // an import-time side effect or a missing native dependency — a failure
  // unrelated to whether importPath itself is correct.
  writeFileSync(
    join(packageDir, 'dist/server.js'),
    "throw new Error('boom: native dependency missing');\n",
  );
  writeManifest(packageDir, {
    dataSurfaceActionIdempotencyState: {
      className: 'DataSurfaceActionIdempotencyState',
      exportName: 'DataSurfaceActionIdempotencyState',
      importPath: '@happyvertical/smrt-fixture/server',
      filePath: 'src/server/sql-data-surface-action-state.ts',
    },
  });

  const result = runGuard(packageDir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /failed to load/);
  assert.match(result.stderr, /boom: native dependency missing/);
  assert.match(result.stderr, /Fix \(load error\)/);
  assert.doesNotMatch(result.stderr, /Fix \(mismatch\)/);
});

test('verify-manifest-exports (smrt#2845): fails when importPath does not match any exports entry', () => {
  const packageDir = createPackageFixture({ rootExports: ['RootThing'] });
  writeManifest(packageDir, {
    wanderer: {
      className: 'Wanderer',
      exportName: 'Wanderer',
      importPath: '@happyvertical/smrt-fixture/nonexistent',
      filePath: 'src/nonexistent/wanderer.ts',
    },
  });

  const result = runGuard(packageDir);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /does not match any package\.json "exports" entry/,
  );
});

test('verify-manifest-exports (smrt#2845): resolves the manifest through the package\'s own "./manifest" export, not a hardcoded dist/manifest.json', () => {
  // Mirrors @happyvertical/smrt-products, whose published manifest is
  // dist/lib/manifest.json (a non-default layout). Before this fix the
  // guard hardcoded dist/manifest.json and would silently skip() such a
  // package, leaving it unchecked.
  const packageDir = mkdtempSync(
    join(tmpdir(), 'smrt-verify-manifest-exports-altpath-'),
  );
  writeJson(join(packageDir, 'package.json'), {
    name: '@happyvertical/smrt-fixture',
    exports: {
      '.': { import: './dist/lib/index.js' },
      './manifest': './dist/lib/manifest.json',
    },
  });
  mkdirSync(join(packageDir, 'dist/lib'), { recursive: true });
  writeFileSync(join(packageDir, 'dist/lib/index.js'), '');
  writeManifest(
    packageDir,
    {
      missing: {
        className: 'Missing',
        exportName: 'Missing',
        filePath: 'src/lib/missing.ts',
      },
    },
    'dist/lib/manifest.json',
  );

  const result = runGuard(packageDir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing/);
  assert.match(result.stderr, /does not export it/);
});

test('verify-manifest-exports (smrt#2845): prefers "./manifest.json" over "./manifest" when a package overloads "./manifest" for something else', () => {
  // Mirrors @happyvertical/smrt-core: "./manifest" points at a JS module
  // (manifest *utilities*, e.g. ManifestGenerator) rather than the manifest
  // *data*, while "./manifest.json" still points at the real
  // dist/manifest.json. Before this fix the guard picked "./manifest" first
  // and crashed trying to JSON.parse a JS file.
  const packageDir = createPackageFixture({
    rootExports: ['RootThing'],
    serverExports: ['DataSurfaceActionIdempotencyState'],
  });
  writeFileSync(
    join(packageDir, 'package.json'),
    `${JSON.stringify(
      {
        name: '@happyvertical/smrt-fixture',
        exports: {
          '.': { import: './dist/index.js' },
          './server': { import: './dist/server.js' },
          './manifest': { import: './dist/manifest-utils.js' },
          './manifest.json': './dist/manifest.json',
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(packageDir, 'dist/manifest-utils.js'),
    'export class ManifestGenerator {}\n',
  );
  writeManifest(packageDir, {
    rootThing: {
      className: 'RootThing',
      exportName: 'RootThing',
      filePath: 'src/root-thing.ts',
    },
  });

  const result = runGuard(packageDir);
  assert.equal(result.status, 0);
});

test('verify-manifest-exports (smrt#2845): skips when there is no dist/manifest.json', () => {
  const packageDir = mkdtempSync(
    join(tmpdir(), 'smrt-verify-manifest-exports-empty-'),
  );
  writeJson(join(packageDir, 'package.json'), {
    name: '@happyvertical/smrt-fixture-empty',
  });

  const result = runGuard(packageDir);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /skipped/);
});
