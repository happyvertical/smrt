import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  APPS,
  appNpmrc,
  BACKDATED_PUBLISH_TIME,
  backdatePackument,
  isInside,
  listShellFiles,
  parseCatalog,
  readWorkspacePackages,
  registryConfig,
  SHELL_APP_WORKSPACE_YAML,
  shellAppManifest,
  shellFileWanted,
  VERDACCIO_VERSION,
  workspaceClosure,
} from './build-desktop-app.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

test('the closure follows runtime and peer links, never dev dependencies', () => {
  const packages = new Map([
    ['a', { json: { dependencies: { b: '1' }, devDependencies: { dev: '1' } } }],
    ['b', { json: { peerDependencies: { c: '1' } } }],
    ['c', { json: { optionalDependencies: { d: '1' } } }],
    ['d', { json: {} }],
    ['dev', { json: {} }],
    ['unrelated', { json: {} }],
  ]);
  assert.deepEqual(
    workspaceClosure(packages, { devDependencies: { a: '1', external: '1' } }),
    ['a', 'b', 'c', 'd'],
  );
});

test('the real template resolves to workspace packages that can be published', () => {
  const packages = readWorkspacePackages(root);
  const template = JSON.parse(
    readFileSync(
      join(root, 'packages', 'template-sveltekit', 'template', 'package.json'),
      'utf8',
    ),
  );
  const names = workspaceClosure(packages, template);
  for (const required of [
    '@happyvertical/smrt-app-runtime',
    '@happyvertical/smrt-core',
    '@happyvertical/smrt-cli',
  ]) {
    assert.ok(names.includes(required), required);
  }
  for (const name of names) {
    assert.notEqual(packages.get(name).json.private, true, `${name} is private`);
  }
});

test('the registry serves workspace packages locally and never proxies them', () => {
  const config = registryConfig('/tmp/reg');
  const smrt = config.indexOf("'@happyvertical/smrt-*'");
  const rest = config.indexOf("'**'");
  assert.ok(smrt > 0 && rest > smrt);
  assert.ok(!config.slice(smrt, rest).includes('proxy'));
  assert.ok(config.slice(rest).includes('proxy: npmjs'));
  assert.ok(config.includes('publish: $authenticated'));
});

test('the app resolves the default and the scope through the loopback registry', () => {
  assert.equal(
    appNpmrc('http://127.0.0.1:4873/'),
    'registry=http://127.0.0.1:4873/\n@happyvertical:registry=http://127.0.0.1:4873/\n',
  );
});

test('the registry tool is pinned to an exact version', () => {
  assert.match(VERDACCIO_VERSION, /^\d+\.\d+\.\d+$/);
});

test('--out containment is lexical on real paths', () => {
  assert.equal(isInside('/repo', '/repo'), true);
  assert.equal(isInside('/repo', '/repo/out'), true);
  assert.equal(isInside('/repo', '/repository'), false);
  assert.equal(isInside('/repo', '/tmp/out'), false);
});

