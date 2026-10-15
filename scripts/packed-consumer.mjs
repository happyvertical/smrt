import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';

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
  // Producer lifecycle hooks must never empty a live workspace's dist while
  // sibling suites consume it. Keep producer dependencies outside the consumer.
  const producer = mkdtempSync(resolve(temporaryRoot, '.smrt-packed-producer-'));
  const selected = new Map();
  const select = (name) => {
    if (selected.has(name)) return;
    const entry = packages.get(name);
    assert.ok(entry, `Unknown workspace package ${name}`);
    selected.set(name, entry);
    for (const dependency of Object.keys({ ...entry.manifest.dependencies,
      ...entry.manifest.optionalDependencies, ...entry.manifest.peerDependencies })) {
      if (packages.has(dependency)) select(dependency);
    }
  };
  const packed = new Map();
  const externalVersions = new Map();

  function run(command, args, cwd = fixture) {
    const result = spawnSync(command, args, {
      cwd, encoding: 'utf8',
      // The fixture borrows installed dependencies; pnpm must not relink them.
      env: cwd.startsWith(`${producer}/`) ? { ...process.env, pnpm_config_verify_deps_before_run: 'false' } : process.env,
      maxBuffer: 16 * 1024 * 1024,
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
    const output = run('pnpm', ['pack', '--pack-destination', destination], resolve(producer, 'packages', basename(dir)));
    if (evidence) { mkdirSync(evidence, { recursive: true }); writeFileSync(resolve(evidence, `${basename(dir)}-prepack.log`), output); }
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
    for (const name of packageNames) select(name);
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile() && (entry.name === 'package.json' || entry.name === 'pnpm-workspace.yaml' || entry.name === 'pnpm-lock.yaml' || entry.name === 'AGENTS.md' || /^(tsconfig.*\.json|vite\.config\..+)$/.test(entry.name)))
        copyFileSync(resolve(root, entry.name), resolve(producer, entry.name));
    }
    cpSync(resolve(root, 'scripts'), resolve(producer, 'scripts'), { recursive: true });
    const linkDependencies = (source, destination) => {
      mkdirSync(destination, { recursive: true });
      for (const entry of readdirSync(source, { withFileTypes: true })) {
        const from = resolve(source, entry.name);
        const to = resolve(destination, entry.name);
        if (entry.isDirectory() && entry.name.startsWith('@')) {
          linkDependencies(from, to);
        } else if (entry.name === '.bin') {
          cpSync(from, to, { recursive: true });
        } else {
          const resolved = realpathSync(from);
          const owned = [...selected.values()].find(({ dir }) => realpathSync(dir) === resolved);
          symlinkSync(owned ? resolve(producer, 'packages', basename(owned.dir)) : resolved, to);
        }
      }
    };
    linkDependencies(resolve(root, 'node_modules'), resolve(producer, 'node_modules'));
    for (const { dir } of selected.values()) {
      const target = resolve(producer, 'packages', basename(dir));
      cpSync(dir, target, { recursive: true, filter: (path) => !['node_modules', '.turbo'].includes(basename(path)) });
      linkDependencies(resolve(dir, 'node_modules'), resolve(target, 'node_modules'));
    }
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
  } finally {
    rmSync(producer, { recursive: true, force: true });
  }
}
