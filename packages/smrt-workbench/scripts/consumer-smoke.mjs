import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const packageRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(packageRoot, '..', '..');
const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-workbench-pack-')));
const consumerRoot = join(tempRoot, 'consumer');
const scopeDir = join(consumerRoot, 'node_modules', '@happyvertical');
const installedRoot = join(scopeDir, 'smrt-workbench');

function run(command, args, options = {}) {
  const { env = {}, ...execOptions } = options;
  return execFileSync(command, args, {
    cwd: packageRoot,
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
    env: { ...process.env, ...env },
    ...execOptions,
  });
}

try {
  const packResult = JSON.parse(
    run('npm', [
      'pack',
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      tempRoot,
    ]),
  );
  const tarballName = packResult.at(-1)?.filename;
  assert.equal(typeof tarballName, 'string', 'npm pack did not return a tarball');

  mkdirSync(installedRoot, { recursive: true });
  run(
    'tar',
    [
      '-xzf',
      join(tempRoot, tarballName),
      '--strip-components=1',
      '-C',
      installedRoot,
    ],
    { cwd: tempRoot },
  );

  assert.equal(
    existsSync(join(installedRoot, 'host', 'src', 'routes', '+page.svelte')),
    true,
    'packed artifact omitted the workbench host',
  );
  assert.equal(
    existsSync(join(installedRoot, 'dist', 'index.js')),
    true,
    'packed artifact omitted the workbench runtime',
  );

  symlinkSync(
    join(packageRoot, 'node_modules'),
    join(installedRoot, 'node_modules'),
    'dir',
  );
  symlinkSync(
    join(repoRoot, 'packages', 'content'),
    join(scopeDir, 'smrt-content'),
    'dir',
  );
  writeFileSync(
    join(consumerRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: 'smrt-workbench-consumer-smoke',
        private: true,
        type: 'module',
        dependencies: {
          '@happyvertical/smrt-content': '0.40.24',
          '@happyvertical/smrt-workbench': '0.40.24',
        },
      },
      null,
      2,
    )}\n`,
  );

  const runtime = await import(
    `${pathToFileURL(join(installedRoot, 'dist', 'index.js')).href}?smoke=${Date.now()}`
  );
  const scope = runtime.resolveWorkbenchScope(consumerRoot);
  assert.equal(scope.mode, 'consumer');

  const project = await runtime.buildWorkbenchProject(scope);
  assert.equal(
    project.packages.some(
      (pkg) => pkg.name === '@happyvertical/smrt-content',
    ),
    true,
    'consumer metadata omitted the installed content package',
  );

  const targets = await runtime.discoverWorkbenchTargets(
    consumerRoot,
    'consumer',
  );
  assert.equal(
    targets.some(
      (target) =>
        target.packageName === '@happyvertical/smrt-content' &&
        target.importSpecifier === '@happyvertical/smrt-content/workbench',
    ),
    true,
    'consumer discovery omitted the installed workbench export',
  );

  run('pnpm', ['--dir', join(installedRoot, 'host'), 'build'], {
    cwd: consumerRoot,
    env: {
      CI: '1',
      SMRT_WORKBENCH_CWD: consumerRoot,
      SMRT_WORKBENCH_PROJECT_ROOT: consumerRoot,
    },
    stdio: 'inherit',
  });
  assert.equal(
    existsSync(join(installedRoot, 'host', '.svelte-kit', 'output', 'client')),
    true,
    'packed consumer host did not build',
  );

  console.log('✓ packed workbench consumer host and discovery smoke passed');
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
