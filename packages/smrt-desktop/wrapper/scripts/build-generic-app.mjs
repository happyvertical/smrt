#!/usr/bin/env node
// Builds the generic desktop example app (examples/generic-app) from this
// checkout and bundles it with `smrt desktop bundle`.
//
// Why a registry. The bundler installs production dependencies from the app's
// own pnpm-lock.yaml and refuses anything that is not a registry package
// (link:, file:, tarballs), so a bundle can only contain packages a registry
// serves. The workspace packages of this commit are not on a public registry,
// so this script serves them from a throwaway local one (Verdaccio on a
// loopback port, plain http is accepted by the bundler for loopback only):
// it packs the workspace packages the template needs, publishes them there,
// instantiates the repository's own SvelteKit template, resolves and builds
// the app against that registry, and bundles it. Nothing is published
// anywhere else, no credential is read, and everything lives under --out.
//
//   node build-generic-app.mjs --out <dir outside the checkout> \
//     [--targets aarch64-apple-darwin,x86_64-unknown-linux-gnu] [--measure] \
//     [--port <n>] [--bridge <file>]
//
// Prerequisite: the workspace is installed and built for the template
// (`pnpm turbo run build --filter=@happyvertical/smrt-template-sveltekit...`).
// POSIX hosts only (the CI job runs on Linux; the targets are cross-bundled).

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');

/** Exact Verdaccio release (older than two weeks), installed with no scripts. */
export const VERDACCIO_VERSION = '6.2.4';
const SCOPE_PREFIX = '@happyvertical/smrt-';

/** Read every `packages/*` manifest: name -> { dir, json }. */
export function readWorkspacePackages(root) {
  const packages = new Map();
  for (const entry of readdirSync(join(root, 'packages'))) {
    const dir = join(root, 'packages', entry);
    const manifest = join(dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const json = JSON.parse(readFileSync(manifest, 'utf8'));
    if (typeof json.name === 'string') packages.set(json.name, { dir, json });
  }
  return packages;
}

/**
 * The workspace packages an app needs: the roots (its own dependencies and
 * dev dependencies that are workspace packages) and everything they reach
 * through `dependencies`, `peerDependencies` and `optionalDependencies`
 * (never `devDependencies`). Sorted, so the order is deterministic.
 */
export function workspaceClosure(packages, appManifest) {
  const wanted = new Set();
  const stack = Object.keys({
    ...appManifest.dependencies,
    ...appManifest.devDependencies,
  }).filter((name) => packages.has(name));
  while (stack.length > 0) {
    const name = stack.pop();
    if (wanted.has(name)) continue;
    wanted.add(name);
    const { json } = packages.get(name);
    for (const field of [
      'dependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      for (const dependency of Object.keys(json[field] ?? {})) {
        if (packages.has(dependency) && !wanted.has(dependency)) {
          stack.push(dependency);
        }
      }
    }
  }
  return [...wanted].sort();
}

/**
 * Verdaccio configuration: the workspace `@happyvertical/smrt-*` packages are
 * served only from local storage (never proxied, so a published release can
 * not shadow this commit) and everything else proxies npmjs.
 */
export function registryConfig(storageDir) {
  return [
    `storage: ${JSON.stringify(join(storageDir, 'storage'))}`,
    'auth:',
    '  htpasswd:',
    `    file: ${JSON.stringify(join(storageDir, 'htpasswd'))}`,
    '    max_users: 10',
    'uplinks:',
    '  npmjs:',
    '    url: https://registry.npmjs.org/',
    'packages:',
    `  '${SCOPE_PREFIX}*':`,
    '    access: $all',
    '    publish: $authenticated',
    "  '**':",
    '    access: $all',
    '    proxy: npmjs',
    'log: { type: stdout, format: pretty, level: warn }',
    '',
  ].join('\n');
}

/** Publish time recorded for the local packages (long past every age policy). */
export const BACKDATED_PUBLISH_TIME = '2020-01-01T00:00:00.000Z';

/**
 * A packument with every publish time set to `iso`. pnpm 11 refuses (or adds
 * to `minimumReleaseAgeExclude`, a key the bundler refuses) a version younger
 * than its release-age policy, and these packages were published seconds ago
 * to a registry that exists for this run only. Only the stored metadata of the
 * throwaway registry is changed, never a policy.
 */
export function backdatePackument(packument, iso = BACKDATED_PUBLISH_TIME) {
  const time = {};
  for (const key of Object.keys(packument.time ?? {})) time[key] = iso;
  return { ...packument, time };
}

/**
 * The app's `.npmrc`: the default registry and the `@happyvertical` scope both
 * point at the loopback registry (a scope line in a user or organisation
 * `.npmrc` would otherwise win over the default and fetch the released
 * packages instead of this commit's).
 */
export function appNpmrc(registryUrl) {
  return `registry=${registryUrl}\n@happyvertical:registry=${registryUrl}\n`;
}

/** True when `child` is `parent` or inside it (both already real paths). */
export function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep));
}

