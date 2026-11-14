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
 * Packages in DEDICATED_PACKAGES each run alone on one of the trailing shards
 * (when there are more shards than dedicated packages); everything else
 * round-robins across the remaining leading shards. smrt-template-sveltekit's
 * suite takes ~17 minutes and its SQLite-backed onboarding cases hit
 * SQLITE_PROTOCOL (WAL lock acquisition) when starved by neighbouring heavy
 * packages (#4990), so it gets a runner to itself.
 *
 * Usage: node scripts/test-packages-shard.mjs <i>/<n>   (e.g. "2/4")
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

// Packages that each own one trailing shard. Order assigns shards from the end.
const DEDICATED_PACKAGES = ['@happyvertical/smrt-template-sveltekit'];

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
// Reserve trailing shards only while at least one shared shard remains.
const dedicated = n > DEDICATED_PACKAGES.length ? DEDICATED_PACKAGES : [];
const sharedShards = n - dedicated.length;
const dedicatedIndex = i - 1 - sharedShards;
const shared = names.filter((name) => !dedicated.includes(name));
const shard =
  dedicatedIndex >= 0
    ? names.filter((name) => name === dedicated[dedicatedIndex])
    : shared.filter((_, index) => index % sharedShards === i - 1);

// Empty shard → print nothing; the CI step's `xargs -r` then runs zero packages.
// (A turbo --filter that matches nothing errors out, and a bare `turbo run test`
// with no filter would run EVERY package — both defeat the sharding.)
process.stdout.write(shard.map((name) => `--filter=${name}`).join(' '));
