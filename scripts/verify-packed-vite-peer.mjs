#!/usr/bin/env node
// Run after building core. An optional argument selects an existing core tarball
// for the base regression comparison; otherwise pnpm packs the current package.
// Add --runtime-base after that tarball to isolate the asset runtime regression
// when the old declarations already fail the earlier type comparison.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = process.env.SMRT_PACKED_EVIDENCE_DIR;
const runtimeBaseline = process.argv[3] === '--runtime-base';
assert.ok(!runtimeBaseline || process.argv[2], '--runtime-base requires an explicit baseline tarball');
const fixture = mkdtempSync(join(tmpdir(), 'smrt-vite-peer-'));
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2));
// TypeScript walks ancestors too; refuse an accidentally shared dependency tree.
for (let ancestor = dirname(fixture); ; ancestor = dirname(ancestor)) {
  assert.equal(existsSync(join(ancestor, 'node_modules')), false, `${ancestor} must have no node_modules`);
  if (ancestor === dirname(ancestor)) break;
}
let sequence = 0;
function run(command, args, cwd, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...extraEnv },
  });
  if (evidence) {
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, `${++sequence}-${command.split('/').at(-1)}.log`),
      `${result.stdout ?? ''}${result.stderr ?? ''}\nexit=${result.status}\n`);
  }
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}${result.stderr}`);
  return result.stdout;
}
function install(directory) {
  // No Vite override, symlink injection, or producer dependencies: use the
  // package manager's normal published dependency resolution.
  writeFileSync(join(directory, '.npmrc'), '@happyvertical:registry=https://npm.happyvertical.com/\n');
  run('pnpm', ['install', '--ignore-scripts', '--no-frozen-lockfile'], directory);
}
try {
  let tarball = process.argv[2] && resolve(process.argv[2]);
  if (!tarball) {
    const destination = join(fixture, 'tarballs');
    mkdirSync(destination);
    // Canonical prepack validates and reuses already-built CI artifacts. It
    // must not rebuild/empty live dist while another train worker uses it.
    run('pnpm', ['pack', '--pack-destination', destination], join(root, 'packages/core'), { CI: 'true' });
    tarball = join(destination, readdirSync(destination).find((name) => name.endsWith('.tgz')));
  }
  const hash = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  if (evidence) {
    mkdirSync(evidence, { recursive: true });
    copyFileSync(tarball, join(evidence, 'core.tgz'));
  }
  const summary = { tarball, sha256: hash, node: process.version, cases: [] };
  const workspace = join(fixture, 'web');
  mkdirSync(workspace);
  writeJson(join(workspace, 'package.json'), {
    name: 'vite-peer-hoisted-old-version', private: true, type: 'module',
    dependencies: { vite: '5.4.21' },
  });
  writeFileSync(join(workspace, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n");
  const versions = ['5.4.21', '7.3.7', '8.1.6'];
  for (const version of versions) {
    const app = join(workspace, 'apps', `vite-${version}`);
    mkdirSync(app, { recursive: true });
    writeJson(join(app, 'package.json'), {
      name: `vite-peer-${version}`, private: true, type: 'module',
      dependencies: { '@happyvertical/smrt-core': `file:${tarball}`, vite: version },
      devDependencies: { typescript: '6.0.3', '@types/node': '24.13.6' },
    });
    writeFileSync(join(app, 'consumer.ts'), `import { defineConfig, type Plugin, type PluginOption } from 'vite';
