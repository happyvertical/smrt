#!/usr/bin/env node
/**
 * Select one deterministic shard of the Turbo test-task closure emitted by
 * `turbo run test --dry=json`. Unlike test-packages-shard.mjs, this starts
 * from the affected closure, so PR validation neither drops dependents nor
 * expands a narrow change to every workspace package.
 *
 * Usage: turbo ... --dry=json | node scripts/affected-test-shard.mjs <i>/<n>
 *
 * The script writes `--filter=<package>` flags to stdout for xargs and a
 * concise package-count observation to stderr for the Actions log.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CORE_PACKAGE = '@happyvertical/smrt-core';

export function parseShard(shardArg) {
  const match = shardArg.match(/^(\d+)\/(\d+)$/);
  const index = match ? Number.parseInt(match[1], 10) : Number.NaN;
  const count = match ? Number.parseInt(match[2], 10) : Number.NaN;
  if (
    !Number.isInteger(index) ||
    !Number.isInteger(count) ||
    index < 1 ||
    count < 1 ||
    index > count
  ) {
    throw new Error(
      `Invalid shard "${shardArg}"; expected "<i>/<n>" (e.g. "2/3")`,
    );
  }
  return { index, count };
}

export function selectAffectedTestPackages(dryRun, { index, count }) {
  if (!Array.isArray(dryRun?.tasks)) {
    throw new Error('Turbo dry-run JSON did not contain a tasks array');
  }

  const packages = [
    ...new Set(
      dryRun.tasks
        .filter((task) => task.task === 'test' && task.package !== CORE_PACKAGE)
        .map((task) => task.package)
        .filter((packageName) => typeof packageName === 'string'),
    ),
  ].sort();

  return {
    packages,
    shard: packages.filter((_, packageIndex) => packageIndex % count === index - 1),
  };
}

export function hasAffectedCoreTest(dryRun) {
  if (!Array.isArray(dryRun?.tasks)) {
    throw new Error('Turbo dry-run JSON did not contain a tasks array');
  }
  return dryRun.tasks.some(
    (task) => task.task === 'test' && task.package === CORE_PACKAGE,
  );
}

function readStdin() {
  return readFileSync(0, 'utf8');
}

function main() {
  const input = JSON.parse(readStdin());
  if (process.argv[2] === '--has-core') {
    process.stdout.write(hasAffectedCoreTest(input) ? 'true' : 'false');
    return;
  }

  const shardArg = process.argv[2] ?? '';
  const shard = parseShard(shardArg);
  const selected = selectAffectedTestPackages(input, shard);
  console.error(
    `Affected test shard ${shardArg}: ${selected.shard.length} of ${selected.packages.length} non-core package(s)`,
  );
  process.stdout.write(
    selected.shard.map((packageName) => `--filter=${packageName}`).join(' '),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
