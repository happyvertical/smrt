#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distEntry = resolve(packageRoot, 'dist/prebuild/cli.js');
const sourceEntry = resolve(packageRoot, 'src/prebuild/cli.ts');

const command = existsSync(distEntry)
  ? [distEntry, ...process.argv.slice(2)]
  : ['--import', 'tsx', sourceEntry, ...process.argv.slice(2)];

const result = spawnSync(process.execPath, command, { stdio: 'inherit' });

if (result.error) {
  throw result.error;
}

if (result.signal) {
  process.kill(process.pid, result.signal);
}

process.exit(result.status ?? 1);
