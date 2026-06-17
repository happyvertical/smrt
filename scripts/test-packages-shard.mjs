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
 * Lists every `packages/<dir>` that has a `test` script, excludes
 * `@happyvertical/smrt-core` (it runs in the separate sharded "Test Core" job),
 * sorts by name for determinism, then round-robins by index into N shards and
 * prints this shard's `--filter=<name>` flags for `turbo run test`.
 *
 * Usage: node scripts/test-packages-shard.mjs <i>/<n>   (e.g. "2/3")
 * Prints nothing for an empty shard (more shards than packages); the CI step
 * pipes the output through `xargs -r`, so an empty shard runs zero packages
 * instead of erroring on an unmatched filter or running everything.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

names.sort();
const shard = names.filter((_, index) => index % n === i - 1);

// Empty shard → print nothing; the CI step's `xargs -r` then runs zero packages.
// (A turbo --filter that matches nothing errors out, and a bare `turbo run test`
// with no filter would run EVERY package — both defeat the sharding.)
process.stdout.write(shard.map((name) => `--filter=${name}`).join(' '));
