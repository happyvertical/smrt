#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

function readOptionValue(flagName) {
  const args = process.argv.slice(2);
  const index = args.indexOf(flagName);
  if (index === -1 || !args[index + 1] || args[index + 1].startsWith('-')) {
    fail(`Missing ${flagName}`);
  }
  return args[index + 1];
}

function commandFailure(result) {
  return [result.stdout, result.stderr]
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim())
    .join('\n');
}

const packageDir = resolve(readOptionValue('--package-dir'));
const tarballPath = resolve(readOptionValue('--tarball'));
const sourcePackageJson = JSON.parse(
  readFileSync(join(packageDir, 'package.json'), 'utf8'),
);
const packageName = sourcePackageJson.name;
if (packageName !== '@happyvertical/smrt-users') {
  fail(`Expected @happyvertical/smrt-users, received ${packageName}`);
}
if (!existsSync(tarballPath)) fail(`Tarball not found: ${tarballPath}`);

const consumerDir = mkdtempSync(join(tmpdir(), 'smrt-users-oidc-consumer-'));
const cleanup = () => rmSync(consumerDir, { recursive: true, force: true });
process.once('exit', cleanup);

try {
  const installedPackageDir = join(
    consumerDir,
    'node_modules',
    ...packageName.split('/'),
  );
  mkdirSync(installedPackageDir, { recursive: true });
  const extractResult = spawnSync(
    'tar',
    [
      '-xzf',
      tarballPath,
      '--strip-components=1',
      '-C',
      installedPackageDir,
    ],
    { encoding: 'utf8', env: process.env },
  );
  if (extractResult.error || extractResult.status !== 0) {
    fail(
      `Failed to extract ${packageName}: ${extractResult.error?.message ?? commandFailure(extractResult)}`,
    );
  }

  const packedPackageJson = JSON.parse(
    readFileSync(join(installedPackageDir, 'package.json'), 'utf8'),
  );
  const dependencyNames = new Set([
    ...Object.keys(packedPackageJson.dependencies ?? {}),
    ...Object.keys(packedPackageJson.optionalDependencies ?? {}),
    ...Object.keys(packedPackageJson.peerDependencies ?? {}),
  ]);
  for (const dependencyName of dependencyNames) {
    const sourceDependencyDir = join(
      packageDir,
      'node_modules',
      ...dependencyName.split('/'),
    );
    if (!existsSync(sourceDependencyDir)) {
      fail(`Workspace dependency unavailable: ${dependencyName}`);
    }
    const consumerDependencyDir = join(
      consumerDir,
      'node_modules',
      ...dependencyName.split('/'),
    );
    mkdirSync(resolve(consumerDependencyDir, '..'), { recursive: true });
    symlinkSync(realpathSync(sourceDependencyDir), consumerDependencyDir, 'dir');
  }

  writeFileSync(
    join(consumerDir, 'package.json'),
    `${JSON.stringify({ name: 'smrt-users-oidc-consumer', private: true, type: 'module' }, null, 2)}\n`,
  );
  writeFileSync(
    join(consumerDir, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'Bundler',
          noEmit: true,
          skipLibCheck: true,
          strict: true,
          target: 'ES2022',
        },
        include: ['consumer.ts'],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(consumerDir, 'consumer.ts'),
    `import type {
  GetOrCreateFromOidcOptions,
  OidcLoginServiceOptions,
  OidcProfileOwnerAuthorization,
  OidcProfileOwnerAuthorizer,
  OidcProfileOwnerAuthorizerContext,
} from '@happyvertical/smrt-users';
import type {
  OidcProfileOwnerAuthorizer as SvelteKitOwnerAuthorizer,
  OidcProfileOwnerAuthorizerContext as SvelteKitOwnerContext,
  OidcSvelteKitOptions,
} from '@happyvertical/smrt-users/sveltekit';

declare function selectApprovedOwner(
  context: OidcProfileOwnerAuthorizerContext,
): Promise<OidcProfileOwnerAuthorization | undefined>;

const authorizeProfileOwner: OidcProfileOwnerAuthorizer = (context) =>
  selectApprovedOwner(context);
const collectionOptions: GetOrCreateFromOidcOptions = {
  authorizeProfileOwner,
};
const serviceOptions = {
  authorizeProfileOwner,
} satisfies Pick<OidcLoginServiceOptions, 'authorizeProfileOwner'>;
const svelteKitOptions = {
  authorizeProfileOwner,
} satisfies Pick<OidcSvelteKitOptions, 'authorizeProfileOwner'>;

const compatibleAuthorizer: SvelteKitOwnerAuthorizer = authorizeProfileOwner;
const sameContext = (context: SvelteKitOwnerContext) => context;
void [collectionOptions, serviceOptions, svelteKitOptions, compatibleAuthorizer, sameContext];
`,
  );

  const tscPath = join(packageDir, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tscPath)) fail(`TypeScript compiler unavailable: ${tscPath}`);
  const typecheckResult = spawnSync(process.execPath, [tscPath, '-p', '.'], {
    cwd: consumerDir,
    encoding: 'utf8',
    env: process.env,
  });
  if (typecheckResult.error || typecheckResult.status !== 0) {
    fail(
      `Packed OIDC owner-authorization API failed consumer typecheck:\n${typecheckResult.error?.message ?? commandFailure(typecheckResult)}`,
    );
  }

  console.log('✅ Verified packed OIDC owner-authorization consumer API');
} finally {
  process.removeListener('exit', cleanup);
  cleanup();
}
