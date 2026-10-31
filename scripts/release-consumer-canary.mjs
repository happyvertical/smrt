#!/usr/bin/env node
/**
 * Release consumer canary (issue #2975).
 *
 * #2970 shipped in 0.51.8 and was found by a downstream app, not here: every
 * in-repo test read the generated `.smrt/register.js` as text, and none ran an
 * installed app whose aggregated manifest smrt-vitest loads and whose generated
 * registration then re-registers the same classes. This canary is that app,
 * installed from the release tarballs before anything is published.
 *
 * It copies the checked-in fixture (`scripts/fixtures/release-consumer-canary`)
 * into a directory with no ancestor `node_modules`, installs
 * `@happyvertical/smrt-core`, `@happyvertical/smrt-vitest` and
 * `@happyvertical/smrt-cli` from their tarballs (every release package is
 * overridden to its tarball, so transitive smrt dependencies come from the
 * release as well), and then requires, in order:
 *
 *   build      `vite build` with smrtPlugin + smrtConsumer writes the
 *              aggregated `.smrt/manifest.json` and `.smrt/register.js`
 *   register   plain Node imports the generated `.smrt/register.js` into the
 *              installed `ObjectRegistry` and resolves every schema, as the
 *              smrt CLI does for db:migrate
 *   typecheck  `tsc --noEmit` against the packed declarations
 *   test       a smrt-vitest suite imports the generated registration after
 *              the setup loaded the manifest, then checks package attribution
 *              and resolves schemas (the #2970 shape)
 *   migrate    `smrt db:migrate` then `smrt db:status` from the installed
 *              CLI and manifests, on the scratch SQLite database the
 *              fixture's `smrt.config.js` names
 *
 * The planner release gate (publish.yml and Publish Dry Run) runs it as a
 * framework check, so a failing canary blocks publication.
 *
 * Usage: node scripts/release-consumer-canary.mjs --packs <dir> [--keep]
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const FIXTURE = join(ROOT, 'scripts/fixtures/release-consumer-canary');

/** Release packages the canary installs directly; the rest arrive transitively. */
export const CANARY_PACKAGES = {
  dependencies: ['@happyvertical/smrt-core', '@happyvertical/smrt-tags'],
  devDependencies: ['@happyvertical/smrt-cli', '@happyvertical/smrt-vitest'],
};

/** Third-party tools the consumer pins to the versions this repository uses. */
const TOOL_VERSIONS = ['typescript', 'vite', 'vitest'];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readPackedName(path) {
  const result = spawnSync('tar', ['-xzOf', path, 'package/package.json'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`cannot read ${path}: ${result.stderr || result.error?.message}`);
  }
  return JSON.parse(result.stdout).name;
}

/** `{ name -> absolute tarball path }` for every tarball in `dir`. */
function readTarballs(dir, readName = readPackedName) {
  const tarballs = new Map();
  for (const file of readdirSync(dir).sort()) {
    if (file.endsWith('.tgz')) tarballs.set(readName(resolve(dir, file)), resolve(dir, file));
  }
  return tarballs;
}

/**
 * A top-level YAML block of `  key: value` lines (e.g. `allowBuilds:`) from
 * the repository's pnpm-workspace.yaml, so the consumer approves exactly the
 * install scripts this repository approves.
 */
export function yamlBlock(text, key) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === `${key}:`);
  if (start === -1) return [];
  const block = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('  ')) break;
    block.push(line);
  }
  return block;
}

/** The repository's catalog pin for a package, if it has one. */
export function catalogVersion(workspaceYaml, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const match = workspaceYaml.match(
    new RegExp(`^  '?${escaped}'?:\\s*['"]?([^'"\\s#]+)`, 'm'),
  );
  return match?.[1];
}

/**
 * The consumer's package.json and pnpm-workspace.yaml for these tarballs.
 * Throws when the release lacks a package the canary installs directly.
 */
