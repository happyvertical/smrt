#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distEntry = resolve(packageRoot, 'dist/index.js');
const sourceEntry = resolve(packageRoot, 'src/index.ts');

if (existsSync(distEntry)) {
  // Run the built CLI in this process so signals reach long-running commands
  // (a container's SIGTERM to `smrt app worker`), and exit codes are its own.
  await import(pathToFileURL(distEntry).href);
} else {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', sourceEntry, ...process.argv.slice(2)],
    { stdio: 'inherit' },
  );

  if (result.error) {
    throw result.error;
  }

  if (result.signal) {
    process.kill(process.pid, result.signal);
  }

  process.exit(result.status ?? 1);
}
