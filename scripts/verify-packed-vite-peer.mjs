#!/usr/bin/env node
// Run after building core. An optional argument selects an existing core tarball
// for the base regression comparison; otherwise pnpm packs the current package.
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
  // package manager's normal published dependency and optional peer resolution.
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
    writeFileSync(join(app, 'consumer.ts'), `import { defineConfig } from 'vite';
import { smrtPlugin, smrtAssetUrlCompatibility } from '@happyvertical/smrt-core/vite-plugin';
import { smrtConsumer } from '@happyvertical/smrt-core/consumer-plugin';
export default defineConfig({ plugins: [smrtPlugin(), smrtConsumer(), smrtAssetUrlCompatibility()] });
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
      writeJson(join(app, 'tsconfig.json'), { compilerOptions: {
        target: 'ES2023', module: mode === 'NodeNext' ? 'NodeNext' : 'ESNext',
        moduleResolution: mode, strict: true, skipLibCheck: true, noEmit: true, types: ['node'],
      }, files: ['consumer.ts'] });
      run(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.json'], app);
      assert.equal(resolvedVite, version, 'Core declarations must use the consuming app Vite');
      summary.cases.push({ version, mode, resolvedVite, status: 'passed' });
    }
    if (!process.argv[2]) {
      assert.equal(packedManifest.peerDependencies?.vite, '>=5.0.0 <9.0.0');
      assert.equal(packedManifest.peerDependenciesMeta?.vite?.optional, true);
    }
    run(process.execPath, ['--input-type=module', '-e', `
      import { smrtPlugin } from '@happyvertical/smrt-core/vite-plugin';
      import { smrtConsumer } from '@happyvertical/smrt-core/consumer-plugin';
      if (typeof smrtPlugin !== 'function' || typeof smrtConsumer !== 'function') throw Error('Missing plugin');
    `], app);
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
