#!/usr/bin/env node
/**
 * Partition every registered PostgreSQL suite; it scopes suites away only when
 * the caller passes an explicit affected list (merge groups, #5364).
 *
 * Usage: postgres-test-shard.mjs <ingestion|remaining>[:<i>/<n>]
 *
 * `ingestion` is that one package; `remaining` is every other registered
 * suite. `remaining:<i>/<n>` is one of `n` duration-balanced groups of them.
 * `ingestion:<i>/<n>` is still the one package, with `-- --shard=<i>/<n>`
 * appended so Turbo hands Vitest that slice of its files: the package's files
 * share one database and run one at a time, so only separate jobs, each with
 * its own service, run them side by side (#5045).
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { balanceShards, POSTGRES_TEST_SECONDS } from './test-shard-balance.mjs';
import { discoverWorkspaces } from './workspaces.mjs';

export const INGESTION = '@happyvertical/smrt-ingestion';
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/** Split `<group>[:<i>/<n>]` into its group and optional 1-based slice. */
export function parsePostgresShard(shard) {
  const match = /^(ingestion|remaining)(?::(\d+)\/(\d+))?$/.exec(shard ?? '');
  const index = match?.[2] === undefined ? 1 : Number.parseInt(match[2], 10);
  const count = match?.[3] === undefined ? 1 : Number.parseInt(match[3], 10);
  if (!match || index < 1 || index > count) {
    throw new Error(`Invalid PostgreSQL shard "${shard}"; expected ingestion or remaining, optionally with :<i>/<n>`);
  }
  return { group: match[1], index, count };
}

export function selectPostgresShard(manifests, shard, only) {
  const { group, index, count } = parsePostgresShard(shard);
  if (!Array.isArray(manifests) || manifests.length === 0) {
    throw new Error('PostgreSQL discovery returned no workspace manifests');
  }
  const seen = new Set();
  const registered = [];
  for (const manifest of manifests) {
    if (!manifest || typeof manifest !== 'object' || !packageName.test(manifest.name ?? '') || seen.has(manifest.name)) {
      throw new Error('Invalid or duplicate workspace package name in PostgreSQL registry');
    }
    seen.add(manifest.name);
    if (manifest.scripts !== undefined && (!manifest.scripts || typeof manifest.scripts !== 'object' || Array.isArray(manifest.scripts))) {
      throw new Error(`Malformed scripts in ${manifest.name}`);
    }
    const command = manifest.scripts?.['test:postgres'];
    if (command === undefined) continue;
    if (typeof command !== 'string' || command.trim() === '') {
      throw new Error(`Invalid test:postgres script in ${manifest.name}`);
    }
    registered.push(manifest.name);
  }
  registered.sort();
  if (!registered.includes(INGESTION)) {
    throw new Error(`Required ingestion PostgreSQL suite is missing: ${INGESTION}`);
  }
  const remaining = registered.filter((name) => name !== INGESTION);
  const selected = group === 'ingestion'
    ? [INGESTION]
    : balanceShards(remaining, count, POSTGRES_TEST_SECONDS)[index - 1];
  if (selected.length === 0) throw new Error(`PostgreSQL shard ${shard} is empty; check the suite registry`);
  // Only the one-package ingestion group can hand Vitest a file slice: Turbo
  // passes these arguments to every selected package's script.
  const vitestArgs = group === 'ingestion' && count > 1 ? [`--shard=${index}/${count}`] : [];
  // Merge groups restrict to the affected packages (#5364). Shards are still
  // computed from the whole registry, so the grouping never shifts; a name
  // that is not registered selects nothing rather than widening the run.
  if (only !== undefined) {
    if (!Array.isArray(only) || !only.every((name) => typeof name === 'string')) {
      throw new Error('Affected PostgreSQL package list must be an array of names');
    }
    const affected = new Set(only);
    const restricted = selected.filter((name) => affected.has(name));
    return { registered, selected: restricted, vitestArgs: restricted.length > 0 ? vitestArgs : [] };
  }
  return { registered, selected, vitestArgs };
}

export async function readPostgresManifests(repoRoot) {
  const workspaces = await discoverWorkspaces(repoRoot);
  return await Promise.all(workspaces.map(async (workspace) => {
    const path = resolve(workspace.path, 'package.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    if (manifest.name !== workspace.name) throw new Error(`Workspace identity mismatch: ${path}`);
    return manifest;
  }));
}

async function main() {
  if (process.argv.length !== 3) throw new Error('Usage: postgres-test-shard.mjs <ingestion|remaining>[:<i>/<n>]');
  const shard = process.argv[2];
  const root = fileURLToPath(new URL('../', import.meta.url));
  // POSTGRES_AFFECTED: a JSON array of package names (merge groups), or unset/`all`.
  const affected = process.env.POSTGRES_AFFECTED;
  const only = affected === undefined || affected === '' || affected === 'all' ? undefined : JSON.parse(affected);
  const { registered, selected, vitestArgs } = selectPostgresShard(await readPostgresManifests(root), shard, only);
  console.error(`PostgreSQL shard ${shard}: ${selected.length} of ${registered.length} registered suite(s)`);
  const filters = selected.map((name) => `--filter=${name}`);
  process.stdout.write([...filters, ...(vitestArgs.length > 0 ? ['--', ...vitestArgs] : [])].join(' '));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
