#!/usr/bin/env node
/** Partition every registered PostgreSQL suite; this never scopes suites away. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverWorkspaces } from './workspaces.mjs';

export const INGESTION = '@happyvertical/smrt-ingestion';
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

export function selectPostgresShard(manifests, shard) {
  if (!['ingestion', 'remaining'].includes(shard)) {
    throw new Error(`Invalid PostgreSQL shard "${shard}"; expected ingestion or remaining`);
  }
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
  const selected = registered.filter((name) => shard === 'ingestion' ? name === INGESTION : name !== INGESTION);
  if (selected.length === 0) throw new Error(`PostgreSQL shard ${shard} is empty; check the suite registry`);
  return { registered, selected };
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
  if (process.argv.length !== 3) throw new Error('Usage: postgres-test-shard.mjs <ingestion|remaining>');
  const shard = process.argv[2];
  const root = fileURLToPath(new URL('../', import.meta.url));
  const { registered, selected } = selectPostgresShard(await readPostgresManifests(root), shard);
  console.error(`PostgreSQL shard ${shard}: ${selected.length} of ${registered.length} registered suite(s)`);
  process.stdout.write(selected.map((name) => `--filter=${name}`).join(' '));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
