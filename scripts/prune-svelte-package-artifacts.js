#!/usr/bin/env node

import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { isTestArtifact } from './package-test-artifacts.mjs';

const targetDir = process.argv[2];

if (!targetDir) {
  console.error(
    'Usage: node prune-svelte-package-artifacts.js <dist-svelte-dir>',
  );
  process.exit(1);
}

const rootDir = resolve(process.cwd(), targetDir);

if (!existsSync(rootDir)) {
  process.exit(0);
}

function prune(entryPath) {
  const stats = lstatSync(entryPath);

  if (stats.isDirectory()) {
    if (isTestArtifact(relative(rootDir, entryPath))) {
      rmSync(entryPath, { recursive: true, force: true });
      return;
    }

    for (const entry of readdirSync(entryPath)) {
      prune(join(entryPath, entry));
    }
    return;
  }

  if (isTestArtifact(relative(rootDir, entryPath))) {
    rmSync(entryPath, { force: true });
  }
}

prune(rootDir);
