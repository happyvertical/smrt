#!/usr/bin/env node
/**
 * Partition the workspace's testable packages across CI shards for the
 * "Test Packages" job (Sweep: stabilize the shared cross-package test job).
 *
 * The Test Packages job used to run every non-core package's tests in ONE turbo
 * task on a single runner; the sustained resource pressure surfaced rare,
 * environment-specific timing flakes (a different package failing each run).
 * Splitting the packages across N matrix shards keeps each runner's load low.
 *
 * Lists every `packages/<dir>` that has a `test` script and excludes
 * `@happyvertical/smrt-core` (it runs in the separate sharded "Test Core" job).
 * `selectShard` in test-shard-balance.mjs then gives each dedicated package a
 * trailing shard of its own and balances the rest over the leading shards by
 * measured duration. A package in SPLIT_TEST_UNITS (app-shell) is balanced as
 * its separate unit tasks. This prints the shard's `<package>#<task>` unit ids
 * for `turbo run` (#5647).
 *
 * Usage: node scripts/test-packages-shard.mjs <i>/<n>   (e.g. "2/4")
 * Prints nothing for an empty shard (more shards than packages); the CI step
 * pipes the output through `xargs -r`, so an empty shard runs zero packages
 * instead of erroring on an unmatched filter or running everything.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expandTestUnits,
  selectShard,
  TEST_SECONDS,
} from './test-shard-balance.mjs';

const shardArg = process.argv[2] ?? '';
// Require exactly "<i>/<n>" — reject empties, extra segments ("1/3/4"), etc.
const match = shardArg.match(/^(\d+)\/(\d+)$/);
const i = match ? Number.parseInt(match[1], 10) : Number.NaN;
const n = match ? Number.parseInt(match[2], 10) : Number.NaN;
if (!Number.isInteger(i) || !Number.isInteger(n) || i < 1 || n < 1 || i > n) {
  console.error(`Invalid shard "${shardArg}"; expected "<i>/<n>" (e.g. "2/3")`);
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = join(root, 'packages');

const names = [];
for (const dir of readdirSync(packagesDir)) {
  const manifestPath = join(packagesDir, dir, 'package.json');
  if (!existsSync(manifestPath)) continue;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    continue;
  }
  if (!manifest.name || !manifest.scripts?.test) continue;
  // Core has its own sharded "Test Core" job.
  if (manifest.name === '@happyvertical/smrt-core') continue;
  names.push(manifest.name);
}

const shard = selectShard(
  expandTestUnits(names),
  { index: i, count: n },
  TEST_SECONDS,
);

// Empty shard → print nothing; the CI step's `xargs -r` then runs zero packages.
// (A bare `turbo run test` with no filter would run EVERY package, which
// defeats the sharding.)
process.stdout.write(shard.join(' '));
