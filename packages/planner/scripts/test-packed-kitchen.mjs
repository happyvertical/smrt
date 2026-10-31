/**
 * Real `smrt kitchen` against a packed planner tarball (#4238).
 *
 * The kitchen extracts the planner tarball into its cache and never installs
 * its dependencies, so the planner's `./core` must load from an extracted
 * package with no `node_modules` anywhere above it. This extracts the tarball
 * into such a directory, imports `./core` with bare Node, then runs this
 * workspace's `smrt kitchen <dir> --no-open --no-install --planner <extracted>`
 * until the kitchen server is listening and serves the planner app.
 *
 * Usage: node scripts/test-packed-kitchen.mjs /abs/smrt-planner-<v>.tgz
 *        (or PACKED_TARBALL=...)
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = resolve(root, '../cli/bin/smrt.js');
const supplied =
  process.argv.slice(2).find((argument) => argument !== '--') ??
  process.env.PACKED_TARBALL;
if (!supplied) {
  console.error('usage: node scripts/test-packed-kitchen.mjs <planner.tgz>');
  process.exit(2);
}
const tarball = resolve(supplied);
if (!existsSync(tarball)) {
  console.error(`packed planner not found: ${tarball}`);
  process.exit(2);
}

// A temporary directory is not isolation when an ancestor has node_modules:
// Node's resolver would find the workspace's packages there.
function hasCleanAncestors(directory) {
  for (let current = resolve(directory); ; current = dirname(current)) {
    if (existsSync(join(current, 'node_modules'))) return false;
    if (dirname(current) === current) return true;
  }
}
const base = [tmpdir(), homedir()].find(hasCleanAncestors);
if (!base) {
  console.error('choose a TMPDIR with no ancestor node_modules directory');
  process.exit(2);
}
const fixture = mkdtempSync(join(base, '.smrt-packed-kitchen-'));

function fail(message) {
  throw new Error(`packed kitchen: ${message}`);
}

try {
  const extracted = join(fixture, 'planner');
  mkdirSync(extracted);
  const untar = spawnSync('tar', ['-xzf', tarball, '-C', extracted], {
    encoding: 'utf8',
  });
  if (untar.status !== 0) fail(`tar failed: ${untar.stderr}`);
  const plannerDir = join(extracted, 'package');
  if (existsSync(join(plannerDir, 'node_modules'))) {
    fail('the extracted tarball unexpectedly carries node_modules');
  }

  // 1. The kitchen's own load step: bare Node, no dependencies installed.
  const coreUrl = pathToFileURL(join(plannerDir, 'dist/core/index.js')).href;
  const load = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const core = await import(${JSON.stringify(coreUrl)});
for (const name of ['parseHostRequest', 'buildHostPrompt', 'parseHostReply'])
  if (typeof core[name] !== 'function') throw new Error('./core lacks ' + name);
console.log('core ok');`,
    ],
    { cwd: fixture, encoding: 'utf8' },
  );
  if (load.status !== 0) {
    fail(`./core does not load without installed dependencies:\n${load.stderr}`);
  }

  // 2. The real command.
  const env = { ...process.env, SMRT_CACHE_DIR: join(fixture, 'cache') };
  for (const key of Object.keys(env)) {
    if (/^(OPENAI|ANTHROPIC|GEMINI|GOOGLE|SMRT_AI)_/.test(key)) delete env[key];
  }
  const child = spawn(
    process.execPath,
    [
      cli,
      'kitchen',
      join(fixture, 'my-app'),
      '--no-open',
      '--no-install',
      '--planner',
      plannerDir,
    ],
    { cwd: fixture, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  const url = await new Promise((accept, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`kitchen did not start:\n${output}`)),
      90_000,
    );
    const onData = (chunk) => {
      output += chunk;
      const match = /Open (http:\/\/\S+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        accept(match[1]);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`kitchen exited (${code}) before listening:\n${output}`));
    });
  });
  try {
    const page = await fetch(new URL(url).origin + '/');
    const html = await page.text();
    if (page.status !== 200 || !html.includes('<html')) {
      fail(`kitchen served ${page.status} for the planner app`);
    }
  } finally {
    child.kill('SIGTERM');
    await new Promise((accept) => {
      if (child.exitCode !== null) accept();
      else child.on('exit', accept);
    });
  }
  console.log(`✓ smrt kitchen runs the packed planner ${tarball}`);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
