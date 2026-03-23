#!/usr/bin/env node

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

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

const removableDirectoryNames = new Set(['__tests__', 'test-stubs']);
const removableFilePattern = /\.(test|spec)\.[^.]+$/;

function prune(entryPath) {
  const stats = statSync(entryPath);

  if (stats.isDirectory()) {
    const name = basename(entryPath);
    if (removableDirectoryNames.has(name)) {
      rmSync(entryPath, { recursive: true, force: true });
      return;
    }

    for (const entry of readdirSync(entryPath)) {
      prune(join(entryPath, entry));
    }
    return;
  }

  if (removableFilePattern.test(entryPath)) {
    rmSync(entryPath, { force: true });
  }
}

prune(rootDir);
