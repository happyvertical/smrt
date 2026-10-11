import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(
  readFileSync(resolve(root, 'package.json'), 'utf8'),
);
const suppliedTarball =
  process.argv.slice(2).find((argument) => argument !== '--') ??
  process.env.PACKED_TARBALL;

if (!suppliedTarball) {
  console.error(
    'usage: pnpm test:package -- /absolute/path/to/smrt-planner-<version>.tgz',
  );
  process.exit(2);
}

const tarball = resolve(suppliedTarball);
if (!existsSync(tarball)) {
  console.error(`packed package not found: ${tarball}`);
  process.exit(2);
}

const consumer = mkdtempSync(resolve(tmpdir(), 'smrt-planner-consumer-'));

try {
  writeFileSync(
    resolve(consumer, 'package.json'),
    `${JSON.stringify(
      {
        name: 'smrt-planner-packed-consumer',
        private: true,
        type: 'module',
        dependencies: {
          '@happyvertical/smrt-planner': `file:${tarball}`,
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    resolve(consumer, '.npmrc'),
    '@happyvertical:registry=https://npm.happyvertical.com/\n',
  );
  writeFileSync(
    resolve(consumer, 'verify.mjs'),
    `
      import { existsSync } from 'node:fs';
      import { createHeadlessPlanner } from '@happyvertical/smrt-planner/core';
      import { appFile } from '@happyvertical/smrt-planner/app';
      import pkg from '@happyvertical/smrt-planner/package.json' with { type: 'json' };

      if (pkg.name !== '@happyvertical/smrt-planner') throw new Error('wrong package name');
      if (pkg.version !== ${JSON.stringify(packageJson.version)}) throw new Error('wrong package version');
      const planner = createHeadlessPlanner();
      const result = planner.run({ name: 'add_cookbook', input: { id: 'bakery' } });
      if (!result.ok || result.snapshot.recipes.length === 0) throw new Error('headless planner failed');
      if (!existsSync(appFile('index.html'))) throw new Error('packaged app is missing');
      console.log(${JSON.stringify(`${basename(tarball)} consumer verified`)});
    `,
  );

  const env = {
    ...process.env,
    NPM_CONFIG_USERCONFIG: resolve(consumer, '.npmrc'),
  };
  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli) {
    throw new Error('test:package must run through pnpm');
  }
  execFileSync(
    process.execPath,
    [pnpmCli, 'install', '--ignore-scripts', '--no-frozen-lockfile'],
    { cwd: consumer, env, stdio: 'inherit' },
  );
  execFileSync(process.execPath, ['verify.mjs'], {
    cwd: consumer,
    env,
    stdio: 'inherit',
  });
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