function parseArgs(argv) {
  const options = {
    out: undefined,
    targets: [],
    measure: false,
    port: 0,
    bridge: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      i += 1;
      if (argv[i] === undefined) throw new Error(`${flag} needs a value`);
      return argv[i];
    };
    if (flag === '--out') options.out = value();
    else if (flag === '--targets') options.targets = value().split(',');
    else if (flag === '--measure') options.measure = true;
    else if (flag === '--port') options.port = Number(value());
    else if (flag === '--bridge') options.bridge = value();
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!options.out) throw new Error('--out is required');
  if (options.targets.length === 0) throw new Error('--targets is required');
  if (!Number.isInteger(options.port) || options.port < 0) {
    throw new Error('--port must be a port number (0 picks a free one)');
  }
  return options;
}

/**
 * A free loopback port. pnpm caches registry metadata per host and port, so a
 * fresh port per run keeps a stale cache from an earlier run's registry (with
 * the same package versions but other contents) from being believed.
 */
function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.on('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

function run(command, args, { cwd, env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0] ?? ''} failed (${result.status})`);
  }
}

async function waitForRegistry(url, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error('the local registry exited');
    try {
      const response = await fetch(`${url}-/ping`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error('the local registry did not start');
}

async function startRegistry(root, port) {
  const tools = join(root, 'tools');
  mkdirSync(tools, { recursive: true });
  run('npm', [
    'install',
    '--prefix',
    tools,
    `verdaccio@${VERDACCIO_VERSION}`,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  ]);
  const registryDir = join(root, 'registry');
  mkdirSync(registryDir, { recursive: true });
  writeFileSync(join(registryDir, 'config.yaml'), registryConfig(registryDir));
  const url = `http://127.0.0.1:${port}/`;
  const child = spawn(
    process.execPath,
    [
      join(tools, 'node_modules', 'verdaccio', 'bin', 'verdaccio'),
      '--config',
      join(registryDir, 'config.yaml'),
      '--listen',
      `127.0.0.1:${port}`,
    ],
    { stdio: 'inherit' },
  );
  await waitForRegistry(url, child);
  // A throwaway account on a throwaway registry; the token never leaves --out.
  const created = await fetch(`${url}-/user/org.couchdb.user:publisher`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'publisher',
      password: `pw-${Math.random().toString(36).slice(2)}-${Date.now()}`,
      email: 'publisher@example.invalid',
    }),
  });
  const { token } = await created.json();
  if (typeof token !== 'string') throw new Error('registry sign-up failed');
  const userconfig = join(registryDir, 'publish.npmrc');
  writeFileSync(userconfig, `//127.0.0.1:${port}/:_authToken=${token}\n`);
  return { url, child, userconfig };
}

function publishWorkspace(packages, names, registry, root) {
  const packs = join(root, 'packs');
  mkdirSync(packs, { recursive: true });
  for (const name of names) {
    const { dir, json } = packages.get(name);
    if (json.private === true) {
      throw new Error(`${name} is private and cannot be published`);
    }
    console.error(`pack and publish ${name}`);
    const before = new Set(readdirSync(packs));
    run('pnpm', ['pack', '--pack-destination', packs], { cwd: dir });
    const tarball = readdirSync(packs).find((file) => !before.has(file));
    if (!tarball) throw new Error(`pnpm pack produced nothing for ${name}`);
    run('npm', [
      'publish',
      join(packs, tarball),
      '--registry',
      registry.url,
      '--userconfig',
      registry.userconfig,
      '--access',
      'public',
    ]);
  }
}