import { smrtPlugin, smrtAssetUrlCompatibility } from '@happyvertical/smrt-core/vite-plugin';
import { smrtConsumer } from '@happyvertical/smrt-core/consumer-plugin';
import { smrt } from '@happyvertical/smrt-core/vite';
const plugins: PluginOption[] = [smrtPlugin(), smrtConsumer(), smrtAssetUrlCompatibility(), smrt({ packages: [] })];
const foreign: Plugin = { name: 'native-worker', config(config) { return { base: config.base }; } };
export default defineConfig({ plugins, worker: { plugins: () => [foreign, [foreign], Promise.resolve([foreign])] } });
type AuthoredTransform = NonNullable<ReturnType<typeof smrtPlugin>['transform']>;
const validTransform: AuthoredTransform = () => ({ code: 'typed-output' });
// @ts-expect-error An authored transform must return code, never a number.
const invalidTransform: AuthoredTransform = () => 123;
type AuthoredConfig = NonNullable<ReturnType<typeof smrtConsumer>['config']>;
const validConfig: AuthoredConfig = () => ({ ssr: { external: ['node:fs'] } });
// @ts-expect-error Authored config result fields retain their native value types.
const invalidConfig: AuthoredConfig = () => ({ ssr: { external: 123 } });
const api: Promise<unknown> = smrtPlugin().api.resolveKnowledgeAgentSurface();
// @ts-expect-error The producer api retains its concrete option value types.
const invalidApi: NonNullable<ReturnType<typeof smrtPlugin>['api']['options']['projectRoot']> = 123;
void [validTransform, validConfig, invalidTransform, invalidConfig, api, invalidApi];
`);
  }
  install(workspace);
  if (evidence) copyFileSync(join(workspace, 'pnpm-lock.yaml'), join(evidence, 'consumer-pnpm-lock.yaml'));
  assert.equal(readJson(join(workspace, 'node_modules/vite/package.json')).version, '5.4.21');
  for (const version of versions) {
    const app = join(workspace, 'apps', `vite-${version}`);
    const require = createRequire(join(app, 'package.json'));
    const coreRequire = createRequire(require.resolve('@happyvertical/smrt-core/vite-plugin'));
    const resolvedVite = readJson(coreRequire.resolve('vite/package.json')).version;
    const packedManifest = readJson(resolve(dirname(require.resolve('@happyvertical/smrt-core/vite-plugin')), '../package.json'));
    if (evidence) writeJson(join(evidence, 'packed-package.json'), packedManifest);
    for (const mode of ['Bundler', 'NodeNext']) {
      if (runtimeBaseline) continue;
      writeJson(join(app, 'tsconfig.json'), { compilerOptions: {
        target: 'ES2023', module: mode === 'NodeNext' ? 'NodeNext' : 'ESNext',
        moduleResolution: mode, strict: true, skipLibCheck: true, noEmit: true, types: ['node'],
      }, files: ['consumer.ts'] });
      run(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.json'], app);
      assert.equal(resolvedVite, '5.4.21', 'Keep the deliberately different core-adjacent Vite');
      summary.cases.push({ version, mode, resolvedVite, status: 'passed' });
    }
    if (!process.argv[2]) {
      assert.equal(packedManifest.peerDependencies?.vite, undefined);
      assert.equal(packedManifest.dependencies?.vite, undefined);
      assert.equal(packedManifest.optionalDependencies?.vite, undefined);
    }
    const ts = require('typescript');
    const pluginEntries = ['vite-plugin', 'consumer-plugin', 'vite'].map((entry) =>
      ts.resolveModuleName(`@happyvertical/smrt-core/${entry}`, join(app, 'consumer.ts'),
        { moduleResolution: ts.ModuleResolutionKind.Bundler }, ts.sys).resolvedModule.resolvedFileName);
    const declarations = ts.createProgram(pluginEntries, {
      moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext,
      skipLibCheck: true, types: ['node'],
    });
    const forbidden = declarations.getSourceFiles().filter((source) =>
      /\/node_modules\/(?:vite|rollup|rolldown)\//.test(source.fileName));
    if (!process.argv[2]) assert.deepEqual(forbidden.map((source) => source.fileName), [], 'Public plugin declarations must not transitively load bundler types');
    writeFileSync(join(app, 'entry.js'), `
      export { manifest as localManifest } from '@happyvertical/smrt-virt-manifest';
      export { manifest as consumedManifest } from '@smrt/manifest';
      export const asset = new URL('./asset.txt', import.meta.url).href;
    `);
    writeFileSync(join(app, 'asset.txt'), 'packed-vite-asset-fixture');
    writeFileSync(join(app, 'runtime-check.mjs'), `
      import assert from 'node:assert/strict';
      import { existsSync, readFileSync } from 'node:fs';
      import { resolve } from 'node:path';
      import { build, version } from 'vite';
      import { smrtPlugin, smrtAssetUrlCompatibility } from '@happyvertical/smrt-core/vite-plugin';
      import { smrtConsumer } from '@happyvertical/smrt-core/consumer-plugin';
      const foreign = { name: 'native-worker', config(config) { return { base: config.base }; } };
      const promised = Promise.resolve([foreign]);
      const previous = [foreign, [foreign], promised];
      let calls = 0;
      const user = { root: process.cwd(), worker: { plugins: () => { calls++; return previous; } } };
      const compatibility = smrtAssetUrlCompatibility();
      await compatibility.config(user, { command: 'build', mode: 'production' });
      if (version.startsWith('7.') && !${runtimeBaseline}) {
        const composed = user.worker.plugins();
        assert.equal(composed[0], previous);
        assert.equal(composed[0][0], foreign);
        assert.equal(composed[0][2], promised);
        assert.equal(composed[1].name, 'smrt-asset-url-compatibility');
        assert.equal(calls, 1);
      } else {
        assert.equal(user.worker.plugins(), previous);
      }
      let original;
      let originalCodeFilter;
      let transformedAssets = 0;
      let guarded;
      const before = { name: 'packed-asset-before', enforce: 'pre', configResolved(config) {
        const asset = config.plugins.find(plugin => plugin.name === 'vite:asset-import-meta-url');
        assert.ok(asset?.transform);
        original = asset.transform;
        originalCodeFilter = typeof original === 'object' ? original.filter?.code : undefined;
      } };
      const after = { name: 'packed-asset-after', enforce: 'post', configResolved(config) {
        const asset = config.plugins.find(plugin => plugin.name === 'vite:asset-import-meta-url');
        const transform = asset.transform;
        guarded = version.startsWith('7.');
        if (guarded) {
          assert.ok(originalCodeFilter instanceof RegExp);
          assert.equal(transform.filter.code, 'import.meta.url');
        } else {
          assert.equal(transform, original);
          if (typeof transform === 'object') assert.equal(transform.filter?.code, originalCodeFilter);
        }
        const handler = typeof transform === 'function' ? transform : transform.handler;
        const observe = function(code, id, ...args) {
          if (id.endsWith('/entry.js') && code.includes('new URL')) transformedAssets++;
          return handler.call(this, code, id, ...args);
        };
        if (typeof transform === 'function') asset.transform = observe;
        else transform.handler = observe;
      } };
      await build({ root: process.cwd(), configFile: false, logLevel: 'warn',
        plugins: [before, smrtConsumer({ projectRoot: process.cwd(), packages: [], generateTypes: false }),
          smrtPlugin({ projectRoot: process.cwd(), include: ['objects/**/*.ts'], svelteKit: { enabled: false }, generateTypes: false }),
          smrtAssetUrlCompatibility(), after],
        build: { lib: { entry: resolve('entry.js'), formats: ['es'] }, minify: false,
          rollupOptions: { output: { entryFileNames: 'bundle.js' } } },
      });
      assert.ok(transformedAssets > 0, 'The actual native asset transform executed');
      assert.ok(existsSync('.smrt/manifest.json'), 'Producer configResolved/buildStart wrote its manifest');
      const output = readFileSync('dist/bundle.js', 'utf8');
      assert.ok(output.includes('packed-vite-asset-fixture') || output.includes('data:text/plain'), 'Asset URL was rewritten');
      const bundled = await import('./dist/bundle.js');
      assert.equal(bundled.localManifest.packageName, ${JSON.stringify(`vite-peer-${version}`)});
      assert.ok(Object.values(bundled.consumedManifest.objects).some(object => object.packageName === '@happyvertical/smrt-core'), 'Consumer virtual manifest contains discovered packed provider models');
      assert.equal(typeof bundled.asset, 'string');
      console.log(JSON.stringify({ version, guarded, transformedAssets, producerManifest: true, consumerVirtualModule: true, workerIdentity: true }));
    `);
    const runtimeResult = run(process.execPath, ['runtime-check.mjs'], app);
    summary.cases.push({ version, runtime: 'production-build', status: 'passed', result: runtimeResult.trim() });
  }
  const server = join(fixture, 'server');
  mkdirSync(server);
  writeJson(join(server, 'package.json'), {
    name: 'server-without-vite', private: true, type: 'module',
    dependencies: { '@happyvertical/smrt-core': `file:${tarball}` },
  });
  writeFileSync(join(server, 'pnpm-workspace.yaml'), 'packages: []\n');
  install(server);
  const graph = JSON.parse(run('pnpm', ['list', '--depth', 'Infinity', '--json'], server));
  function noVite(node) {
    for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, dependency] of Object.entries(node[group] ?? {})) {
        assert.notEqual(name, 'vite', 'Server consumer must not acquire Vite');
        noVite(dependency);
      }
    }
  }
  graph.forEach(noVite);
  run(process.execPath, ['--input-type=module', '-e', "import { SmrtError } from '@happyvertical/smrt-core/smrt-error'; if (typeof SmrtError !== 'function') throw Error('Missing server export');"], server);
  summary.cases.push({ serverWithoutVite: true, status: 'passed' });
  if (evidence) writeJson(join(evidence, 'summary.json'), summary);
  console.log(JSON.stringify(summary));
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