test('the generic app bundles without the AI provider SDKs and starts', () => {
  // @happyvertical/ai >= 0.111.9 loads openai, @anthropic-ai/sdk and
  // @google/genai only when a provider is created, and smrt-inference reads
  // its constants from `@happyvertical/ai/types`, so the default bundle can
  // drop the SDKs. Enabling `ai-providers` would put them back (about 9 MiB)
  // and a static value import of the `@happyvertical/ai` root in inference
  // would make a bundle without them crash at start.
  const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');
  const config = JSON.parse(
    read('packages', 'smrt-desktop', 'examples', 'generic-app', 'smrt-desktop.json'),
  );
  assert.ok(!(config.features?.default ?? []).includes('ai-providers'));
  const inference = join(root, 'packages', 'inference', 'src');
  const stack = [inference];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (/\.ts$/.test(entry.name) && !/\.(test|spec)\.ts$/.test(entry.name)) {
        const staticValueImport =
          /^import\s+(?!type\b)[^;]*?from\s+'@happyvertical\/ai';/ms.test(
            readFileSync(path, 'utf8'),
          );
        assert.equal(staticValueImport, false, `${path} imports the @happyvertical/ai root`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Tricia (the app shell)
// ---------------------------------------------------------------------------

test('the catalog parser reads quoted and bare keys and stops at the next block', () => {
  const catalog = parseCatalog(
    [
      'packages:',
      "  - 'packages/*'",
      'catalog:',
      "  '@happyvertical/ai': ^0.111.9",
      '  sharp: "^0.35.5"',
      '',
      'allowBuilds:',
      '  esbuild: true',
      '',
    ].join('\n'),
  );
  assert.deepEqual(
    [...catalog],
    [
      ['@happyvertical/ai', '^0.111.9'],
      ['sharp', '^0.35.5'],
    ],
  );
});

function shellFixture() {
  const packages = readWorkspacePackages(root);
  const shell = packages.get('@happyvertical/smrt-app-shell');
  const catalog = parseCatalog(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'));
  return { packages, shell, catalog };
}

test('the Tricia manifest has registry ranges only and depends on the shell package', () => {
  const { packages, shell, catalog } = shellFixture();
  const manifest = shellAppManifest(shell, packages, catalog, {
    packageName: APPS.tricia.packageName,
    packageManager: 'pnpm@0.0.0',
  });
  assert.equal(manifest.private, true);
  assert.equal(manifest.name, '@happyvertical/tricia-app');
  assert.equal(manifest.dependencies['@happyvertical/smrt-app-shell'], `^${shell.json.version}`);
  for (const map of [manifest.dependencies, manifest.devDependencies]) {
    for (const [name, range] of Object.entries(map)) {
      assert.doesNotMatch(range, /^(?:workspace|catalog|link|file):/, `${name}: ${range}`);
    }
  }
  assert.ok(!('@happyvertical/smrt-vitest' in manifest.devDependencies));
  assert.ok(!('vitest' in manifest.devDependencies));
  assert.equal(manifest.dependencies['@happyvertical/ai'], catalog.get('@happyvertical/ai'));
  // The closure reaches the shell, its runtime and the shell's own
  // dependencies, so the local registry serves all of them.
  const names = workspaceClosure(packages, manifest);
  for (const required of [
    '@happyvertical/smrt-app-shell',
    '@happyvertical/smrt-app-runtime',
    '@happyvertical/smrt-core',
  ]) {
    assert.ok(names.includes(required), required);
  }
  for (const name of names) {
    assert.notEqual(packages.get(name).json.private, true, `${name} is private`);
  }
});

test('an unresolvable catalog range fails loudly', () => {
  const { packages, shell } = shellFixture();
  assert.throws(
    () =>
      shellAppManifest(shell, packages, new Map(), {
        packageName: 'x',
        packageManager: 'pnpm@0.0.0',
      }),
    /no catalog entry/,
  );
});

test('the shell copy takes sources and config, never tests or generated files', () => {
  assert.equal(shellFileWanted('src/lib/server/smrt.ts'), true);
  assert.equal(shellFileWanted('src/routes/api/_runtime/owner-link/+server.ts'), true);
  assert.equal(shellFileWanted('vite.config.ts'), true);
  assert.equal(shellFileWanted('tools/manifest-guard.ts'), true);
  assert.equal(shellFileWanted('src/routes/routes.test.ts'), false);
  assert.equal(shellFileWanted('src/lib/server/smrt-register.ts'), false);
  assert.equal(shellFileWanted('src/routes/api/apps/addField/+server.ts'), false);
  assert.equal(shellFileWanted('src/lib/types/smrt-generated/x.ts'), false);
  assert.equal(shellFileWanted('tools/publish-manifest.mjs'), false);
  assert.equal(shellFileWanted('package.json'), false);
  assert.equal(shellFileWanted('build/index.js'), false);
  assert.equal(shellFileWanted('node_modules/x/index.js'), false);
  assert.equal(shellFileWanted('.svelte-kit/tsconfig.json'), false);
  assert.match(SHELL_APP_WORKSPACE_YAML, /^allowBuilds:/);
});

test('the real shell lists the routes the desktop product needs', () => {
  const files = listShellFiles(join(root, 'packages', 'app-shell'));
  for (const required of [
    'src/routes/api/_runtime/health/+server.ts',
    'src/routes/api/_runtime/owner-link/+server.ts',
    'src/routes/mcp/+server.ts',
    'src/routes/setup/+page.svelte',
    'vite.config.ts',
  ]) {
    assert.ok(files.includes(required), required);
  }
  assert.ok(files.every((file) => !file.endsWith('.test.ts')));
});

test('the Tricia product configuration names the routes the shell mounts', () => {
  const config = JSON.parse(
    readFileSync(
      join(root, 'packages', 'smrt-desktop', 'examples', APPS.tricia.example, 'smrt-desktop.json'),
      'utf8',
    ),
  );
  assert.equal(config.productId, 'tricia');
  assert.equal(config.bundleId, 'com.happyvertical.tricia');
  assert.equal(config.displayName, 'Tricia');
  // Signing and update settings are not product configuration.
  assert.deepEqual(Object.keys(config).sort(), [
    'acknowledgedDynamicImports',
    'bridge',
    'bundleId',
    'displayName',
    'features',
    'productId',
    'sidecar',
    'version',
  ]);
  const routes = join(root, 'packages', 'app-shell', 'src', 'routes');
  const mounted = (route) =>
    existsSync(join(routes, ...route.split('/').filter(Boolean), '+server.ts'));
  assert.ok(mounted(config.sidecar.healthRoute));
  assert.ok(mounted(config.sidecar.ownerClaimRoute));
  assert.ok(mounted(config.bridge.mcpPath));
  // The assistant resolves its provider at run time, so the SDKs must ship.
  assert.ok(config.features.default.includes('ai-providers'));
});

test('the known apps are generic and tricia', () => {
  assert.deepEqual(Object.keys(APPS), ['generic', 'tricia']);
});

test('backdating changes only the publish times', () => {
  const packument = {
    name: 'p',
    versions: { '1.0.0': { name: 'p' } },
    time: { created: '2030-01-01T00:00:00.000Z', '1.0.0': '2030-01-01T00:00:00.000Z' },
  };
  const out = backdatePackument(packument);
  assert.deepEqual(out.versions, packument.versions);
  assert.deepEqual(out.time, {
    created: BACKDATED_PUBLISH_TIME,
    '1.0.0': BACKDATED_PUBLISH_TIME,
  });
  assert.equal(packument.time.created, '2030-01-01T00:00:00.000Z');
  assert.deepEqual(backdatePackument({ name: 'q' }).time, {});
});