export function consumerManifests({ tarballs, rootPackageJson, workspaceYaml, template }) {
  const missing = [
    ...CANARY_PACKAGES.dependencies,
    ...CANARY_PACKAGES.devDependencies,
  ].filter((name) => !tarballs.has(name));
  if (missing.length > 0) {
    throw new Error(`release packs lack ${missing.join(', ')}`);
  }
  const spec = (name) => `file:${tarballs.get(name)}`;
  const tools = {};
  for (const name of TOOL_VERSIONS) {
    const version = rootPackageJson.devDependencies?.[name];
    if (!version) throw new Error(`root package.json does not pin ${name}`);
    tools[name] = version;
  }
  const typesNode = catalogVersion(workspaceYaml, '@types/node');
  if (!typesNode) throw new Error('pnpm-workspace.yaml catalog does not pin @types/node');
  const packageJson = {
    ...template,
    packageManager: rootPackageJson.packageManager,
    dependencies: Object.fromEntries(
      CANARY_PACKAGES.dependencies.map((name) => [name, spec(name)]),
    ),
    devDependencies: {
      ...Object.fromEntries(
        CANARY_PACKAGES.devDependencies.map((name) => [name, spec(name)]),
      ),
      ...tools,
      '@types/node': typesNode,
    },
  };
  const overrides = [...tarballs.keys()]
    .sort()
    .map((name) => `  '${name}': 'file:${tarballs.get(name)}'`);
  const allowBuilds = yamlBlock(workspaceYaml, 'allowBuilds');
  const consumerYaml = [
    'overrides:',
    ...overrides,
    ...(allowBuilds.length > 0 ? ['allowBuilds:', ...allowBuilds] : []),
    '',
  ].join('\n');
  return { packageJson, workspaceYaml: consumerYaml };
}

// TypeScript and Node both search ancestor node_modules directories; a scratch
// directory is isolated only when none of its ancestors has one.
function hasCleanAncestors(directory) {
  for (let current = resolve(directory); ; current = dirname(current)) {
    if (existsSync(join(current, 'node_modules'))) return false;
    if (dirname(current) === current) return true;
  }
}

function run(command, args, { cwd, env = {}, label }) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  writeFileSync(join(cwd, `canary-${label}.log`), output);
  if (result.error || result.status !== 0) {
    const tail = output.trim().split('\n').slice(-40).join('\n');
    throw new Error(
      `${label} failed (${result.error?.message ?? `exit ${result.status}`}): ${command} ${args.join(' ')}\n${tail}`,
    );
  }
  return output;
}

/**
 * Install the fixture against `tarballs` and run every stage. Returns the
 * consumer directory (removed unless `keep`); throws on the first failure.
 */
export function runReleaseConsumerCanary({ tarballs, keep = false, log = console.log }) {
  const base = [tmpdir(), homedir()].find(hasCleanAncestors);
  if (!base) throw new Error('choose a TMPDIR with no ancestor node_modules directory');
  const app = mkdtempSync(join(base, 'smrt-release-consumer-'));
  try {
    cpSync(FIXTURE, app, { recursive: true });
    const { packageJson, workspaceYaml } = consumerManifests({
      tarballs,
      rootPackageJson: readJson(join(ROOT, 'package.json')),
      workspaceYaml: readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8'),
      template: readJson(join(app, 'package.template.json')),
    });
    rmSync(join(app, 'package.template.json'));
    writeFileSync(join(app, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
    writeFileSync(join(app, 'pnpm-workspace.yaml'), workspaceYaml);
    // The @happyvertical scope resolves through the repository's registry.
    cpSync(join(ROOT, '.npmrc'), join(app, '.npmrc'));

    const stages = [
      ['install', 'pnpm', ['install', '--no-frozen-lockfile'], { CI: 'true' }],
      ['build', 'pnpm', ['run', 'build'], {}],
      ['register', process.execPath, ['register-probe.mjs'], {}],
      ['typecheck', 'pnpm', ['run', 'typecheck'], {}],
      ['test', 'pnpm', ['run', 'test'], {}],
      ['migrate', 'pnpm', ['exec', 'smrt', 'db:migrate'], {}],
      ['status', 'pnpm', ['exec', 'smrt', 'db:status'], {}],
    ];
    for (const [label, command, args, env] of stages) {
      log(`▶ release consumer canary: ${label}`);
      run(command, args, { cwd: app, env, label });
      if (label === 'build' && !existsSync(join(app, '.smrt/register.js'))) {
        throw new Error('build did not generate .smrt/register.js');
      }
    }
    log('✓ release consumer canary: build, register, typecheck, test, migrate, status');
    return app;
  } finally {
    if (!keep) rmSync(app, { recursive: true, force: true });
  }
}

export function parseArgs(argv) {
  const options = { packs: undefined, keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inline] = argv[index].split('=', 2);
    if (flag === '--packs') options.packs = inline ?? argv[++index];
    else if (flag === '--keep') options.keep = true;
    else throw new Error(`unknown argument ${argv[index]}`);
  }
  if (!options.packs) throw new Error('--packs <dir of release tarballs> is required');
  return options;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    mkdirSync(tmpdir(), { recursive: true });
    const app = runReleaseConsumerCanary({
      tarballs: readTarballs(resolve(options.packs)),
      keep: options.keep,
    });
    if (options.keep) console.log(`consumer kept at ${app}`);
  } catch (error) {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
