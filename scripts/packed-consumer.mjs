import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

// TypeScript also searches ancestor node_modules directories for imports. A
// temporary directory alone is not isolation when /tmp/node_modules exists.
function hasCleanAncestors(directory) {
  for (let current = resolve(directory); ; current = dirname(current)) {
    if (existsSync(resolve(current, 'node_modules'))) return false;
    if (dirname(current) === current) return true;
  }
}
/** Install real workspace tarballs in a consumer that cannot borrow producer types. */
export function createPackedConsumer({ root, packageNames, evidence, consumerDependencies = {}, overrides = {} }) {
  const workspace = readJson(resolve(root, 'package.json'));
  const temporaryRoot = [tmpdir(), homedir()].find(hasCleanAncestors);
  assert.ok(temporaryRoot, 'Choose a TMPDIR with no ancestor node_modules directories');
  const fixture = mkdtempSync(resolve(temporaryRoot, '.smrt-packed-declarations-'));
  const packages = new Map();
  for (const entry of readdirSync(resolve(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = resolve(root, 'packages', entry.name);
    try {
      const manifest = readJson(resolve(dir, 'package.json'));
      packages.set(manifest.name, { dir, manifest });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const packed = new Map();
  const externalVersions = new Map();

  function run(command, args, cwd = fixture) {
    const result = spawnSync(command, args, {
      cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}${result.stderr}`);
    return result.stdout;
  }

  function pack(name) {
    if (packed.has(name)) return;
    const { dir, manifest } = packages.get(name);
    const destination = resolve(fixture, 'tarballs', name);
    mkdirSync(destination, { recursive: true });
    run('pnpm', ['pack', '--pack-destination', destination], dir);
    const tarballs = readdirSync(destination).filter((path) => path.endsWith('.tgz'));
    assert.equal(tarballs.length, 1);
    const tarball = resolve(destination, tarballs[0]);
    packed.set(name, tarball);
    console.log(`Packed ${name}: ${createHash('sha256').update(readFileSync(tarball)).digest('hex')}`);
    if (evidence) {
      mkdirSync(resolve(evidence, 'tarballs'), { recursive: true });
      copyFileSync(tarball, resolve(evidence, 'tarballs', tarballs[0]));
    }
    for (const dependency of Object.keys({
      ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies,
    })) {
      if (packages.has(dependency)) {
        pack(dependency);
        continue;
      }
      // Match the producer's resolved direct external versions, without exposing
      // its node_modules tree or injecting its development-only @types packages.
      let version;
      try {
        version = readJson(resolve(dir, 'node_modules', dependency, 'package.json')).version;
      } catch (error) {
        const optional = manifest.peerDependenciesMeta?.[dependency]?.optional ||
          Object.hasOwn(manifest.optionalDependencies ?? {}, dependency);
        if (optional && error.code === 'ENOENT') continue;
        throw error;
      }
      const existing = externalVersions.get(dependency);
      assert.ok(!existing || existing === version, `Conflicting external versions for ${dependency}`);
      externalVersions.set(dependency, version);
    }
  }

  try {
    for (const name of packageNames) pack(name);
    const dependencies = { ...Object.fromEntries([...packed].map(([name, path]) => [name, `file:${path}`])), ...consumerDependencies };
    const nodeTypes = readJson(resolve(root, 'packages/core/node_modules/@types/node/package.json')).version;
    writeFileSync(resolve(fixture, 'package.json'), JSON.stringify({
      name: 'smrt-packed-type-consumer', private: true, type: 'module',
      packageManager: workspace.packageManager,
      dependencies,
      devDependencies: { typescript: workspace.devDependencies.typescript, '@types/node': nodeTypes },
    }, null, 2));
    writeFileSync(resolve(fixture, 'pnpm-workspace.yaml'), JSON.stringify({
      packages: [],
      overrides: { ...Object.fromEntries(externalVersions), ...Object.fromEntries([...packed.keys()].map((name) => [name, dependencies[name]])), ...overrides },
    }, null, 2));
    // Honor the project's public registry routing without copying credentials.
    const npmrc = resolve(root, '.npmrc');
    const registryLines = existsSync(npmrc)
      ? readFileSync(npmrc, 'utf8').split(/\r?\n/).filter((line) => /^\s*(?:@[\w-]+:)?registry\s*=/.test(line))
      : [];
    for (const line of registryLines) {
      const url = new URL(line.slice(line.indexOf('=') + 1).trim());
      assert.ok(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash, 'Consumer registry must be a public HTTPS endpoint without credentials');
    }
    if (registryLines.length) writeFileSync(resolve(fixture, '.npmrc'), `${registryLines.join('\n')}\n`);
    // Type-only fixture: normal producer install/build checks retain lifecycle scripts.
    const install = run('pnpm', ['install', '--ignore-scripts', '--no-frozen-lockfile']);
    const installedJson = run('pnpm', ['list', '--depth', 'Infinity', '--json']);
    const expectedTarballs = new Map([...packed].map(([name, path]) => [name, `file:${path}`]));
    for (const [name, target] of Object.entries(overrides)) {
      if (target.startsWith('file:')) expectedTarballs.set(name, target);
    }
    const checkInstalled = (node) => {
      for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        for (const [name, dependency] of Object.entries(node[group] ?? {})) {
          if (expectedTarballs.has(name)) {
            const expected = expectedTarballs.get(name);
            assert.ok(dependency.resolved?.startsWith('file:'), `${name} unexpectedly resolved from the registry`);
            assert.equal(resolve(fixture, dependency.resolved.slice(5)), resolve(fixture, expected.slice(5)), `${name} must resolve to its selected tarball`);
          }
          checkInstalled(dependency);
        }
      }
    };
    JSON.parse(installedJson).forEach(checkInstalled);
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      copyFileSync(resolve(fixture, 'package.json'), resolve(evidence, 'consumer-package.json'));
      copyFileSync(resolve(fixture, 'pnpm-workspace.yaml'), resolve(evidence, 'consumer-pnpm-workspace.yaml'));
      copyFileSync(resolve(fixture, 'pnpm-lock.yaml'), resolve(evidence, 'consumer-pnpm-lock.yaml'));
      if (registryLines.length) copyFileSync(resolve(fixture, '.npmrc'), resolve(evidence, 'consumer-npmrc'));
      writeFileSync(resolve(evidence, 'consumer-install.log'), `${install}\nexit=0\n`);
      writeFileSync(resolve(evidence, 'consumer-installed.json'), installedJson);
    }
    return { directory: fixture, run, cleanup: () => rmSync(fixture, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(fixture, { recursive: true, force: true });
    throw error;
  }
}
