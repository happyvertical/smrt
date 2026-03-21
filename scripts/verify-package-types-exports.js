#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });

  if (result.error) {
    fail(`Failed to run ${command}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    fail(
      `${command} ${args.join(' ')} exited with code ${result.status}${
        stderr ? `\n${stderr}` : ''
      }`,
    );
  }

  return result.stdout;
}

function collectTypePaths(packageJson) {
  const typePaths = new Set();

  if (typeof packageJson.types === 'string') {
    typePaths.add(packageJson.types);
  }

  const visit = (value) => {
    if (!value || typeof value !== 'object') {
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      if (key === 'types' && typeof child === 'string') {
        typePaths.add(child);
        continue;
      }

      visit(child);
    }
  };

  visit(packageJson.exports);

  return [...typePaths].map((filePath) => filePath.replace(/^\.\//, ''));
}

const packageDir = resolve(process.cwd(), process.argv[2] ?? '.');
const packageJsonPath = join(packageDir, 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const typePaths = collectTypePaths(packageJson);

if (typePaths.length === 0) {
  console.log(`ℹ️ No exported type paths declared for ${packageJson.name}`);
  process.exit(0);
}

const tempDir = mkdtempSync(join(tmpdir(), 'smrt-pack-'));

try {
  const packOutput = run(
    'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', tempDir],
    { cwd: packageDir },
  );
  const packResult = JSON.parse(packOutput);
  const tarballName = packResult[0]?.filename;

  if (!tarballName) {
    fail(`npm pack did not return a tarball filename for ${packageJson.name}`);
  }

  const tarballPath = join(tempDir, tarballName);
  const archiveListing = run('tar', ['-tf', tarballPath]);
  const archiveEntries = new Set(
    archiveListing
      .split('\n')
      .map((entry) => entry.trim())
      .filter(Boolean),
  );

  const missing = typePaths.filter(
    (typePath) => !archiveEntries.has(`package/${typePath}`),
  );

  if (missing.length > 0) {
    fail(
      `${packageJson.name} is missing declared type exports in the packed artifact:\n${missing
        .map((typePath) => `- ${typePath}`)
        .join('\n')}`,
    );
  }

  console.log(
    `✅ Verified packed type exports for ${packageJson.name}: ${typePaths.join(', ')}`,
  );
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