function backdateLocalRegistry(root, names) {
  for (const name of names) {
    const file = join(root, 'registry', 'storage', ...name.split('/'), 'package.json');
    const packument = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify(backdatePackument(packument)));
  }
}

async function instantiateApp(root, registryUrl) {
  const app = join(root, 'app');
  const templateIndex = join(repoRoot, 'packages', 'template-sveltekit', 'index.js');
  const { copyTemplate } = await import(pathToFileURL(templateIndex).href);
  copyTemplate(app, { name: 'generic-smrt-app' });
  const example = join(repoRoot, 'packages', 'smrt-desktop', 'examples', 'generic-app');
  cpSync(join(example, 'overlay'), app, { recursive: true });
  cpSync(join(example, 'smrt-desktop.json'), join(app, 'smrt-desktop.json'));
  // copyTemplate points the scope at the organisation registry; this app
  // resolves everything through the local one.
  writeFileSync(join(app, '.npmrc'), appNpmrc(registryUrl));
  return app;
}

function buildBridge(root, given) {
  if (given) return resolve(given);
  const entry = join(repoRoot, 'packages', 'app-cli', 'dist', 'bin', 'smrt-mcp-bridge.js');
  if (!existsSync(entry)) {
    throw new Error('packages/app-cli is not built (no dist/bin/smrt-mcp-bridge.js)');
  }
  const bridge = join(root, 'smrt-mcp-bridge.mjs');
  run(join(repoRoot, 'node_modules', '.bin', 'esbuild'), [
    entry,
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--target=node24',
    `--outfile=${bridge}`,
    '--log-level=warning',
    // CommonJS dependencies inside an ES module bundle need require().
    '--banner:js=import { createRequire as __smrtCreateRequire } from "node:module"; const require = __smrtCreateRequire(import.meta.url);',
  ]);
  return bridge;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  mkdirSync(options.out, { recursive: true });
  const root = realpathSync(options.out);
  if (isInside(realpathSync(repoRoot), root)) {
    throw new Error('--out must be outside the repository checkout');
  }
  const packages = readWorkspacePackages(repoRoot);
  const template = JSON.parse(
    readFileSync(
      join(repoRoot, 'packages', 'template-sveltekit', 'template', 'package.json'),
      'utf8',
    ),
  );
  const names = workspaceClosure(packages, template);
  console.error(`workspace packages to serve locally: ${names.length}`);

  const registry = await startRegistry(root, options.port || (await freePort()));
  try {
    publishWorkspace(packages, names, registry, root);
    backdateLocalRegistry(root, names);
    const app = await instantiateApp(root, registry.url);
    // The first install resolves the lock against the local registry; the
    // build runs the app's own `smrt app build` (adapter-node).
    run('pnpm', ['install', '--ignore-scripts'], { cwd: app });
    run('pnpm', ['exec', 'smrt', 'app', 'build'], { cwd: app });
    const bridge = buildBridge(root, options.bridge);
    const smrt = join(repoRoot, 'packages', 'cli', 'bin', 'smrt.js');
    for (const target of options.targets) {
      const out = join(root, 'bundle', target);
      mkdirSync(dirname(out), { recursive: true });
      rmSync(out, { recursive: true, force: true });
      run(process.execPath, [
        smrt,
        'desktop',
        'bundle',
        '--app',
        app,
        '--bridge',
        bridge,
        '--target',
        target,
        '--out',
        out,
        ...(options.measure ? ['--measure'] : []),
      ]);
      console.error(`bundled ${target}`);
    }
  } finally {
    registry.child.kill('SIGTERM');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`build-generic-app: ${error.message}`);
    process.exit(1);
  });
}
